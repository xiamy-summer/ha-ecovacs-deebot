"""Ecovacs select entity module."""

from collections.abc import Callable
from dataclasses import dataclass
import logging
from typing import TYPE_CHECKING, Any, override

from deebot_client.capabilities import CapabilityMap, CapabilitySet, CapabilitySetTypes
from deebot_client.command import CommandWithMessageHandling
from deebot_client.device import Device
from deebot_client.events import WorkModeEvent, auto_empty
from deebot_client.events.base import Event
from deebot_client.events.map import CachedMapInfoEvent, MajorMapEvent
from deebot_client.events.water_info import WaterAmountEvent

from homeassistant.components.select import SelectEntity, SelectEntityDescription
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import EcovacsConfigEntry
from .entity import (
    EcovacsCapabilityEntityDescription,
    EcovacsDescriptionEntity,
    EcovacsEntity,
)
from .freeclean import FreeCleanError, assert_valid_value
from .t90_map import ScenariosEvent, T90FreeCleanV2, get_scenarios
from .util import get_name_key, get_supported_entities

_LOGGER = logging.getLogger(__name__)


@dataclass(kw_only=True, frozen=True)
class EcovacsSelectEntityDescription[EventT: Event](
    SelectEntityDescription,
    EcovacsCapabilityEntityDescription,
):
    """Ecovacs select entity description."""

    current_option_fn: Callable[[EventT], str | None]
    options_fn: Callable[[CapabilitySetTypes], list[str]]
    set_option_fn: Callable[[CapabilitySetTypes, str], CommandWithMessageHandling] = (
        lambda cap, option: cap.set(option)
    )


