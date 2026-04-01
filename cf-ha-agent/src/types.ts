// Secrets not in wrangler.jsonc — augment the generated Env
declare global {
  interface Env {
    HA_MCP_URL: string;
    HA_ACCESS_TOKEN: string;
    AGENT_API_KEY: string;
  }
}

export interface ChatRequest {
  text: string;
  conversation_id: string;
  language?: string;
  context?: {
    area_name?: string;
    floor_name?: string;
    satellite_id?: string;
  };
  extra_system_prompt?: string;
}

export interface ChatResponse {
  response: string;
  conversation_id: string;
}
