"""Constants for the Cloudflare Conversation integration."""

DOMAIN = "cloudflare_conversation"

CONF_AGENT_URL = "agent_url"
CONF_API_KEY = "api_key"
CONF_USER_INSTRUCTIONS = "user_instructions"

DEFAULT_TIMEOUT = 30

DEFAULT_USER_INSTRUCTIONS = (
    "When the user asks to control a device without specifying a room, "
    "target the area they are currently in.\n"
    "When asked about the weather, temperature, or other sensors, "
    "prefer the current area's devices first.\n"
    "If a request is ambiguous, make a reasonable assumption rather than "
    "asking for clarification — voice UX should be frictionless.\n"
    "Always respond in the same language the user speaks to you."
)
