import { Agent } from "agents";
import { generateText, stepCountIs, type CoreMessage } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { ChatRequest, ChatResponse } from "./types";
import { buildSystemPrompt } from "./system-prompt";

const MAX_HISTORY_MESSAGES = 20; // ~5 exchanges with tool calls

const MCP_REFRESH_PATTERN =
  /\b(update mcp|mcp discovery|update config|refresh tools|rediscover)\b/i;

export class HomeAssistantAgent extends Agent<Env> {
  async onStart(): Promise<void> {
    // Schedule periodic MCP tool refresh
    const existing = this.getSchedules({ type: "cron" });
    if (!existing.some((s) => s.callback === "refreshMcp")) {
      await this.schedule("*/5 * * * *", "refreshMcp");
    }

    // If SDK restored our MCP server from storage, eagerly discover tools
    // so they're ready before the first request arrives
    const entry = this.findHaServer();
    if (entry) {
      const [id, server] = entry;
      console.log(`[onStart] MCP server restored, state=${server.state}`);
      if (server.state === "ready" || server.state === "connected") {
        try {
          await this.mcp.discoverIfConnected(id);
          console.log(`[onStart] Tool discovery complete, ${this.getToolCount()} tools`);
        } catch (e) {
          console.error("[onStart] Tool discovery failed:", e);
        }
      }
    }
  }

  async refreshMcp(): Promise<void> {
    const entry = this.findHaServer();
    if (entry) {
      const [id, server] = entry;
      if (server.state === "ready" || server.state === "connected") {
        await this.mcp.discoverIfConnected(id);
        console.log(`[refreshMcp] ${this.getToolCount()} tools`);
      }
    }
  }

  /**
   * Ensure the MCP server is registered, connected, and tools are discovered.
   * Blocks until tools are available (with timeout). This is intentional:
   * a 2-3s wait that works is better UX than an instant "still connecting".
   */
  private async ensureMcpWithTools(request: Request): Promise<void> {
    // If tools are already available, return immediately
    if (this.getToolCount() > 0) return;

    // Check if server is registered but needs discovery
    let entry = this.findHaServer();
    if (entry) {
      const [id, server] = entry;
      if (server.state === "ready" || server.state === "connected") {
        await this.mcp.discoverIfConnected(id);
        if (this.getToolCount() > 0) return;
      }
    }

    // Server not registered yet — first-ever setup
    if (!entry) {
      const callbackHost = new URL(request.url).origin;
      console.log(`[ensureMcp] First-time registration, callbackHost=${callbackHost}`);
      await this.addMcpServer("home-assistant", this.env.HA_MCP_URL, {
        callbackHost,
        transport: {
          type: "streamable-http",
          headers: {
            Authorization: `Bearer ${this.env.HA_ACCESS_TOKEN}`,
          },
        },
      });
    }

    // Wait for tools to become available (poll with timeout)
    const deadline = Date.now() + 15_000;
    while (this.getToolCount() === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      // Try discovery on each iteration if server is ready
      entry = this.findHaServer();
      if (entry) {
        const [id, server] = entry;
        if (server.state === "ready" || server.state === "connected") {
          try { await this.mcp.discoverIfConnected(id); } catch {}
        }
      }
    }
    console.log(`[ensureMcp] Ready with ${this.getToolCount()} tools`);
  }

  private findHaServer(): [string, { name: string; state: string }] | undefined {
    const { servers } = this.getMcpServers();
    return Object.entries(servers).find(
      ([, s]) => s.name === "home-assistant"
    ) as [string, { name: string; state: string }] | undefined;
  }

  private getToolsSafe(): Record<string, unknown> {
    try {
      const result = this.mcp.getAITools();
      if (typeof result === "object" && result && !Array.isArray(result)) {
        return result as Record<string, unknown>;
      }
    } catch {}
    return {};
  }

  private getToolCount(): number {
    return Object.keys(this.getToolsSafe()).length;
  }

