"""Controller module."""

import asyncio
from collections.abc import Mapping
from functools import partial
import logging
import ssl
from typing import Any

from deebot_client.api_client import ApiClient, ApiDeviceInfo
from deebot_client.authentication import Authenticator, create_rest_config
from deebot_client.const import UNDEFINED, UndefinedType
from deebot_client.device import Device
from deebot_client.exceptions import (
    DeebotError,
    DeviceVerificationRequiredError,
    InvalidAuthenticationError,
)
from deebot_client.mqtt_client import MqttClient, create_mqtt_config
from deebot_client.models import DeviceInfo
from deebot_client.util import md5

from homeassistant.const import (
    CONF_COUNTRY,
    CONF_DEVICE_ID,
    CONF_PASSWORD,
    CONF_USERNAME,
)
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady
from homeassistant.helpers import aiohttp_client
from homeassistant.util.ssl import get_default_no_verify_context

from .const import (
    CONF_OVERRIDE_MQTT_URL,
    CONF_OVERRIDE_REST_URL,
    CONF_VERIFY_MQTT_CERTIFICATE,
)
from .hardware import get_bundled_static_device_info

_LOGGER = logging.getLogger(__name__)


class EcovacsController:
    """Ecovacs controller."""

    def __init__(self, hass: HomeAssistant, config: Mapping[str, Any]) -> None:
        """Initialize controller."""
        self._hass = hass
        self._devices: list[Device] = []
        rest_url = config.get(CONF_OVERRIDE_REST_URL)
        self._device_id = config[CONF_DEVICE_ID]
        country = config[CONF_COUNTRY]

        self._authenticator = Authenticator(
            create_rest_config(
                aiohttp_client.async_get_clientsession(self._hass),
                device_id=self._device_id,
                alpha_2_country=country,
                override_rest_url=rest_url,
            ),
            config[CONF_USERNAME],
            md5(config[CONF_PASSWORD]),
        )
        self._api_client = ApiClient(self._authenticator)

        mqtt_url = config.get(CONF_OVERRIDE_MQTT_URL)
        ssl_context: UndefinedType | ssl.SSLContext = UNDEFINED
        if not config.get(CONF_VERIFY_MQTT_CERTIFICATE, True) and mqtt_url:
            ssl_context = get_default_no_verify_context()

        self._mqtt_config_fn = partial(
            create_mqtt_config,
            device_id=self._device_id,
            country=country,
            override_mqtt_url=mqtt_url,
            ssl_context=ssl_context,
        )
        self._mqtt_client: MqttClient | None = None

    async def initialize(self) -> None:
        """Init controller."""
        try:
            devices = await self._api_client.get_devices()
            await self._authenticator.authenticate()

            # 官方机型库未收录、但本项目内置了机型定义的设备（如 jkzzec/T90 PRO 上下水款）
            # 会落在本库返回的 not_supported 列表里，这里用内置定义把它们"救回来"。
            rescued: list[DeviceInfo] = []
            still_not_supported: list[ApiDeviceInfo] = []
            for device_config in devices.not_supported:
                class_id = device_config.get("class")
                static_info = (
                    await get_bundled_static_device_info(class_id)
                    if class_id
                    else None
                )
                if static_info is not None:
                    _LOGGER.info(
                        'Device "%s" (class=%s) supported via bundled hardware definition',
                        device_config.get("deviceName"),
                        class_id,
                    )
                    rescued.append(DeviceInfo(device_config, static_info))
                else:
                    still_not_supported.append(device_config)

            if still_not_supported:
                for device_config in still_not_supported:
                    _LOGGER.warning(
                        (
                            'Device "%s" not supported. More information at '
                            "https://github.com/DeebotUniverse/client.py/issues/612: %s"
                        ),
                        device_config.get("deviceName"),
                        device_config,
                    )

            mqtt_devices = [*devices.mqtt, *rescued]

            # 云端偶发会返回同一台机器的多条记录（同 did 不同 resource/company），
            # 按 did 去重，避免生成重复设备/实体
            seen_dids: set[str] = set()
            deduped: list[DeviceInfo] = []
            for info in mqtt_devices:
                class_id = info.api.get("class")
                did = str(info.api.get("did", ""))

                if did and did in seen_dids:
                    _LOGGER.info(
                        "Duplicate device entry removed: did=%s name=%s class=%s",
                        did,
                        info.api.get("deviceName"),
                        class_id,
                    )
                    continue

                # 内置定义优先：只要本集成收录了该 class，就用内置定义覆盖官方库的定义，
                # 保证能力集完整（含地图），不再依赖容器内软链接指向哪个机型文件
                if class_id:
                    bundled = await get_bundled_static_device_info(class_id)
                    if bundled is not None:
                        info = DeviceInfo(info.api, bundled)
                        _LOGGER.info(
                            "Using bundled hardware definition for %s", class_id
                        )

                if did:
                    seen_dids.add(did)
                deduped.append(info)
                _LOGGER.info(
                    "Device discovered: did=%s name=%s class=%s company=%s map=%s",
                    did,
                    info.api.get("deviceName"),
                    class_id,
                    info.api.get("company"),
                    info.static.capabilities.map is not None,
                )

            if deduped:
                mqtt = await self._get_mqtt_client()
                built = [Device(info, self._authenticator) for info in deduped]
                async with asyncio.TaskGroup() as tg:

                    async def _init(device: Device) -> None:
                        """Initialize MQTT device."""
                        await device.initialize(mqtt)
                        self._devices.append(device)

                    for device in built:
                        tg.create_task(_init(device))

        except DeviceVerificationRequiredError as ex:
            raise ConfigEntryAuthFailed("Device verification required") from ex
        except InvalidAuthenticationError as ex:
            raise ConfigEntryAuthFailed("Invalid credentials") from ex
        except DeebotError as ex:
            raise ConfigEntryNotReady("Error during setup") from ex

        _LOGGER.debug("Controller initialize complete")

    async def teardown(self) -> None:
        """Disconnect controller."""
        for device in self._devices:
            await device.teardown()
        if self._mqtt_client is not None:
            await self._mqtt_client.disconnect()
        await self._authenticator.teardown()

    async def _get_mqtt_client(self) -> MqttClient:
        """Return validated MQTT client."""
        if self._mqtt_client is None:
            config = await self._hass.async_add_executor_job(self._mqtt_config_fn)
            mqtt = MqttClient(config, self._authenticator)
            await mqtt.verify_config()
            self._mqtt_client = mqtt

        return self._mqtt_client

    @property
    def devices(self) -> list[Device]:
        """Return devices."""
        return self._devices
