"""Ecovacs constants."""

from enum import StrEnum

from deebot_client.commands import StationAction
from deebot_client.events import LifeSpan

DOMAIN = "ecovacs_deebot"

# 地图卡片前端资源（内置，无需手动添加 Lovelace 资源）
# 资源 URL 由 __init__.py 按文件内容哈希动态生成，自动破除浏览器缓存
CARD_STATIC_URL = "/ecovacs_deebot"
CARD_FILENAME = "t90-modern-map-card.js"
# 历史卡片文件名：注册新卡片时自动清理对应的旧 Lovelace 资源
CARD_LEGACY_FILENAMES = ("ecovacs-t90-map-card.js",)
DATA_STATIC_PATH_REGISTERED = "card_static_path_registered"
DATA_EXTRA_CARD_REGISTERED = "card_extra_js_registered"
# 本次加载实际注册的卡片 URL（含内容哈希），卸载时按同一 URL 摘除
DATA_CARD_URL = "card_module_url"

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