  getMcpStatus() {
    const toolNames = Object.keys(this.getToolsSafe());
    const entry = this.findHaServer();
    return {
      toolCount: toolNames.length,
      toolNames,
      server: entry
        ? { id: entry[0], name: entry[1].name, state: entry[1].state }
        : null,
    };
  }

  async onRequest(request: Request): Promise<Response> {
    try {
      if (request.method !== "POST") {
        return Response.json({ error: "Method not allowed" }, { status: 405 });
      }

      await this.ensureMcpWithTools(request);

      const body = (await request.json()) as ChatRequest;

      if (body.text === "__debug__") {
        return Response.json(this.getMcpStatus());
      }

      if (!body.text) {
        return Response.json(
          { response: "Sorry, I didn't receive any text." },
          { status: 400 }
        );
      }

      // On-demand MCP refresh
      if (MCP_REFRESH_PATTERN.test(body.text)) {
        await this.refreshMcp();
        return Response.json({
          response: "I've refreshed my tool list from Home Assistant.",
          conversation_id: body.conversation_id,
        });
      }

      const response = await this.chat(body);
      return Response.json(response);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
      console.error("Agent request error:", errMsg);
      return Response.json(
        {
          response:
            "Sorry, I'm having trouble thinking right now. Please try again.",
          conversation_id: "",
        },
        { status: 500 }
      );
    }
  }

  private async chat(request: ChatRequest): Promise<ChatResponse> {
    this.ensureSchema();
    const history = this.loadHistory(request.conversation_id);
    const systemPrompt = buildSystemPrompt(request);

    const userMessage: CoreMessage = { role: "user", content: request.text };
    const messages: CoreMessage[] = [...history, userMessage];

    const workersai = createWorkersAI({ binding: this.env.AI });
    let responseText: string;
    let responseMessages: CoreMessage[] = [];

    try {
      const tools = this.getToolsSafe();
      const toolCount = Object.keys(tools).length;
      console.log(`[chat] ${toolCount} tools, history=${history.length} msgs, conversation=${request.conversation_id}`);

      const result = await generateText({
        model: workersai(this.env.AI_MODEL),
        system: systemPrompt,
        messages,
        ...(toolCount > 0 ? { tools, stopWhen: stepCountIs(10) } : {}),
      });
      console.log(`[chat] steps=${result.steps.length}, toolCalls=${result.steps.reduce((n, s) => n + (s.toolCalls?.length || 0), 0)}`);
      responseText = result.text;
      // Store full response chain including tool-call and tool-result messages
      responseMessages = result.response.messages as CoreMessage[];
    } catch (err) {
      console.error("AI generation error:", err);

      const errorMsg = String(err);
      if (errorMsg.includes("MCP") || errorMsg.includes("mcp")) {
        responseText =
          "Sorry, I can't reach Home Assistant right now.";
      } else {
        responseText =
          "Sorry, I'm having trouble thinking right now. Please try again.";
      }
      responseMessages = [{ role: "assistant", content: responseText }];
    }

    // Save full message chain — includes tool calls so the AI knows
    // previous responses involved tool usage, not just text
    const allMessages = [...history, userMessage, ...responseMessages];
    this.saveHistory(
      request.conversation_id,
      allMessages.slice(-MAX_HISTORY_MESSAGES)
    );

    return { response: responseText, conversation_id: request.conversation_id };
  }

  private ensureSchema(): void {
    this.sql`CREATE TABLE IF NOT EXISTS conversations (
      conversation_id TEXT PRIMARY KEY,
      messages_json TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch())
    )`;
  }

  private loadHistory(conversationId: string): CoreMessage[] {
    const rows = [
      ...this.sql`SELECT messages_json FROM conversations
        WHERE conversation_id = ${conversationId}`,
    ];
    if (rows.length === 0) return [];
    try {
      return JSON.parse(rows[0].messages_json as string);
    } catch {
      return [];
    }
  }

  private saveHistory(conversationId: string, messages: CoreMessage[]): void {
    this.sql`INSERT OR REPLACE INTO conversations (conversation_id, messages_json, updated_at)
      VALUES (${conversationId}, ${JSON.stringify(messages)}, unixepoch())`;
  }
}
