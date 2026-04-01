import { Agent } from "agents";
import { generateText, stepCountIs, tool, type CoreMessage } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import type { ChatRequest, ChatResponse } from "./types";
import { buildSystemPrompt } from "./system-prompt";

const DEFAULT_HISTORY_TURNS = 2;

const QUESTION_PATTERN =
  /^\s*(what|where|when|who|which|how|why|is|are|can|could|would|will|does|do|did)\b|\?/i;

function isQuestion(text: string): boolean {
  return QUESTION_PATTERN.test(text) || text.trimEnd().endsWith("?");
}

function countUserTurns(messages: CoreMessage[]): number {
  return messages.filter((m) => m.role === "user").length;
}

/** Keep the last `maxTurns` user-initiated turns (plus all messages between them). */
function trimToTurns(messages: CoreMessage[], maxTurns: number): CoreMessage[] {
  const userIndices = messages.reduce<number[]>((acc, msg, i) => {
    if (msg.role === "user") acc.push(i);
    return acc;
  }, []);
  if (userIndices.length <= maxTurns) return messages;
  return messages.slice(userIndices[userIndices.length - maxTurns]);
}

const MCP_REFRESH_PATTERN =
  /\b(update mcp|mcp discovery|update config|refresh tools|rediscover)\b/i;

