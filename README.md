# ha-ai — Home Assistant + Cloudflare AI Agent

Connect Home Assistant's voice assistant to a remote AI agent running on Cloudflare Workers. Instead of sending your entire entity list on every request (like built-in HA conversation integrations do), this project sends ~200 bytes of context and lets the agent discover entities on-demand via HA's MCP server.

## How It Works

```
Voice Satellite (e.g. Living Room)
  → HA Core (cloudflare_conversation integration)
    → Cloudflare Agent (Durable Object)
      → Workers AI (tool calling)
        → HA MCP Server (executes actions)
```

1. You speak to a voice satellite
2. The HA integration resolves which room the satellite is in and sends the text + area context to the Cloudflare agent
3. The agent uses Workers AI to reason about your request and calls HA tools via MCP
4. HA executes the action (turn on lights, play music, etc.)

## Prerequisites

- Home Assistant instance **accessible from the internet** (via [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/), [Nabu Casa](https://www.nabucasa.com/), or similar). Cloudflare Workers cannot reach private/local IPs.
- [HA MCP Server integration](https://www.home-assistant.io/integrations/mcp_server/) enabled
- Cloudflare account (free tier works)
- [HACS](https://hacs.xyz/) installed on your HA instance

## Setup

### 1. Deploy the Cloudflare Agent

```bash
cd cf-ha-agent
npm install

# Configure secrets
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your values:
#   HA_MCP_URL — your HA MCP endpoint (e.g. https://my-ha.example.com/api/mcp)
#   HA_ACCESS_TOKEN — a Long-Lived Access Token from HA
#   AGENT_API_KEY — a strong random string (you'll use this in the HA integration too)

# Test locally
npx wrangler dev

# Deploy to Cloudflare
npx wrangler deploy

# Set production secrets
npx wrangler secret put HA_MCP_URL
npx wrangler secret put HA_ACCESS_TOKEN
npx wrangler secret put AGENT_API_KEY
```

Verify the deployment:
```bash
curl https://cf-ha-agent.<your-account>.workers.dev/health
# → {"status":"ok"}
```

### 2. Install the HA Integration

1. Copy `cloudflare-conversation/custom_components/cloudflare_conversation/` to your HA `config/custom_components/` directory
2. Restart Home Assistant
3. Go to **Settings → Devices & Services → Add Integration**
4. Search for "Cloudflare Conversation"
5. Enter your agent URL and API key

### 3. Configure a Voice Assistant

1. Go to **Settings → Voice Assistants**
2. Create a new assistant (or edit an existing one)
3. Set **Conversation agent** to your Cloudflare Conversation entity
4. Assign the assistant to your voice satellites

## Supported Capabilities

### Works Out of the Box

Everything exposed by HA's MCP server (Assist API intents):

- **Lights**: turn on/off, set brightness, color, color temperature
- **Climate**: set temperature, get temperature
- **Media**: search and play, pause, next/previous, volume
- **Covers**: open, close, set position
- **Fans**: set speed
- **Vacuums**: start, return to base
- **Timers**: start, cancel, pause, resume, increase/decrease
- **Shopping/to-do lists**: add items, complete items, list items
- **Weather**: get forecast
- **General**: get entity state, turn on/off any device

### Music Assistant

[Music Assistant](https://www.music-assistant.io/) works with this setup:

**Out of the box** — basic music search and playback uses HA's built-in `HassMediaSearchAndPlay` intent. Music Assistant's media player entities implement the `SEARCH_MEDIA` feature, so saying "play Pink Floyd" will search across all your configured MA providers (Spotify, Apple Music, local files, etc.) and play the result on the satellite's area player.

Standard media controls (pause, next, previous, volume) also work via built-in intents.

**Advanced features** — radio mode, multi-item queuing, queue transfer, and announcements require Music Assistant's custom services which aren't exposed via MCP by default. To enable these:

1. Install Music Assistant's [voice support blueprints](https://github.com/music-assistant/voice-support) — these create HA scripts that wrap MA's custom services
2. Go to **Settings → Voice Assistants → Expose** and expose the scripts
3. The scripts automatically appear as MCP tools that the agent can call

**Favouriting the current song** — The MA-provided favourite button entity doesn't work when triggered from HA (known MA issue). As a workaround, you can call MA's REST API directly using an HA `rest_command`. See `ha-scripts/favourite_current_song.yaml` for the script and required `rest_command` configuration.

### Extending with Custom Scripts

Any HA integration not covered by built-in intents can be made available by creating a script and exposing it:

1. Create a script in **Settings → Automations & Scenes → Scripts**
2. Expose it via **Settings → Voice Assistants**
3. The agent discovers it automatically — no code changes needed

This is HA's intended extensibility mechanism. The agent dynamically discovers all available MCP tools on startup, including script-based ones.

Example scripts are provided in the `ha-scripts/` directory:

- **`play_random_music.yaml`** — Play shuffled library tracks ("play music", "play something")
- **`queue_song.yaml`** — Add a song next in the queue without stopping playback ("queue X", "play X next")
- **`favourite_current_song.yaml`** — Favourite the currently playing track ("I like this song")

## Configuration

### Cloudflare Agent (`cf-ha-agent`)

| Variable | Type | Description |
|---|---|---|
| `HA_MCP_URL` | secret | HA MCP server endpoint |
| `HA_ACCESS_TOKEN` | secret | HA Long-Lived Access Token |
| `AGENT_API_KEY` | secret | API key for the HA integration |
| `AI_MODEL` | var | Workers AI model ID (default: `@cf/zai-org/glm-4.7-flash`) |

### HA Integration (`cloudflare_conversation`)

Configured via the UI:

| Field | Description |
|---|---|
| Agent URL | Cloudflare agent endpoint (e.g. `https://cf-ha-agent.your-account.workers.dev`) |
| API Key | Must match `AGENT_API_KEY` on the Cloudflare side |
| User Instructions | Optional text appended to every system prompt |

## AI Models

The agent uses Workers AI. Recommended models with tool calling support:

| Model | Context | Best For |
|---|---|---|
| `@cf/zai-org/glm-4.7-flash` (default) | 131K | Fast, cheap, good tool calling |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | 131K | Best overall capability |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 24K | Strongest reasoning |

Change the model by setting the `AI_MODEL` variable in `wrangler.jsonc` or via `wrangler secret put AI_MODEL`.

## License

MIT
