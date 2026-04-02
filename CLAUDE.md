# ha-ai — Home Assistant + Cloudflare AI Agent

## Project Overview

This project connects Home Assistant's voice assistant to a remote AI agent running on Cloudflare. It consists of two sub-projects (separate repos in this folder):

1. **`cf-ha-agent/`** — Cloudflare Agent (TypeScript) that connects to HA's MCP server and uses Workers AI for reasoning
2. **`cloudflare-conversation/`** — Home Assistant custom integration (Python) that bridges HA's Conversation API to the Cloudflare agent

### Why This Architecture

The built-in HA conversation integrations (Anthropic, OpenAI, etc.) send a large context on every request — all exposed entities, areas, floors as YAML. This is token-inefficient and slow.

Our approach: the Cloudflare agent connects directly to HA's MCP server and discovers tools/entities on-demand. The HA integration sends only minimal context per request (~200 bytes: text, area name, language).

## Architecture

```
Voice Satellite (e.g. Living Room)
  |  device_id, satellite_id, text
  v
HA Core -- cloudflare_conversation integration
  |  Resolves: device_id -> area_name, floor_name
  |  Sends: { text, area_name, floor_name, satellite_id, conversation_id, language }
  v
Cloudflare Agent (Durable Object, persistent SQLite state)
  |  System prompt includes area context
  |  Calls Workers AI with MCP tools
  v
Workers AI (glm-4.7-flash or llama-4-scout)
  |  Decides tool calls, e.g. HassTurnOn(domain="light", area="Living Room")
  v
HA MCP Server (/api/mcp, Streamable HTTP, Bearer token auth)
  |  Executes intent with area parameter
  v
Device action completed
```

## Sub-Project: cf-ha-agent (Cloudflare)

### Tech Stack
- Cloudflare Agents SDK (`agents`)
- Workers AI via Vercel AI SDK v6 (`workers-ai-provider`, `ai`)
- Base `Agent` class (MCP client, SQLite via `this.sql`, `onRequest()` for REST)
- TypeScript

### Key Design Decisions
- Uses base `Agent` class (not `AIChatAgent` which is designed for WebSocket chat UIs — our client makes REST POST calls)
- Manages conversation history in SQLite manually (messages table per conversation_id)
- `onStart()` calls `this.addMcpServer()` to connect to HA's MCP server (idempotent, survives restarts)
- `this.mcp.getAITools()` converts MCP tools to Vercel AI SDK format for the model
- Durable Object per conversation — state persists across requests without external DB
- Provider-agnostic via Vercel AI SDK — can swap Workers AI for Anthropic/OpenAI later

### Workers AI Models (with tool calling support)
- `@cf/zai-org/glm-4.7-flash` — 131K context, optimized for multi-turn tool calling, cheapest ($0.06/M input). Best default for home automation.
- `@cf/meta/llama-4-scout-17b-16e-instruct` — 131K context, best overall capability, multimodal
- `@cf/meta/llama-3.3-70b-instruct-fp8-fast` — 24K context, strongest reasoning

### Configuration (secrets / env vars, never hardcoded)
- `HA_MCP_URL` (var) — HA MCP server endpoint, e.g. `https://my-ha.example.com/api/mcp`
- `HA_ACCESS_TOKEN` (secret) — Long-Lived Access Token from HA
- `AGENT_API_KEY` (secret) — API key for the HA integration to authenticate to this agent
- `AI_MODEL` (var) — Workers AI model ID, default `@cf/zai-org/glm-4.7-flash`

### API Endpoint
```
POST /api/chat
Authorization: Bearer <AGENT_API_KEY>
Content-Type: application/json

{
  "text": "turn on the lights",
  "conversation_id": "01JExample",
  "language": "en",
  "context": {
    "area_name": "Living Room",
    "floor_name": "Ground Floor",
    "satellite_id": "assist_satellite.living_room_speaker"
  },
  "extra_system_prompt": "Always respond concisely for voice."
}
```