const RESET_CONTEXT_PATTERN =
  /\b(reset context|clear context|clear history|reset history|start fresh|forget everything)\b/i;

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
    await this.discoverHaConfig();
    // Safety net: process any expired timers that the scheduled callback missed
    try {
      await this.handleTimerExpiry();
    } catch (e) {
      console.warn("[refreshMcp] handleTimerExpiry safety net failed:", e);
    }
  }

  private async discoverHaConfig(): Promise<void> {
    try {
      const base = new URL(this.env.HA_MCP_URL).origin;
      const headers = { Authorization: `Bearer ${this.env.HA_ACCESS_TOKEN}` };
      this.ensureSchema();

      // Discover TTS engine from default Assist pipeline
      const pipelineRes = await fetch(`${base}/api/assist_pipeline/pipeline`, { headers });
      if (pipelineRes.ok) {
        const data = (await pipelineRes.json()) as { pipelines?: Array<{ preferred?: boolean; tts_engine?: string }> };
        const pipelines = data.pipelines ?? (Array.isArray(data) ? (data as Array<{ preferred?: boolean; tts_engine?: string }>) : []);
        const preferred = pipelines.find((p) => p.preferred) ?? pipelines[0];
        if (preferred?.tts_engine) {
          this.sql`INSERT OR REPLACE INTO config (key, value) VALUES ('tts_engine', ${preferred.tts_engine})`;
          console.log(`[discoverHaConfig] tts_engine=${preferred.tts_engine}`);
        }
      }

      // Discover timer slots: any timer.X entity that has a matching input_text.timer_name_X entity
      const statesRes = await fetch(`${base}/api/states`, { headers });
      if (statesRes.ok) {
        const states = (await statesRes.json()) as Array<{ entity_id: string }>;
        const entityIds = new Set(states.map((s) => s.entity_id));
        const timerSlots = states
          .map((s) => s.entity_id)
          .filter((id) => id.startsWith("timer."))
          .filter((id) => entityIds.has(id.replace("timer.", "input_text.timer_name_")));
        const value = timerSlots.join(",");
        this.sql`INSERT OR REPLACE INTO config (key, value) VALUES ('timer_slots', ${value})`;
        console.log(`[discoverHaConfig] timer_slots=${value || "(none)"}`);
      }
    } catch (e) {
      console.warn("[discoverHaConfig] skipped:", e);
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

      // On-demand context reset
      if (RESET_CONTEXT_PATTERN.test(body.text)) {
        this.clearHistory(body.conversation_id);
        return Response.json({
          response: "Done, I've cleared our conversation history. What can I help you with?",
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

  private async callHaService(domain: string, service: string, data: object): Promise<void> {
    const base = new URL(this.env.HA_MCP_URL).origin;
    const url = `${base}/api/services/${domain}/${service}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.env.HA_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.error(`[callHaService] ${domain}.${service} failed: ${resp.status} ${body}`);
      throw new Error(`HA service ${domain}.${service} returned ${resp.status}`);
    }
  }

  private async scheduleNextAlarm(): Promise<void> {
    // Cancel any existing timer-expiry schedule
    const existing = this.getSchedules({ type: "scheduled" });
    for (const s of existing) {
      if (s.callback === "handleTimerExpiry") {
        this.cancelSchedule(s.id);
      }
    }

    const rows = [...this.sql`SELECT MIN(fire_at) as t FROM timers`];
    const t = rows[0]?.t as number | null;
    if (t) {
      const when = new Date(t * 1000);
      await this.schedule(when, "handleTimerExpiry");
      console.log(`[scheduleNextAlarm] scheduled for ${when.toISOString()}`);
    }
  }

  async handleTimerExpiry(): Promise<void> {
    this.ensureSchema();
    const now = Math.floor(Date.now() / 1000);
    const expired = [...this.sql`SELECT * FROM timers WHERE fire_at <= ${now}`] as Array<{
      id: string;
      slot_entity_id: string;
      name: string;
      satellite_id: string | null;
    }>;
    console.log(`[handleTimerExpiry] ${expired.length} expired timer(s)`);

    for (const timer of expired) {
      this.sql`DELETE FROM timers WHERE id = ${timer.id}`;
      const message = `${timer.name} is done!`;
      console.log(`[handleTimerExpiry] "${message}" -> ${timer.satellite_id ?? "(no satellite)"}`);

      if (timer.satellite_id) {
        try {
          await this.callHaService("assist_satellite", "announce", {
            entity_id: timer.satellite_id,
            message,
          });
        } catch (e) {
          console.warn(`[handleTimerExpiry] announce failed, trying tts: ${e}`);
          const rows = [...this.sql`SELECT value FROM config WHERE key = 'tts_engine'`] as Array<{ value: string }>;
          if (rows.length > 0) {
            try {
              await this.callHaService("tts", "speak", {
                entity_id: rows[0].value,
                media_player_entity_id: timer.satellite_id,
                message,
              });
            } catch (e2) {
              console.error(`[handleTimerExpiry] tts also failed: ${e2}`);
            }
          }
        }
      }
    }

    await this.scheduleNextAlarm();
  }

  private getTimerTools(satelliteId: string | undefined, timerSlots: string, userText: string): Record<string, unknown> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const agent = this;

    const WORD_NUMS: Record<string, number> = {
      zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
      eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
      fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
      nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
      half: 0.5, a: 1, an: 1,
    };

    function wordsToDigits(s: string): string {
      // "twenty-five" / "twenty five" -> 25
      s = s.replace(
        /\b(twenty|thirty|forty|fifty)[-\s]+(one|two|three|four|five|six|seven|eight|nine)\b/gi,
        (_, tens, ones) => String((WORD_NUMS[tens.toLowerCase()] ?? 0) + (WORD_NUMS[ones.toLowerCase()] ?? 0)),
      );
      // single word numbers: "five minutes" -> "5 minutes"
      s = s.replace(
        /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty)\b/gi,
        (w) => String(WORD_NUMS[w.toLowerCase()] ?? w),
      );
      // "half an hour" -> "0.5 hours", "half a minute" -> "0.5 minutes"
      s = s.replace(/\bhalf\s+(?:an?\s+)?(hour|minute|second)/gi, "0.5 $1");
      // "a minute" / "an hour" as standalone duration
      s = s.replace(/\b(?:a|an)\s+(hour|minute|second)/gi, "1 $1");
      return s;
    }

    function parseDurationSeconds(input: string | number): number | null {
      const raw = String(input).toLowerCase().trim();
      if (!raw || raw === "undefined" || raw === "null") return null;
      const s = wordsToDigits(raw);
      let total = 0;
      const hourMatch = s.match(/(\d+(?:\.\d+)?)\s*h(?:our)?s?/);
      const minMatch = s.match(/(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?(?!\s*s)/);
      const secMatch = s.match(/(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?/);
      if (hourMatch) total += parseFloat(hourMatch[1]) * 3600;
      if (minMatch) total += parseFloat(minMatch[1]) * 60;
      if (secMatch) total += parseFloat(secMatch[1]);
      if (total === 0 && /^\d+$/.test(s)) total = parseInt(s, 10) * 60; // bare number = minutes
      return total > 0 ? Math.round(total) : null;
    }

    function formatHHMMSS(secs: number): string {
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      const s = secs % 60;
      return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
    }

    function formatDurationName(secs: number): string {
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      const s = secs % 60;
      const parts: string[] = [];
      if (h) parts.push(`${h} hour`);
      if (m) parts.push(`${m} minute`);
      if (s && !h) parts.push(`${s} second`);
      return `${parts.join(" ")} timer`;
    }

    /** Extract a timer name from user text like "set a pasta timer for 5 minutes" -> "pasta" */
    function extractTimerName(text: string): string | null {
      const s = wordsToDigits(text.toLowerCase().trim());
      // "set a <name> timer" or "set <name> timer" — article is optional
      const match = s.match(/\bset\s+(?:(?:a|an|the)\s+)?(.+?)\s+timer\b/);
      if (!match) return null;
      // Remove duration words from the captured name
      const name = match[1]
        .replace(/\d+(?:\.\d+)?[\s-]*(hour|minute|second|min|sec|hr)s?\b/gi, "")
        .replace(/\b(for|of|to)\b/g, "")
        .trim();
      return name || null;
    }

    function formatRemaining(secs: number): string {
      if (secs <= 0) return "done";
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      const s = secs % 60;
      if (h) return `${h}h ${m}m`;
      if (m) return `${m}m ${s}s`;
      return `${s}s`;
    }

    return {
      set_timer: tool({
        description: "Set a countdown timer. Use a short descriptive name if the user provided one.",
        parameters: z.object({
          name: z.string().optional().describe("Optional short name, e.g. 'pasta', 'eggs'. Omit if user gave none."),
          duration: z.coerce.string().describe("Duration string, e.g. '5 minutes', '1 hour 30 minutes', '90 seconds'"),
        }),
        execute: async ({ name, duration }) => {
          // Prefer parsing from the original user text (ground truth) since the model
          // often strips units (e.g. sends "5" instead of "5 minutes")
          const durationSecs = parseDurationSeconds(userText) ?? parseDurationSeconds(duration);
          if (!durationSecs) return `Couldn't understand the duration. Please say something like "set a 5 minute timer".`;

          const timerName = name?.trim() || extractTimerName(userText) || formatDurationName(durationSecs);
          const slots = timerSlots.split(",").map((s) => s.trim()).filter(Boolean);

          // Find a free slot by checking actual HA timer state (source of truth).
          // This avoids stale SQLite records blocking slots.
          const base = new URL(agent.env.HA_MCP_URL).origin;
          const statesResp = await fetch(`${base}/api/states`, {
            headers: { Authorization: `Bearer ${agent.env.HA_ACCESS_TOKEN}` },
          });
          const busySlots = new Set<string>();
          if (statesResp.ok) {
            const states = (await statesResp.json()) as Array<{ entity_id: string; state: string }>;
            for (const s of states) {
              if (s.entity_id.startsWith("timer.") && s.state !== "idle") {
                busySlots.add(s.entity_id);
              }
            }
          }
          // Also clean up stale SQLite records for slots that are idle in HA
          for (const slot of slots) {
            if (!busySlots.has(slot)) {
              agent.sql`DELETE FROM timers WHERE slot_entity_id = ${slot}`;
            }
          }

          const freeSlot = slots.find((s) => !busySlots.has(s));
          if (!freeSlot) return "All timer slots are busy — try cancelling one first.";

          const nameHelper = freeSlot.replace("timer.", "input_text.timer_name_");
          const fireAt = Math.floor(Date.now() / 1000) + durationSecs;

          await agent.callHaService("input_text", "set_value", { entity_id: nameHelper, value: timerName });
          await agent.callHaService("timer", "start", { entity_id: freeSlot, duration: formatHHMMSS(durationSecs) });

          agent.sql`INSERT OR REPLACE INTO timers (id, slot_entity_id, name, satellite_id, fire_at)
            VALUES (${crypto.randomUUID()}, ${freeSlot}, ${timerName}, ${satelliteId ?? null}, ${fireAt})`;
          await agent.scheduleNextAlarm();

          const isNamed = name?.trim() || extractTimerName(userText);
          return isNamed ? `${timerName.charAt(0).toUpperCase() + timerName.slice(1)} timer set.` : "Set.";
        },
      }),

      cancel_timer: tool({
        description: "Cancel an active timer by name.",
        parameters: z.object({
          name: z.string().describe("Name of the timer to cancel, e.g. 'pasta'"),
        }),
        execute: async ({ name }) => {
          const rows = [...agent.sql`SELECT * FROM timers WHERE lower(name) LIKE ${"%" + name.toLowerCase() + "%"}`] as Array<{
            id: string;
            slot_entity_id: string;
            name: string;
          }>;
          if (rows.length === 0) return `No timer matching "${name}" found.`;
          const row = rows[0];
          await agent.callHaService("timer", "cancel", { entity_id: row.slot_entity_id });
          agent.sql`DELETE FROM timers WHERE id = ${row.id}`;
          await agent.scheduleNextAlarm();
          return "Cancelled.";
        },
      }),

      list_timers: tool({
        description: "List all active timers and their remaining time.",
        parameters: z.object({}),
        execute: async () => {
          const rows = [...agent.sql`SELECT * FROM timers ORDER BY fire_at ASC`] as Array<{
            name: string;
            fire_at: number;
          }>;
          if (rows.length === 0) return "No active timers.";
          const now = Math.floor(Date.now() / 1000);
          return rows.map((r) => `${r.name}: ${formatRemaining(r.fire_at - now)}`).join(", ");
        },
      }),
    };
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
      const mcpTools = this.getToolsSafe();
      const timerSlotsRow = [...this.sql`SELECT value FROM config WHERE key = 'timer_slots'`][0] as { value: string } | undefined;
      const timerTools = timerSlotsRow?.value
        ? this.getTimerTools(request.context?.satellite_id, timerSlotsRow.value, request.text)
        : {};
      const tools = { ...mcpTools, ...timerTools };
      const toolCount = Object.keys(tools).length;
      console.log(`[chat] ${toolCount} tools (${Object.keys(timerTools).length} timer), history=${history.length} msgs, conversation=${request.conversation_id}`);

      const result = await generateText({
        model: workersai(this.env.AI_MODEL),
        system: systemPrompt,
        messages,
        ...(toolCount > 0 ? { tools, stopWhen: stepCountIs(10) } : {}),
      });
      console.log(`[chat] steps=${result.steps.length}, toolCalls=${result.steps.reduce((n, s) => n + (s.toolCalls?.length || 0), 0)}`);
      responseText = result.text;

      // Some models stop after tool calls without generating text.
      // Fall back to the last tool result so the user hears something.
      if (!responseText) {
        for (let i = result.steps.length - 1; i >= 0; i--) {
          const step = result.steps[i];
          if (step.toolResults?.length) {
            const last = step.toolResults[step.toolResults.length - 1];
            if (typeof last.result === "string" && last.result) {
              responseText = last.result;
              break;
            }
          }
        }
      }

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
    // previous responses involved tool usage, not just text.
    // Questions expand the window by 1 each time; non-questions reset to default.
    const allMessages = [...history, userMessage, ...responseMessages];
    const turnsToKeep = isQuestion(request.text)
      ? countUserTurns(allMessages)
      : DEFAULT_HISTORY_TURNS;
    this.saveHistory(
      request.conversation_id,
      trimToTurns(allMessages, turnsToKeep)
    );

    return { response: responseText, conversation_id: request.conversation_id };
  }

  private ensureSchema(): void {
    this.sql`CREATE TABLE IF NOT EXISTS conversations (
      conversation_id TEXT PRIMARY KEY,
      messages_json TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch())
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS timers (
      id TEXT PRIMARY KEY,
      slot_entity_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      satellite_id TEXT,
      fire_at INTEGER NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
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

  private clearHistory(conversationId: string): void {
    this.sql`DELETE FROM conversations WHERE conversation_id = ${conversationId}`;
    console.log(`[clearHistory] Cleared history for conversation=${conversationId}`);
  }
}
