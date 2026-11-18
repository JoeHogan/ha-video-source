from homeassistant.core import HomeAssistant
from homeassistant.config_entries import ConfigEntry

from .const import (
    DOMAIN,
    CONF_SOURCE_TYPE,
    CONF_SERVICE_URL,
    CONF_AUTH_METHOD,
    CONF_AUTH_BASIC_USERNAME,
    CONF_AUTH_BASIC_PASSWORD,
    AUTH_METHOD_NONE,
    SOURCE_MEDIAMTX,
)

from .http_api import async_register_http
from . import utils
from pathlib import Path
import hashlib

import logging

_LOGGER = logging.getLogger(__name__)


def _asset_version(www_dir: Path) -> str:
    """Short content hash of www/ assets used as the resource cache-bust tag."""
    try:
        h = hashlib.sha1()
        for file in sorted(www_dir.glob("*")):
            if file.is_file():
                h.update(file.read_bytes())
        return h.hexdigest()[:12]
    except OSError:
        return "0"


async def async_setup(hass: HomeAssistant, config: dict):
    """YAML setup (not used but must exist)."""
    return True


async def async_migrate_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Migrate older config entries.

    Entries created before go2rtc support only ever described a MediaMTX server.
    """
    if entry.version < 3:
        hass.config_entries.async_update_entry(
            entry,
            data={**entry.data, CONF_SOURCE_TYPE: SOURCE_MEDIAMTX},
            version=3,
        )
        _LOGGER.info("Migrated Video Source entry %s to version 3", entry.entry_id)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry):
    """Set up a Video Source (MediaMTX or go2rtc) from a config entry."""
    entry_data = entry.data

    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = {
        CONF_SOURCE_TYPE: entry_data.get(CONF_SOURCE_TYPE, SOURCE_MEDIAMTX),
        # Empty for go2rtc entries that use Home Assistant's built-in go2rtc
        CONF_SERVICE_URL: entry_data.get(CONF_SERVICE_URL) or "",
        CONF_AUTH_METHOD: entry_data.get(CONF_AUTH_METHOD, AUTH_METHOD_NONE),
        CONF_AUTH_BASIC_USERNAME: entry_data.get(CONF_AUTH_BASIC_USERNAME),
        CONF_AUTH_BASIC_PASSWORD: entry_data.get(CONF_AUTH_BASIC_PASSWORD),
    }

    # Register backend API (proxy + entry info). Idempotent.
    await async_register_http(hass)

    # Serve JS card from www directory inside custom_component
    path = Path(__file__).parent / "www"
    await utils.register_static_path(hass, f"/{DOMAIN}", str(path))

    # Register the card as a Lovelace dashboard resource with a content-hash
    # cache-bust tag (HACS-style). Editing the card + restarting HA changes the
    # tag, so every browser auto-refetches it - no manual cache clearing.
    tag = await hass.async_add_executor_job(_asset_version, path)
    await utils.init_resource(hass, f"/{DOMAIN}/video-source-card.js", tag)

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry):
    """Unload a Video Source entry."""
    hass.data[DOMAIN].pop(entry.entry_id, None)
    return True