### MCP Connection Details
- HA MCP Server exposes Assist API tools: HassTurnOn, HassTurnOff, HassGetState, HassLightSet, HassClimateSetTemperature, HassMediaSearchAndPlay, etc.
- Transport: Streamable HTTP (`/api/mcp`) preferred, SSE (`/mcp_server/sse`) as fallback
- Auth: Bearer token in Authorization header
- Stateless per-request on HA side — Agents SDK handles reconnection and caches tool list
- Tools accept `area` parameter — this is how the agent targets the correct room

### Custom Integrations and MCP Tool Discovery

HA's MCP server exposes **only** the Assist API intents — there is no generic `call_service` tool. This is a deliberate HA design decision for safety. However, the tool set is extensible:

#### What's available out of the box
- **Built-in intents** become MCP tools automatically: lights, climate, media, covers, fans, vacuums, timers, shopping lists, weather, date/time
- **Media intents**: `HassMediaPause`, `HassMediaUnpause`, `HassMediaNext`, `HassMediaPrevious`, `HassSetVolume`, `HassSetVolumeRelative`, `HassMediaPlayerMute`, `HassMediaPlayerUnmute`, `HassMediaSearchAndPlay`
- **Calendar/To-do tools**: `calendar_get_events`, `todo_get_items` (if entities are exposed)
- **`GetLiveContext`**: returns real-time state of all exposed entities

#### Extending MCP with HA scripts (the escape hatch)
Any HA script that is **exposed** via Settings > Voice Assistants automatically becomes an MCP tool. This is HA's intended mechanism for adding custom capabilities without code changes on the agent side.

**Our agent discovers tools dynamically** — `this.mcp.getAITools()` picks up all available tools including script-based ones. No agent-side changes are needed when users add new scripts.

#### Music Assistant (and similar custom integrations)
Music Assistant is a common HA add-on for music streaming. Key facts:

1. **Basic playback works via built-in MCP intents**: MA's `media_player` entities implement `async_search_media` (the `SEARCH_MEDIA` feature flag), so `HassMediaSearchAndPlay(search_query="Pink Floyd", area="Living Room")` works out of the box — MA searches across all configured providers (Spotify, Apple Music, local files, etc.) and plays the result
2. **Standard media controls work**: pause, next, previous, volume — all via built-in MCP intents targeting the area
3. **Advanced MA features require custom services** not in MCP: radio mode, multi-item queuing, queue transfer, announcements with auto-resume. These use `music_assistant.play_media`, `music_assistant.search`, `music_assistant.transfer_queue`, etc.
4. **To expose advanced features**: users create HA scripts wrapping MA services, expose them, and they appear as MCP tools automatically. MA's [voice-support blueprints](https://github.com/music-assistant/voice-support) provide ready-made scripts for this

#### Design principle
The agent should never need to know which integrations are "custom" vs built-in. It simply uses whatever tools the MCP server exposes. Users extend capabilities by exposing scripts — no agent code changes required.

### Timer Implementation
The agent implements its own timer system using HA's `timer` helper entities as slots and Durable Object SQLite + scheduled alarms for state management.

#### Architecture
- **HA timer helpers** (`timer.assist_timer_1`, etc.) are the physical slots — the agent discovers them via `/api/states`
- **SQLite `timers` table** tracks: slot assignment, name, satellite_id, fire_at, state (`active`/`firing`), ring_count
- **Scheduled alarms** (`this.schedule()`) fire `handleTimerExpiry` when a timer is due, then `handleTimerRing` every 10s for firing timers

#### Timer lifecycle
1. `set_timer` — finds a free slot, starts the HA timer, inserts SQLite row (state=`active`), schedules alarm
2. `handleTimerExpiry` — transitions expired timers to `firing` state, announces via satellite
3. `handleTimerRing` — re-announces every 10s until dismissed (max 20 rings, then auto-dismiss)
4. `dismiss_timer` — deletes firing timer(s) from SQLite, stops ring schedule
5. `cancel_timer` — cancels active HA timer + deletes SQLite row, or just deletes if firing

#### Custom tools (not MCP)
- `set_timer` — parses duration from user text as fallback (model args unreliable)
- `cancel_timer` — cancels active or ringing timer by name
- `list_timers` — shows remaining time or RINGING status
- `dismiss_timer` — silences ringing alarms by name or all at once

#### Slot occupancy
- Source of truth is HA `/api/states` — SQLite records are reconciled against HA state on each `set_timer` call
- Stale active records (slot idle in HA) are cleaned up; firing records are preserved

