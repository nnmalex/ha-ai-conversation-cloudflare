import { Agent } from "agents";
import { generateText, stepCountIs } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { ChatRequest, ChatResponse } from "./types";
import { buildSystemPrompt } from "./system-prompt";

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

const MCP_REFRESH_PATTERN =
  /\b(update mcp|mcp discovery|update config|refresh tools|rediscover)\b/i;

export class HomeAssistantAgent extends Agent<Env> {
  private mcpRegistered = false;

  async onStart(): Promise<void> {
    // Schedule periodic MCP tool refresh if not already scheduled
    const existing = this.getSchedules({ type: "cron" });
    const hasRefresh = existing.some((s) => s.callback === "refreshMcp");
    if (!hasRefresh) {
      await this.schedule("*/5 * * * *", "refreshMcp");
    }

    // If restoreConnectionsFromStorage (called by SDK before onStart)
    // restored our server, mark it as registered
    const { servers } = this.getMcpServers();
    const haServer = Object.values(servers).find(
      (s) => s.name === "home-assistant"
    );
    if (haServer) {
      this.mcpRegistered = true;
      console.log(`[onStart] MCP server restored, state=${haServer.state}`);
    }
  }

  async refreshMcp(): Promise<void> {
    const { servers } = this.getMcpServers();
    for (const [id, server] of Object.entries(servers)) {
      if (server.state === "ready" || server.state === "connected") {
        await this.mcp.discoverIfConnected(id);
      }
    }
  }

  /**
   * Register the MCP server if not yet registered.
   * This only registers — it does NOT block waiting for connection/discovery.
   * The SDK connects in the background; tools become available when ready.
   */
  private async ensureMcpRegistered(request: Request): Promise<void> {
    if (this.mcpRegistered) return;

    const { servers } = this.getMcpServers();
    const haServer = Object.values(servers).find(
      (s) => s.name === "home-assistant"
    );
    if (haServer) {
      this.mcpRegistered = true;
      return;
    }

    // First-ever setup — needs request context for callbackHost
    const callbackHost = new URL(request.url).origin;
    console.log(`[ensureMcp] First-time MCP registration, callbackHost=${callbackHost}`);
    await this.addMcpServer("home-assistant", this.env.HA_MCP_URL, {
      callbackHost,
      transport: {
        type: "streamable-http",
        headers: {
          Authorization: `Bearer ${this.env.HA_ACCESS_TOKEN}`,
        },
      },
    });
    this.mcpRegistered = true;
  }

  async onRequest(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);

      // Debug endpoint to check MCP status
      if (request.method === "GET" && url.pathname.endsWith("/debug")) {
        const tools = this.mcpRegistered ? this.mcp.getAITools() : [];
        const { servers } = this.getMcpServers();
        return Response.json({
          mcpRegistered: this.mcpRegistered,
          toolCount: tools.length,
          toolNames: tools.map((t: { name: string }) => t.name),
          servers: Object.entries(servers).map(([id, s]) => ({
            id,
            name: s.name,
            state: s.state,
          })),
        });
      }

      if (request.method !== "POST") {
        return Response.json({ error: "Method not allowed" }, { status: 405 });
      }

      await this.ensureMcpRegistered(request);

      const body = (await request.json()) as ChatRequest;
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
    } catch (err) {
      console.error("Agent request error:", err);
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

    const messages: Message[] = [
      ...history,
      { role: "user", content: request.text },
    ];

    const workersai = createWorkersAI({ binding: this.env.AI });
    let responseText: string;

    try {
      const tools = this.mcp.getAITools();
      console.log(`[chat] ${tools.length} tools available, conversation=${request.conversation_id}`);

      if (tools.length === 0) {
        // Tools not yet discovered — respond honestly instead of hallucinating
        responseText =
          "I'm still connecting to Home Assistant. Please try again in a moment.";
      } else {
        const result = await generateText({
          model: workersai(this.env.AI_MODEL),
          system: systemPrompt,
          messages,
          tools,
          stopWhen: stepCountIs(10),
        });
        console.log(`[chat] steps=${result.steps.length}, toolCalls=${result.steps.reduce((n, s) => n + (s.toolCalls?.length || 0), 0)}`);
        responseText = result.text;
      }
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
    }

    this.saveMessage(request.conversation_id, "user", request.text);
    this.saveMessage(request.conversation_id, "assistant", responseText);
    this.pruneHistory(request.conversation_id);

    return { response: responseText, conversation_id: request.conversation_id };
  }

  private ensureSchema(): void {
    this.sql`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_messages_conv
      ON messages(conversation_id, created_at)`;
  }

  private loadHistory(conversationId: string): Message[] {
    const rows = [
      ...this.sql`SELECT role, content FROM messages
        WHERE conversation_id = ${conversationId}
        ORDER BY created_at ASC
        LIMIT 100`,
    ];
    return rows.map((r) => ({
      role: r.role as Message["role"],
      content: r.content as string,
    }));
  }

  private saveMessage(
    conversationId: string,
    role: string,
    content: string
  ): void {
    this.sql`INSERT INTO messages (conversation_id, role, content)
      VALUES (${conversationId}, ${role}, ${content})`;
  }

  private pruneHistory(conversationId: string): void {
    this.sql`DELETE FROM messages
      WHERE conversation_id = ${conversationId}
        AND id NOT IN (
          SELECT id FROM messages
          WHERE conversation_id = ${conversationId}
          ORDER BY created_at DESC
          LIMIT 100
        )`;
  }
}