ENTITY_DESCRIPTIONS: tuple[EcovacsSelectEntityDescription, ...] = (
    EcovacsSelectEntityDescription[WaterAmountEvent](
        capability_fn=lambda caps: (
            caps.water.amount
            if caps.water and isinstance(caps.water.amount, CapabilitySetTypes)
            else None
        ),
        current_option_fn=lambda e: get_name_key(e.value),
        options_fn=lambda water: [get_name_key(amount) for amount in water.types],
        key="water_amount",
        translation_key="water_amount",
        entity_category=EntityCategory.CONFIG,
    ),
    EcovacsSelectEntityDescription[WorkModeEvent](
        capability_fn=lambda caps: caps.clean.work_mode,
        current_option_fn=lambda e: get_name_key(e.mode),
        options_fn=lambda cap: [get_name_key(mode) for mode in cap.types],
        key="work_mode",
        translation_key="work_mode",
        entity_registry_enabled_default=False,
        entity_category=EntityCategory.CONFIG,
    ),
    EcovacsSelectEntityDescription[auto_empty.AutoEmptyEvent](
        capability_fn=lambda caps: caps.station.auto_empty if caps.station else None,
        current_option_fn=lambda e: get_name_key(e.frequency) if e.frequency else None,
        options_fn=lambda cap: [get_name_key(freq) for freq in cap.types],
        set_option_fn=lambda cap, option: cap.set(None, option),
        key="auto_empty",
        translation_key="auto_empty",
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: EcovacsConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Add entities for passed config_entry in HA."""
    controller = config_entry.runtime_data
    entities = get_supported_entities(
        controller, EcovacsSelectEntity, ENTITY_DESCRIPTIONS
    )
    entities.extend(
        EcovacsActiveMapSelectEntity(device, device.capabilities.map)
        for device in controller.devices
        if (map_cap := device.capabilities.map)
        and isinstance(map_cap.major, CapabilitySet)
    )
    # 清洁场景选择实体（App 快捷指令重放）
    entities.extend(
        EcovacsScenarioSelectEntity(device)
        for device in controller.devices
        if device.capabilities.map
    )
    if entities:
        async_add_entities(entities)


class EcovacsSelectEntity[EventT: Event](
    EcovacsDescriptionEntity[CapabilitySetTypes[EventT, [str], str]],
    SelectEntity,
):
    """Ecovacs select entity."""

    _attr_current_option: str | None = None
    entity_description: EcovacsSelectEntityDescription

    def __init__(
        self,
        device: Device,
        capability: CapabilitySetTypes[EventT, [str], str],
        entity_description: EcovacsSelectEntityDescription,
        **kwargs: Any,
    ) -> None:
        """Initialize entity."""
        super().__init__(device, capability, entity_description, **kwargs)
        self._attr_options = entity_description.options_fn(capability)

    @override
    async def async_added_to_hass(self) -> None:
        """Set up the event listeners now that hass is ready."""
        await super().async_added_to_hass()

        async def on_event(event: EventT) -> None:
            if (option := self.entity_description.current_option_fn(event)) is not None:
                self._attr_current_option = option
                self.async_write_ha_state()

        self._subscribe(self._capability.event, on_event)

    @override
    async def async_select_option(self, option: str) -> None:
        """Change the selected option."""
        await self._device.execute_command(
            self.entity_description.set_option_fn(self._capability, option)
        )


class EcovacsActiveMapSelectEntity(
    EcovacsEntity[CapabilityMap],
    SelectEntity,
):
    """Ecovacs active map select entity."""

    entity_description = SelectEntityDescription(
        key="active_map",
        translation_key="active_map",
        entity_category=EntityCategory.CONFIG,
    )

    def __init__(
        self,
        device: Device,
        capability: CapabilityMap,
        **kwargs: Any,
    ) -> None:
        """Initialize entity."""
        super().__init__(device, capability, **kwargs)
        self._option_to_id: dict[str, str] = {}
        self._id_to_option: dict[str, str] = {}

        self._handle_on_cached_map(
            device.events.get_last_event(CachedMapInfoEvent)
            or CachedMapInfoEvent(set())
        )

    def _handle_on_cached_map(self, event: CachedMapInfoEvent) -> None:
        self._id_to_option.clear()
        self._option_to_id.clear()

        for map_info in event.maps:
            name = map_info.name or map_info.id
            self._id_to_option[map_info.id] = name
            self._option_to_id[name] = map_info.id

            if map_info.using:
                self._attr_current_option = name

        if self._attr_current_option not in self._option_to_id:
            self._attr_current_option = None

        # Sort named maps first, then numeric IDs
        # (unnamed maps during building) in ascending order.
        self._attr_options = sorted(
            self._option_to_id.keys(), key=lambda x: (x.isdigit(), x.lower())
        )

    @override
    async def async_added_to_hass(self) -> None:
        """Set up the event listeners now that hass is ready."""
        await super().async_added_to_hass()

        async def on_cached_map(event: CachedMapInfoEvent) -> None:
            self._handle_on_cached_map(event)
            self.async_write_ha_state()

        self._subscribe(self._capability.cached_info.event, on_cached_map)

        async def on_major_map(event: MajorMapEvent) -> None:
            self._attr_current_option = self._id_to_option.get(event.map_id)
            self.async_write_ha_state()

        self._subscribe(self._capability.major.event, on_major_map)

    @override
    async def async_select_option(self, option: str) -> None:
        """Change the selected option."""
        if TYPE_CHECKING:
            assert isinstance(self._capability.major, CapabilitySet)
        await self._device.execute_command(
            self._capability.major.set(self._option_to_id[option])
        )


class EcovacsScenarioSelectEntity(EcovacsEntity[None], SelectEntity):
    """清洁场景选择实体：列出 App 快捷指令，选择即重放。"""

    _always_available = True

    _PLACEHOLDER = "点击选择场景…"

    entity_description = SelectEntityDescription(
        key="clean_scenario",
        translation_key="clean_scenario",
        icon="mdi:bookmark-music-outline",
        entity_category=EntityCategory.CONFIG,
    )

    def __init__(self, device: Device, **kwargs: Any) -> None:
        """Initialize entity."""
        super().__init__(device, None, **kwargs)
        self._scenarios: tuple[dict[str, Any], ...] = get_scenarios(device.events)
        self._sync_options()
        # 常驻占位选项，避免实体状态显示 unknown
        self._attr_current_option = self._PLACEHOLDER

    def _sync_options(self) -> None:
        names = [str(item["name"]) for item in self._scenarios]
        self._attr_options = [self._PLACEHOLDER, *names]

    @override
    async def async_added_to_hass(self) -> None:
        """Set up the event listeners now that hass is ready."""
        await super().async_added_to_hass()

        async def on_scenarios(event: ScenariosEvent) -> None:
            self._scenarios = event.scenarios
            self._sync_options()
            if self._attr_current_option not in self._attr_options:
                self._attr_current_option = self._PLACEHOLDER
            self.async_write_ha_state()

        self._subscribe(ScenariosEvent, on_scenarios)

    @override
    async def async_select_option(self, option: str) -> None:
        """Replay the selected scenario on the device."""
        if option == self._PLACEHOLDER:
            return
        entry = next(
            (item for item in self._scenarios if str(item["name"]) == option),
            None,
        )
        # 场景重放不是持久状态，执行后回到占位项
        self._attr_current_option = self._PLACEHOLDER
        self.async_write_ha_state()
        if entry is None:
            _LOGGER.warning("Scenario %s not found, skipping", option)
            return
        # 场景内容来自固件自身（国行格式可能是 7/10/20 字段等变体，
        # 未必符合 9 字段规范），校验失败时原样下发即可
        try:
            value = assert_valid_value(entry["content"])
        except FreeCleanError as error:
            _LOGGER.info(
                "Scenario %s content not 9-field standard, sending as-is: %s",
                option,
                error,
            )
            value = entry["content"]
        await self._device.execute_command(T90FreeCleanV2(value))
