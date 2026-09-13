"""Ecovacs constants."""

from enum import StrEnum

from deebot_client.commands import StationAction
from deebot_client.events import LifeSpan

DOMAIN = "ecovacs_deebot"

# 地图卡片前端资源（内置，无需手动添加 Lovelace 资源）
CARD_STATIC_URL = "/ecovacs_deebot"
CARD_FILENAME = "ecovacs-t90-map-card.js"
CARD_MODULE_URL = f"{CARD_STATIC_URL}/{CARD_FILENAME}?v=0.2.0"
DATA_STATIC_PATH_REGISTERED = "card_static_path_registered"
DATA_EXTRA_CARD_REGISTERED = "card_extra_js_registered"

CONF_CONTINENT = "continent"
CONF_OVERRIDE_REST_URL = "override_rest_url"
CONF_OVERRIDE_MQTT_URL = "override_mqtt_url"
CONF_VERIFICATION_CODE = "verification_code"
CONF_VERIFY_MQTT_CERTIFICATE = "verify_mqtt_certificate"

SUPPORTED_LIFESPANS = (
    LifeSpan.AIR_FRESHENER,
    LifeSpan.BLADE,
    LifeSpan.BRUSH,
    LifeSpan.CLEANING_SOLUTION,
    LifeSpan.DUST_BAG,
    LifeSpan.FILTER,
    LifeSpan.HAND_FILTER,
    LifeSpan.LENS_BRUSH,
    LifeSpan.ROUND_MOP,
    LifeSpan.SEWAGE_BOX,
    LifeSpan.SIDE_BRUSH,
    LifeSpan.STATION_FILTER,
    LifeSpan.TRIMMER_BRUSH,
    LifeSpan.UNIT_CARE,
    LifeSpan.UV_SANITIZER,
    LifeSpan.WATER_SINK,
    LifeSpan.WEED_ROPE,
)

SUPPORTED_STATION_ACTIONS = (
    StationAction.CLEAN_BASE,
    StationAction.DRY_MOP,
    StationAction.EMPTY_DUSTBIN,
)

LEGACY_SUPPORTED_LIFESPANS = (
    "main_brush",
    "side_brush",
    "filter",
)


class InstanceMode(StrEnum):
    """Instance mode."""

    CLOUD = "cloud"
    SELF_HOSTED = "self_hosted"
