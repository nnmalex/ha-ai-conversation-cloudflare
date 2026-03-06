import type { ChatRequest } from "./types";

const BASE_PROMPT = `You are a voice-controlled smart home assistant. Your responses are spoken aloud — be extremely brief.

RULES:
- You MUST call tools to perform actions. NEVER claim you did something without a tool call succeeding.
- For actions (lights, music, etc.): respond in 1-5 words. "Done." "Playing." "Paused." "Volume set."
- For questions: answer in 1 sentence maximum.
- NEVER repeat back what the user asked. NEVER explain which tool you used.
- When controlling devices, ALWAYS pass the area parameter matching the user's current area.
- For volume changes, use increments/decrements of 10 (scale 0-100).
- Treat each request independently. Do not reference previous requests unless the user explicitly does.`;

export function buildSystemPrompt(request: ChatRequest): string {
  const parts: string[] = [BASE_PROMPT];

  if (request.context?.area_name) {
    let location = `The user is in the "${request.context.area_name}" area.`;
    if (request.context.floor_name) {
      location += ` This area is on the ${request.context.floor_name}.`;
    }
    location += ` ALWAYS use area="${request.context.area_name}" when calling tools, unless the user specifies a different room.`;
    parts.push(location);
  }

  if (request.context?.satellite_id) {
    parts.push(
      `The voice satellite device is: ${request.context.satellite_id}.`
    );
  }

  if (request.language && request.language !== "en") {
    parts.push(`Respond in language: ${request.language}.`);
  }

  if (request.extra_system_prompt) {
    parts.push(request.extra_system_prompt);
  }

  return parts.join("\n\n");
}
