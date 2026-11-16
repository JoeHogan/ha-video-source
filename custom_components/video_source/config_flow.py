from __future__ import annotations

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.selector import (
    SelectOptionDict,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
)
from typing import Any

from .const import (
    DOMAIN,
    CONF_SOURCE_TYPE,
    CONF_SERVICE_URL,
    CONF_AUTH_METHOD,
    CONF_AUTH_BASIC_USERNAME,
    CONF_AUTH_BASIC_PASSWORD,
    AUTH_METHOD_PASSTHRU,
    AUTH_METHOD_NONE,
    AUTH_METHOD_BASIC,
    SOURCE_MEDIAMTX,
    SOURCE_GO2RTC,
)

GO2RTC_BUILTIN_UNIQUE_ID = "go2rtc_builtin"


class VideoSourceConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Wizard: 1) choose MediaMTX or go2rtc, 2) configure the chosen source."""

    VERSION = 3

    def __init__(self) -> None:
        self._data: dict[str, Any] = {}

    schema_source_type = vol.Schema(
        {
            vol.Required(CONF_SOURCE_TYPE, default=SOURCE_MEDIAMTX): SelectSelector(
                SelectSelectorConfig(
                    options=[
                        SelectOptionDict(value=SOURCE_MEDIAMTX, label="MediaMTX"),
                        SelectOptionDict(value=SOURCE_GO2RTC, label="go2rtc"),
                    ],
                    mode=SelectSelectorMode.LIST,
                )
            ),
        }
    )

    vol_auth_settings = {
        vol.Required(
            CONF_AUTH_METHOD,
            default=AUTH_METHOD_NONE,
        ): vol.In([AUTH_METHOD_NONE, AUTH_METHOD_PASSTHRU, AUTH_METHOD_BASIC]),
        vol.Optional(
            CONF_AUTH_BASIC_USERNAME,
        ): cv.string,
        vol.Optional(
            CONF_AUTH_BASIC_PASSWORD,
        ): cv.string,
    }

    schema_mediamtx = vol.Schema(
        {
            vol.Required(
                CONF_SERVICE_URL,
                default="http://localhost:8889",
            ): cv.string,
            **vol_auth_settings,
        }
    )
    # URL is optional: blank means "use Home Assistant's built-in go2rtc"
    schema_go2rtc = vol.Schema(
        {
            vol.Optional(
                CONF_SERVICE_URL,
                description={"suggested_value": ""},
            ): cv.string,
        }
    )
    schema_go2rtc_auth = vol.Schema(vol_auth_settings)
    schema_update = vol.Schema(vol_auth_settings)

    @staticmethod
    def validate_service_url(service_url: str) -> dict[str, str]:
        """Form validation, common for create/update"""
        errors: dict[str, str] = {}

        # Basic validation: must start with http:// or https://
        if not service_url.startswith(("http://", "https://")):
            errors["base"] = "invalid_url"

        return errors

    # ------------------------------------------------------------------
    # Step 1: which kind of video source?
    # ------------------------------------------------------------------
    async def async_step_user(self, user_input: dict | None = None) -> FlowResult:
        """Handle the initial step when adding the integration."""
        if user_input is not None:
            self._data = {CONF_SOURCE_TYPE: user_input[CONF_SOURCE_TYPE]}
            if self._data[CONF_SOURCE_TYPE] == SOURCE_GO2RTC:
                return await self.async_step_go2rtc()
            return await self.async_step_mediamtx()

        return self.async_show_form(
            step_id="user",
            data_schema=self.schema_source_type,
        )  # type: ignore[arg-type]

    # ------------------------------------------------------------------
    # Step 2 (MediaMTX): URL + authentication
    # ------------------------------------------------------------------
    async def async_step_mediamtx(self, user_input: dict | None = None) -> FlowResult:
        errors: dict[str, str] = {}

        if user_input is not None:
            service_url = user_input[CONF_SERVICE_URL].strip()
            errors = self.validate_service_url(service_url)

            if not errors:
                # the URL is our permanent system ID
                await self.async_set_unique_id(service_url)
                self._abort_if_unique_id_configured()

                return self.async_create_entry(
                    title=f"MediaMTX ({service_url})",
                    data={
                        **self._data,
                        **user_input,
                        CONF_SERVICE_URL: service_url,
                    },
                )  # type: ignore[arg-type]

        return self.async_show_form(
            step_id="mediamtx",
            data_schema=self.schema_mediamtx,
            errors=errors,
        )  # type: ignore[arg-type]

    # ------------------------------------------------------------------
    # Step 2 (go2rtc): optional URL. Blank = Home Assistant's built-in go2rtc
    # ------------------------------------------------------------------
    async def async_step_go2rtc(self, user_input: dict | None = None) -> FlowResult:
        errors: dict[str, str] = {}

        if user_input is not None:
            service_url = (user_input.get(CONF_SERVICE_URL) or "").strip()

            if not service_url:
                # Home Assistant's built-in go2rtc: nothing else to configure
                await self.async_set_unique_id(GO2RTC_BUILTIN_UNIQUE_ID)
                self._abort_if_unique_id_configured()
                return self.async_create_entry(
                    title="go2rtc (Home Assistant built-in)",
                    data={
                        **self._data,
                        CONF_SERVICE_URL: "",
                        CONF_AUTH_METHOD: AUTH_METHOD_NONE,
                    },
                )  # type: ignore[arg-type]

            errors = self.validate_service_url(service_url)
            if not errors:
                await self.async_set_unique_id(f"go2rtc:{service_url}")
                self._abort_if_unique_id_configured()
                self._data[CONF_SERVICE_URL] = service_url
                return await self.async_step_go2rtc_auth()

        return self.async_show_form(
            step_id="go2rtc",
            data_schema=self.schema_go2rtc,
            errors=errors,
        )  # type: ignore[arg-type]

    # ------------------------------------------------------------------
    # Step 3 (external go2rtc only): authentication
    # ------------------------------------------------------------------
    async def async_step_go2rtc_auth(self, user_input: dict | None = None) -> FlowResult:
        if user_input is not None:
            return self.async_create_entry(
                title=f"go2rtc ({self._data[CONF_SERVICE_URL]})",
                data={**self._data, **user_input},
            )  # type: ignore[arg-type]

        return self.async_show_form(
            step_id="go2rtc_auth",
            data_schema=self.schema_go2rtc_auth,
        )  # type: ignore[arg-type]

    # ------------------------------------------------------------------
    # Reconfigure: authentication only (the URL is the entry's identity)
    # ------------------------------------------------------------------
    async def async_step_reconfigure(self, user_input: dict[str, Any] | None = None):
        entry = self._get_reconfigure_entry()
        if (
            entry.data.get(CONF_SOURCE_TYPE) == SOURCE_GO2RTC
            and not entry.data.get(CONF_SERVICE_URL)
        ):
            # Built-in go2rtc has no settings of its own
            return self.async_abort(reason="reconfigure_not_needed")

        if user_input is not None:
            # Use the unique id already embedded in class instance
            return self.async_update_reload_and_abort(
                entry,
                data_updates=user_input,
            )

        return self.async_show_form(
            step_id="reconfigure",
            data_schema=self.schema_update,
        )
