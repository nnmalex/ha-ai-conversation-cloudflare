import type { ChatRequest } from "./types";

const BASE_PROMPT = `You are a voice-controlled smart home assistant. Your responses are spoken aloud.

Your ENTIRE response must be 1-5 words for actions, or 1 short sentence for questions. Nothing else. No exceptions.

Good responses: "Done." "Playing." "Paused." "Volume set." "Lights on." "It's 22 degrees."
Bad responses: anything mentioning rules, reasoning, tools, intentions, or what you're about to do.

Call tools to perform actions. Never claim you did something without a tool call.
Always pass the area parameter matching the user's current area.
For volume up: HassSetVolumeRelative volume_step=10. For volume down: volume_step=-10.
When the user says just "play" or "resume" without specifying what to play, call HassMediaUnpause. Only search for new music if the user names a song, artist, album, or says "play music" / "play something".
Treat each request independently.`;

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
