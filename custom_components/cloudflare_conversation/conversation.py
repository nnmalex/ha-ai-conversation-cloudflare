"""Conversation entity for Cloudflare Conversation."""

from __future__ import annotations

import logging
from typing import Any

import aiohttp

from homeassistant.components.conversation import (
    ChatLog,
    ConversationEntity,
    ConversationInput,
    ConversationResult,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import MATCH_ALL
from homeassistant.core import HomeAssistant
from homeassistant.helpers import (
    area_registry as ar,
    device_registry as dr,
    floor_registry as fr,
)
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import (
    CONF_AGENT_URL,
    CONF_API_KEY,
    CONF_USER_INSTRUCTIONS,
    DEFAULT_TIMEOUT,
    DOMAIN,
)

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the conversation entity."""
    async_add_entities([CloudflareConversationEntity(hass, entry)])


class CloudflareConversationEntity(ConversationEntity):
    """Conversation entity that forwards to Cloudflare agent."""

    _attr_has_entity_name = True
    _attr_name = None

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        """Initialize the entity."""
        self.hass = hass
        self.entry = entry
        self._attr_unique_id = entry.entry_id
        self._agent_url: str = entry.data[CONF_AGENT_URL]
        self._api_key: str = entry.data[CONF_API_KEY]
        self._user_instructions: str = entry.data.get(CONF_USER_INSTRUCTIONS, "")

    @property
    def supported_languages(self) -> list[str] | str:
        """Return supported languages."""
        return MATCH_ALL

    async def _async_handle_message(
        self,
        user_input: ConversationInput,
        chat_log: ChatLog,
    ) -> ConversationResult:
        """Handle a conversation message."""
        area_name, floor_name = self._resolve_area(user_input.device_id)

        payload: dict[str, Any] = {
            "text": user_input.text,
            "conversation_id": user_input.conversation_id or "",
            "language": user_input.language or "en",
            "context": {
                "area_name": area_name,
                "floor_name": floor_name,
                "satellite_id": getattr(user_input, "satellite_id", None),
            },
        }

        if self._user_instructions:
            payload["extra_system_prompt"] = self._user_instructions

        try:
            session: aiohttp.ClientSession = self.hass.data[DOMAIN][
                self.entry.entry_id
            ]["session"]

            async with session.post(
                f"{self._agent_url}/api/chat",
                json=payload,
                headers={"Authorization": f"Bearer {self._api_key}"},
                timeout=aiohttp.ClientTimeout(total=DEFAULT_TIMEOUT),
            ) as resp:
                if resp.status in (401, 403):
                    return self._error_result(
                        user_input,
                        "Sorry, there's a configuration problem with the cloud assistant.",
                    )

                if resp.status != 200:
                    _LOGGER.error(
                        "Agent returned status %s: %s",
                        resp.status,
                        await resp.text(),
                    )
                    return self._error_result(
                        user_input,
                        "Sorry, the cloud assistant had a problem. Please try again.",
                    )

                try:
                    data = await resp.json()
                    response_text = data["response"]
                except (KeyError, ValueError, aiohttp.ContentTypeError) as err:
                    _LOGGER.error("Bad response from agent: %s", err)
                    return self._error_result(
                        user_input,
                        "Sorry, I got an unexpected response. Please try again.",
                    )

        except TimeoutError:
            return self._error_result(
                user_input,
                "Sorry, the cloud assistant took too long to respond.",
            )
        except aiohttp.ClientError as err:
            _LOGGER.error("Agent connection error: %s", err)
            return self._error_result(
                user_input,
                "Sorry, I can't reach the cloud assistant right now.",
            )

        chat_log.async_add_assistant_content_without_tools(response_text)
        return ConversationResult(chat_log=chat_log)

    def _resolve_area(
        self, device_id: str | None
    ) -> tuple[str | None, str | None]:
        """Resolve device_id to area name and floor name."""
        if not device_id:
            return None, None

        device_reg = dr.async_get(self.hass)
        device = device_reg.async_get(device_id)
        if not device or not device.area_id:
            return None, None

        area_reg = ar.async_get(self.hass)
        area = area_reg.async_get_area(device.area_id)
        if not area:
            return None, None

        floor_name = None
        if area.floor_id:
            floor_reg = fr.async_get(self.hass)
            floor = floor_reg.async_get_floor(area.floor_id)
            if floor:
                floor_name = floor.name

        return area.name, floor_name

    def _error_result(
        self, user_input: ConversationInput, message: str
    ) -> ConversationResult:
        """Create a ConversationResult with an error speech response."""
        from homeassistant.helpers.intent import IntentResponse

        response = IntentResponse(language=user_input.language or "en")
        response.async_set_speech(message)
        return ConversationResult(
            chat_log=ChatLog(
                hass=self.hass,
                conversation_id=user_input.conversation_id or "",
                user_input=user_input,
            ),
            response=response,
        )
