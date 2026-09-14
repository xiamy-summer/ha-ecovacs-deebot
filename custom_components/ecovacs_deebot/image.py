"""Ecovacs image entities."""

from typing import cast, override

from deebot_client.capabilities import CapabilityMap
from deebot_client.device import Device
from deebot_client.events import RoomsEvent
from deebot_client.events.map import CachedMapInfoEvent, MapChangedEvent
from deebot_client.map import Map

from homeassistant.components.image import ImageEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import EntityDescription
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import EcovacsConfigEntry
from .entity import EcovacsEntity
from .t90_map import add_room_metadata_to_svg


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: EcovacsConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Add entities for passed config_entry in HA."""
    controller = config_entry.runtime_data
    entities = [
        EcovacsMap(device, caps, hass)
        for device in controller.devices
        if (caps := device.capabilities.map)
    ]

    if entities:
        async_add_entities(entities)


class EcovacsMap(
    EcovacsEntity[CapabilityMap],
    ImageEntity,
):
    """Ecovacs map."""

    _attr_content_type = "image/svg+xml"

    def __init__(
        self,
        device: Device,
        capability: CapabilityMap,
        hass: HomeAssistant,
    ) -> None:
        """Initialize entity."""
        super().__init__(device, capability, hass=hass)
        self._attr_extra_state_attributes = {}
        self._map = cast(Map, self._device.map)

    entity_description = EntityDescription(
        key="map",
        translation_key="map",
    )

    @override
    def image(self) -> bytes | None:
        """Return bytes of image or None."""
        if svg := self._map.get_svg_map():
            # T90 中国区固件：为 SVG 叠加房间名称标签与选区元数据（地图卡片用）
            svg = add_room_metadata_to_svg(
                svg,
                self._map._event_bus,
                self._map._map_data._rotation,
            )
            return svg.encode()

        return None

    @override
    async def async_added_to_hass(self) -> None:
        """Set up the event listeners now that hass is ready."""
        await super().async_added_to_hass()

        async def on_info(event: CachedMapInfoEvent) -> None:
            for map_obj in event.maps:
                if map_obj.using:
                    self._attr_extra_state_attributes["map_name"] = map_obj.name

        async def on_changed(event: MapChangedEvent) -> None:
            self._attr_image_last_updated = event.when
            self.async_write_ha_state()

        async def on_rooms(event: RoomsEvent) -> None:
            # 把设备端房间表（顺序即固件/App 的房间顺序，且包含全部房间）
            # 暴露给卡片：地图卡片用它生成"全屋清扫顺序"列表的默认顺序。
            # 注意：从 SVG 解析房间只能拿到有路径的房间，顺序也未必一致。
            seen: set[int] = set()
            rooms: list[dict[str, object]] = []
            for room in event.rooms:
                try:
                    room_id = int(room.id)
                except (TypeError, ValueError):
                    continue
                if room_id in seen:
                    continue
                seen.add(room_id)
                rooms.append({"id": room_id, "name": str(room.name).strip()})
            self._attr_extra_state_attributes["rooms"] = rooms
            self.async_write_ha_state()

        self._subscribe(self._capability.cached_info.event, on_info)
        self._subscribe(self._capability.changed.event, on_changed)
        self._subscribe(RoomsEvent, on_rooms)

    @override
    async def async_update(self) -> None:
        """Update the entity.

        Only used by the generic entity update service.
        """
        await super().async_update()
        self._map.refresh()
