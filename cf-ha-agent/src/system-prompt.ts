import type { ChatRequest } from "./types";

const BASE_PROMPT = `You are a helpful home assistant that controls smart home devices. \
Be concise — your responses will be spoken aloud by a voice satellite. \
Keep answers under two sentences unless the user asks for detail. \
When controlling devices, use the available tools. \
If a tool call fails, tell the user briefly what went wrong.`;

export function buildSystemPrompt(request: ChatRequest): string {
  const parts: string[] = [BASE_PROMPT];

  if (request.context?.area_name) {
    let location = `The user is in the ${request.context.area_name} area.`;
    if (request.context.floor_name) {
      location += ` This area is on the ${request.context.floor_name}.`;
    }
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
