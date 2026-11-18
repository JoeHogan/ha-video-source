from http import HTTPStatus

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant
from aiohttp import web, hdrs
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
import aiohttp
import base64

PROXY_URL = "/api/ha-video-source/{entry_id}/{tail:.*}"
ENTRY_INFO_URL = "/api/ha-video-source-config/{entry_id}"
HTTP_REGISTERED_KEY = f"{DOMAIN}_http_registered"

# Response headers that must not be copied from the upstream response: aiohttp
# recomputes the length and the body has already been decoded by the client session.
_SKIPPED_RESPONSE_HEADERS = ("transfer-encoding", "content-encoding", "content-length")


def is_builtin(entry_data: dict) -> bool:
    """True for a go2rtc entry that uses Home Assistant's built-in go2rtc (no URL)."""
    return entry_data.get(CONF_SOURCE_TYPE) == SOURCE_GO2RTC and not entry_data.get(
        CONF_SERVICE_URL
    )


def resolve_entry(hass: HomeAssistant, entry_id: str | None, proxyable_only: bool = False):
    """Find the loaded entry for an entry_id.

    'default' (or empty) resolves to the first loaded entry. With ``proxyable_only``
    entries that don't have a URL to proxy to (built-in go2rtc) are skipped.
    Returns (entry_id, entry_data) or (None, None).
    """
    entries = hass.data.get(DOMAIN, {})
    if entry_id in (None, "", "default"):
        for eid, data in entries.items():
            if proxyable_only and is_builtin(data):
                continue
            return eid, data
        return None, None

    data = entries.get(entry_id)
    if data is None or (proxyable_only and is_builtin(data)):
        return None, None
    return entry_id, data


class VideoSourceEntryInfoView(HomeAssistantView):
    """Tells the frontend which kind of source an integration entry is."""

    url = ENTRY_INFO_URL
    name = "api:ha_video_source:entry_info"
    requires_auth = True

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    async def get(self, request: web.Request, entry_id: str) -> web.Response:
        resolved_id, data = resolve_entry(self.hass, entry_id)
        if resolved_id is None:
            return self.json_message(
                "No matching Video Source integration is configured",
                HTTPStatus.NOT_FOUND,
            )
        return self.json(
            {
                "entry_id": resolved_id,
                "source": data.get(CONF_SOURCE_TYPE, SOURCE_MEDIAMTX),
                "builtin": is_builtin(data),
            }
        )


async def async_register_http(hass: HomeAssistant) -> None:
    """Register the proxy route and the entry info endpoint (once per Home Assistant run).

    Both look the entry up in ``hass.data`` on every request, so they keep working as
    entries are added, removed or reloaded - no per-entry route registration needed.
    """
    if hass.data.get(HTTP_REGISTERED_KEY):
        return
    hass.data[HTTP_REGISTERED_KEY] = True

    async def hass_authenticate(request: web.Request):
        # Already authenticated by HA middleware
        hass_user = request.get("hass_user")
        if hass_user:
            return hass_user

        # Fallback: token in query param
        token = request.query.get("token")
        if not token:
            return None

        # Validate using HA token validation (sync in your version)
        refresh_token = hass.auth.async_validate_access_token(token)
        if refresh_token is None:
            return None

        # Return user from token
        return refresh_token.user

    async def downstream_authentication_header(request: web.Request, entry_data):
        auth_method = entry_data.get(CONF_AUTH_METHOD, AUTH_METHOD_NONE)
        if auth_method == AUTH_METHOD_NONE:
            return ""
        elif auth_method == AUTH_METHOD_PASSTHRU:
            authHdr = request.headers.get(hdrs.AUTHORIZATION)
            return "" if authHdr is None else authHdr
        elif auth_method == AUTH_METHOD_BASIC:
            credential = f"{entry_data.get(CONF_AUTH_BASIC_USERNAME)}:{entry_data.get(CONF_AUTH_BASIC_PASSWORD)}"
            b64_credential = base64.b64encode(credential.encode("utf-8")).decode(
                "utf-8"
            )
            return f"Basic {b64_credential}"
        else:
            raise ValueError(f"unsupported auth method:{auth_method}")

    async def handle_proxy(request: web.Request):
        """Forward any request (including OPTIONS) to the configured service URL."""

        # Authenticate user
        hass_user = await hass_authenticate(request)
        if hass_user is None:
            return web.json_response({"error": "Unauthorized"}, status=401)

        # Retrieve the configured entry (service URL, etc)
        _, entry_data = resolve_entry(
            hass, request.match_info.get("entry_id"), proxyable_only=True
        )
        if not entry_data:
            return web.json_response(
                {"error": "No matching Video Source integration with a service URL"},
                status=404,
            )

        base_url = entry_data[CONF_SERVICE_URL].rstrip("/")

        tail = request.match_info.get("tail", "")
        target_url = f"{base_url}/{tail}".rstrip("/")

        # Copy query parameters
        params = dict(request.query)

        # Forward only the headers we care about
        headers = {
            k: v for k, v in request.headers.items() if k.lower() == "content-type"
        }

        auth_header = await downstream_authentication_header(request, entry_data)
        if auth_header:
            headers[hdrs.AUTHORIZATION] = auth_header

        # Read request body, if any
        try:
            body = await request.read()
        except Exception:
            body = None

        # Proxy the request to the backend service
        async with aiohttp.ClientSession() as session:
            async with session.request(
                method=request.method,
                url=target_url,
                headers=headers,
                params=params,
                data=body,
            ) as resp:
                response_body = await resp.read()

                # Forward most headers except hop-by-hop or CORS-related
                is_preview_img = tail.startswith("img/")
                skipped_headers = (
                    _SKIPPED_RESPONSE_HEADERS
                    + ("cache-control", "pragma", "expires", "etag", "last-modified")
                    if is_preview_img
                    else _SKIPPED_RESPONSE_HEADERS
                )
                response_headers = {
                    k: v
                    for k, v in dict(resp.headers).items()
                    if k.lower() not in skipped_headers
                }
                if is_preview_img:
                    response_headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
                    response_headers["Pragma"] = "no-cache"

                return web.Response(
                    body=response_body,
                    status=resp.status,
                    headers=response_headers,
                )

    hass.http.register_view(VideoSourceEntryInfoView(hass))

    # Register the route manually (wildcard = all methods)
    hass.http.app.router.add_route("*", PROXY_URL, handle_proxy)
