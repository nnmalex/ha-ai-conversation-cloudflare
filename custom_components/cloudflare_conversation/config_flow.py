"""Config flow for Cloudflare Conversation."""

from __future__ import annotations

import logging
from typing import Any

import aiohttp
import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.selector import TextSelector, TextSelectorConfig, TextSelectorType

from .const import (
    CONF_AGENT_URL,
    CONF_API_KEY,
    CONF_USER_INSTRUCTIONS,
    DEFAULT_USER_INSTRUCTIONS,
    DOMAIN,
)

_LOGGER = logging.getLogger(__name__)

STEP_USER_DATA_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_AGENT_URL): str,
        vol.Required(CONF_API_KEY): str,
        vol.Optional(
            CONF_USER_INSTRUCTIONS, default=DEFAULT_USER_INSTRUCTIONS
        ): TextSelector(TextSelectorConfig(multiline=True)),
    }
)


class CloudflareConversationConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Cloudflare Conversation."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle the initial step."""
        errors: dict[str, str] = {}

        if user_input is not None:
            agent_url = user_input[CONF_AGENT_URL].rstrip("/")
            api_key = user_input[CONF_API_KEY]

            try:
                session = async_get_clientsession(self.hass)
                async with session.get(
                    f"{agent_url}/health",
                    headers={"Authorization": f"Bearer {api_key}"},
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    if resp.status == 401 or resp.status == 403:
                        errors["base"] = "invalid_auth"
                    elif resp.status != 200:
                        errors["base"] = "cannot_connect"
            except (aiohttp.ClientError, TimeoutError):
                errors["base"] = "cannot_connect"

            if not errors:
                user_input[CONF_AGENT_URL] = agent_url
                return self.async_create_entry(
                    title="Cloudflare Agent", data=user_input
                )

        return self.async_show_form(
            step_id="user",
            data_schema=STEP_USER_DATA_SCHEMA,
            errors=errors,
        )
