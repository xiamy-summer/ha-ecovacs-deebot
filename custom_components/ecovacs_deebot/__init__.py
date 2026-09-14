"""Support for Ecovacs Deebot vacuums (T90 PRO and more)."""

import hashlib
import logging
from pathlib import Path

from homeassistant.components import frontend
from homeassistant.components.http import StaticPathConfig
from homeassistant.components.lovelace.const import (
    CONF_RESOURCE_TYPE_WS,
    LOVELACE_DATA,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_URL, Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType

from .const import (
    CARD_FILENAME,
    CARD_LEGACY_FILENAMES,
    CARD_STATIC_URL,
    DATA_CARD_URL,
    DATA_EXTRA_CARD_REGISTERED,
    DATA_STATIC_PATH_REGISTERED,
    DOMAIN,
)
from .controller import EcovacsController
from .services import async_setup_services

_LOGGER = logging.getLogger(__name__)
_FRONTEND_DIR = Path(__file__).parent / "frontend"


def _card_module_url(digest: str | None = None) -> str:
    """Build the card URL with a content hash to bust browser caches."""
    return f"{CARD_STATIC_URL}/{CARD_FILENAME}?v={digest or 'dev'}"


async def _card_module_digest(hass: HomeAssistant) -> str:
    """Hash the card file (executor: file IO must not run in the event loop).

    ``read_bytes``/``open`` directly inside the event loop triggers HA's
    "Detected blocking call" warning during setup.
    """

    def _hash() -> str:
        try:
            payload = (_FRONTEND_DIR / CARD_FILENAME).read_bytes()
        except OSError:
            _LOGGER.warning("Map card file %s is missing", CARD_FILENAME)
            return "dev"
        return hashlib.md5(payload).hexdigest()[:8]

    return await hass.async_add_executor_job(_hash)

PLATFORMS = [
    Platform.BINARY_SENSOR,
    Platform.BUTTON,
    Platform.EVENT,
    Platform.IMAGE,
    Platform.NUMBER,
    Platform.SELECT,
    Platform.SENSOR,
    Platform.SWITCH,
    Platform.VACUUM,
]
type EcovacsConfigEntry = ConfigEntry[EcovacsController]

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Set up the component."""
    async_setup_services(hass)
    return True


async def _async_register_map_card(hass: HomeAssistant) -> None:
    """Expose the bundled map card and persist its Lovelace resource."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    card_url = _card_module_url(await _card_module_digest(hass))
    domain_data[DATA_CARD_URL] = card_url

    if not domain_data.get(DATA_STATIC_PATH_REGISTERED):
        await hass.http.async_register_static_paths(
            [
                StaticPathConfig(
                    CARD_STATIC_URL,
                    str(_FRONTEND_DIR),
                    False,
                )
            ]
        )
        domain_data[DATA_STATIC_PATH_REGISTERED] = True

    lovelace_data = hass.data.get(LOVELACE_DATA)
    resources = lovelace_data.resources if lovelace_data else None
    if resources is not None and hasattr(resources, "async_create_item"):
        await resources.async_get_info()
        # 清理历史卡片文件名对应的旧资源，避免新旧并存
        for resource in list(resources.async_items()):
            url = resource.get(CONF_URL, "")
            if any(
                url.startswith(f"{CARD_STATIC_URL}/{legacy}")
                for legacy in CARD_LEGACY_FILENAMES
            ):
                await resources.async_delete_item(resource["id"])
        bundled_resources = [
            resource
            for resource in resources.async_items()
            if resource.get(CONF_URL, "").startswith(
                f"{CARD_STATIC_URL}/{CARD_FILENAME}"
            )
        ]
        if bundled_resources:
            resource = bundled_resources[0]
            if resource.get(CONF_URL) != card_url:
                await resources.async_update_item(
                    resource["id"],
                    {
                        CONF_URL: card_url,
                        CONF_RESOURCE_TYPE_WS: "module",
                    },
                )
        else:
            await resources.async_create_item(
                {
                    CONF_URL: card_url,
                    CONF_RESOURCE_TYPE_WS: "module",
                }
            )
        return

    _LOGGER.warning(
        "Lovelace resources are not in storage mode; loading the map card "
        "for the current frontend session only"
    )
    if not domain_data.get(DATA_EXTRA_CARD_REGISTERED):
        frontend.add_extra_js_url(hass, card_url)
        domain_data[DATA_EXTRA_CARD_REGISTERED] = True


async def async_setup_entry(hass: HomeAssistant, entry: EcovacsConfigEntry) -> bool:
    """Set up this integration using UI."""
    controller = EcovacsController(hass, entry.data)

    entry.async_on_unload(controller.teardown)

    await controller.initialize()

    entry.runtime_data = controller

    await _async_register_map_card(hass)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: EcovacsConfigEntry) -> bool:
    """Unload config entry."""
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        entries = hass.data.get(DOMAIN)
        if isinstance(entries, dict):
            entries.pop(entry.entry_id, None)
            if entries.pop(DATA_EXTRA_CARD_REGISTERED, False):
                card_url = entries.get(DATA_CARD_URL) or _card_module_url(
                    await _card_module_digest(hass)
                )
                frontend.remove_extra_js_url(hass, card_url)
    return unloaded


async def async_remove_entry(hass: HomeAssistant, entry: EcovacsConfigEntry) -> None:
    """Remove the automatically managed Lovelace resource."""
    lovelace_data = hass.data.get(LOVELACE_DATA)
    resources = lovelace_data.resources if lovelace_data else None
    if resources is None or not hasattr(resources, "async_delete_item"):
        return

    await resources.async_get_info()
    for resource in list(resources.async_items()):
        if resource.get(CONF_URL, "").startswith(f"{CARD_STATIC_URL}/"):
            await resources.async_delete_item(resource["id"])