## Sub-Project: cloudflare-conversation (Home Assistant)

### Tech Stack
- Python, Home Assistant custom component
- Distributed via HACS
- Implements `ConversationEntity` from `homeassistant.components.conversation`

### Key Design Decisions
- Does NOT call `chat_log.async_provide_llm_data()` with `user_llm_hass_api="assist"` — that would inject the full entity YAML (the problem we're solving)
- Instead, resolves device_id to area/floor names locally using HA registries
- Forwards only minimal context to the Cloudflare agent
- Maps HA `conversation_id` to Cloudflare agent Durable Object instance IDs

### ConversationEntity Implementation
- Override `_async_handle_message(user_input, chat_log)` — the core method
- Override `supported_languages` property — return `MATCH_ALL` ("*")
- Set `_attr_supports_streaming = True` for voice latency optimization (phase 2)

### Satellite Area Resolution (critical for voice UX)
```python
# In _async_handle_message():
# Resolve device_id -> area_name, floor_name using HA registries
device = device_registry.async_get(user_input.device_id)
area = area_registry.async_get_area(device.area_id)
floor = floor_registry.async_get_floor(area.floor_id)
# Send area_name + floor_name to Cloudflare agent as minimal context
```

This solves:
- "Turn on the lights" -> targets the satellite's area
- "Play music" -> targets the satellite speaker
- "What's the temperature?" -> reads the area's climate sensor

### Config Flow (UI settings, no hardcoded values)
- Agent URL — Cloudflare agent endpoint
- API Key — matches AGENT_API_KEY on the Cloudflare side
- User Instructions — optional custom system prompt additions

### HACS Distribution
- `custom_components/cloudflare_conversation/` directory structure
- `hacs.json` manifest
- Standard HA custom component files: `__init__.py`, `manifest.json`, `config_flow.py`, `conversation.py`, `const.py`, `strings.json`, `translations/`

## Implementation Order

1. **cf-ha-agent** — scaffold, connect to HA MCP server, verify tool discovery, test with curl
2. **cloudflare-conversation** — minimal HA integration, REST-based communication
3. **Streaming** — add WebSocket/streaming support for voice latency
4. **Polish** — error handling, HACS packaging, documentation

## Error Handling (Voice-Friendly)

All errors must produce concise, natural-language messages suitable for text-to-speech on a voice satellite. Never expose stack traces, HTTP codes, or technical details to the user.

### cf-ha-agent Error Responses
The agent must always return a valid JSON response with a `response` field, even on failure:
```json
{ "response": "Sorry, I wasn't able to do that. Please try again." }
```

Error categories and example spoken responses:
- **MCP connection failure** (HA unreachable): "Sorry, I can't reach Home Assistant right now."
- **Tool execution failure** (intent fails): "Sorry, I wasn't able to do that. The device might be unavailable."
- **AI model error** (Workers AI fails): "Sorry, I'm having trouble thinking right now. Please try again."
- **Auth failure** (bad API key): "Sorry, there's a configuration problem. Please check the agent setup."
- **Timeout**: "Sorry, that took too long. Please try again."

### cloudflare-conversation Error Responses
The HA integration must catch all exceptions from the Cloudflare agent call and return a `ConversationResult` with a spoken error — never let exceptions propagate to a raw HA error screen:
- **Agent unreachable** (network/DNS): "Sorry, I can't reach the cloud assistant right now."
- **Auth rejected** (401/403): "Sorry, there's a configuration problem with the cloud assistant."
- **Unexpected response** (bad JSON, missing fields): "Sorry, I got an unexpected response. Please try again."
- **Timeout**: "Sorry, the cloud assistant took too long to respond."

### Guidelines
- Keep error messages under ~15 words — they will be spoken aloud
- Start with "Sorry" to signal failure clearly in voice UX
- Never include entity IDs, URLs, exception types, or JSON in spoken responses
- Log full technical details at `_LOGGER.error()` / `console.error()` for debugging

## Open Source Requirements
- No secrets or sensitive info in code — all via env vars / config flow
- Generic configuration — works with any HA instance
- Clear setup documentation for both components
