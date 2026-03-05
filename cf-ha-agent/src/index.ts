import { getAgentByName } from "agents";
import "./types";

export { HomeAssistantAgent } from "./agent";

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ response: message }, status);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return jsonResponse({ status: "ok" });
    }

    if (url.pathname === "/api/debug" && request.method === "GET") {
      const authHeader = request.headers.get("Authorization");
      if (!authHeader || authHeader !== `Bearer ${env.AGENT_API_KEY}`) {
        return errorResponse("Unauthorized", 401);
      }
      const agent = await getAgentByName(
        env.HOME_ASSISTANT_AGENT,
        "home-assistant"
      );
      return agent.fetch(new Request(request.url.replace("/api/debug", "/agents/home-assistant/debug"), request));
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      const authHeader = request.headers.get("Authorization");
      if (!authHeader || authHeader !== `Bearer ${env.AGENT_API_KEY}`) {
        return errorResponse(
          "Sorry, there's a configuration problem. Please check the agent setup.",
          401
        );
      }

      // Single shared DO — MCP connection is established once and reused.
      // Conversation history is keyed by conversation_id in SQLite.
      const agent = await getAgentByName(
        env.HOME_ASSISTANT_AGENT,
        "home-assistant"
      );

      return agent.fetch(request);
    }

    return errorResponse("Not found", 404);
  },
} satisfies ExportedHandler<Env>;
