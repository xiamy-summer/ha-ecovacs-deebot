"""Support for Ecovacs Ecovacs Vacuums."""

from collections.abc import Mapping
import logging
from typing import TYPE_CHECKING, Any, override

from deebot_client.capabilities import Capabilities, DeviceType
from deebot_client.device import Device
from deebot_client.events import (
    CachedMapInfoEvent,
    FanSpeedEvent,
    RoomsEvent,
    StateEvent,
)
from deebot_client.events.map import Map
from deebot_client.commands.json.clean_count import SetCleanCount
from deebot_client.commands.json.custom import CustomCommand
from deebot_client.commands.json.fan_speed import SetFanSpeed
from deebot_client.commands.json.water_info import SetWaterInfo
from deebot_client.commands.json.work_mode import SetWorkMode
from deebot_client.events import FanSpeedLevel, WorkMode
from deebot_client.models import CleanAction, CleanMode, State

from homeassistant.components.vacuum import (
    Segment,
    StateVacuumEntity,
    StateVacuumEntityDescription,
    VacuumActivity,
    VacuumEntityFeature,
)
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.util import slugify

from . import EcovacsConfigEntry
from .const import DOMAIN
from .entity import EcovacsEntity
from .freeclean import FreeCleanError, assert_valid_value
from .t90_map import GetQuickCommandT90, T90FreeCleanV2, get_scenarios
from .util import get_name_key

_LOGGER = logging.getLogger(__name__)
_SEGMENTS_SEPARATOR = "_"

# spot_area 扩展参数 → 全局设置命令的取值映射。
# 吸力：FanSpeedLevel（1000=安静 0=标准 1=强力 2=强力+）。
_SUCTION_TO_FAN_SPEED = {
    "quiet": FanSpeedLevel.QUIET,
    "normal": FanSpeedLevel.NORMAL,
    "standard": FanSpeedLevel.NORMAL,
    "max": FanSpeedLevel.MAX,
    "strong": FanSpeedLevel.MAX,
    "max_plus": FanSpeedLevel.MAX_PLUS,
}
# 模式：WorkMode（0=边扫边拖 1=扫地 2=只拖 3=先扫后拖）。
_MOP_TYPE_TO_WORK_MODE = {
    "vacuum": WorkMode.VACUUM,
    "mop": WorkMode.MOP,
    "vacuum_and_mop": WorkMode.VACUUM_AND_MOP,
    "mop_after_vacuum": WorkMode.MOP_AFTER_VACUUM,
}
# 清洁效率 → setCustomAreaMode sweepMode（T30 社区逆向：0=标准 1=深度 2=快速）。
_EFFICIENCY_TO_SWEEP_MODE = {
    "standard": 0,
    "deep": 1,
    "fast": 2,
}

ATTR_ERROR = "error"


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: EcovacsConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the Ecovacs vacuums."""

    controller = config_entry.runtime_data
    vacuums: list[EcovacsVacuum] = [
        EcovacsVacuum(device)
        for device in controller.devices
        if device.capabilities.device_type is DeviceType.VACUUM
    ]
    _LOGGER.debug("Adding Ecovacs Vacuums to Home Assistant: %s", vacuums)
    async_add_entities(vacuums)


_STATE_TO_VACUUM_STATE = {
    State.IDLE: VacuumActivity.IDLE,
    State.CLEANING: VacuumActivity.CLEANING,
    State.RETURNING: VacuumActivity.RETURNING,
    State.DOCKED: VacuumActivity.DOCKED,
    State.ERROR: VacuumActivity.ERROR,
    State.PAUSED: VacuumActivity.PAUSED,
}

_ATTR_ROOMS = "rooms"


class EcovacsVacuum(
    EcovacsEntity[Capabilities],
    StateVacuumEntity,
):
    """Ecovacs vacuum."""

    _unrecorded_attributes = frozenset({_ATTR_ROOMS})

    _attr_supported_features = (
        VacuumEntityFeature.PAUSE
        | VacuumEntityFeature.STOP
        | VacuumEntityFeature.RETURN_HOME
        | VacuumEntityFeature.SEND_COMMAND
        | VacuumEntityFeature.LOCATE
        | VacuumEntityFeature.STATE
        | VacuumEntityFeature.START
    )

    entity_description = StateVacuumEntityDescription(
        key="vacuum", translation_key="vacuum", name=None
    )

    def __init__(self, device: Device) -> None:
        """Initialize the vacuum."""
        super().__init__(device, device.capabilities)

        self._room_event: RoomsEvent | None = None
        self._maps: dict[str, Map] = {}

        if fan_speed := self._capability.fan_speed:
            self._attr_supported_features |= VacuumEntityFeature.FAN_SPEED
            self._attr_fan_speed_list = [
                get_name_key(level) for level in fan_speed.types
            ]

        if self._capability.map and self._capability.clean.action.area:
            self._attr_supported_features |= VacuumEntityFeature.CLEAN_AREA

    @override
    async def async_added_to_hass(self) -> None:
        """Set up the event listeners now that hass is ready."""
        await super().async_added_to_hass()

        async def on_status(event: StateEvent) -> None:
            self._attr_activity = _STATE_TO_VACUUM_STATE[event.state]
            self.async_write_ha_state()

        self._subscribe(self._capability.state.event, on_status)

        if self._capability.fan_speed:

            async def on_fan_speed(event: FanSpeedEvent) -> None:
                self._attr_fan_speed = get_name_key(event.speed)
                self.async_write_ha_state()

            self._subscribe(self._capability.fan_speed.event, on_fan_speed)

        if map_caps := self._capability.map:

            async def on_rooms(event: RoomsEvent) -> None:
                self._room_event = event
                self._check_segments_changed()
                self.async_write_ha_state()

            self._subscribe(map_caps.rooms.event, on_rooms)

            async def on_map_info(event: CachedMapInfoEvent) -> None:
                self._maps = {map_obj.id: map_obj for map_obj in event.maps}
                self._check_segments_changed()

            self._subscribe(map_caps.cached_info.event, on_map_info)

    @property
    @override
    def extra_state_attributes(self) -> Mapping[str, Any] | None:
        """Return entity specific state attributes.

        Implemented by platform classes. Convention for attribute names
        is lowercase snake_case.
        """
        rooms: dict[str, Any] = {}
        if self._room_event is None:
            return rooms

        for room in self._room_event.rooms:
            # convert room name to snake_case to meet the convention
            room_name = slugify(room.name)
            room_values = rooms.get(room_name)
            if room_values is None:
                rooms[room_name] = room.id
            elif isinstance(room_values, list):
                room_values.append(room.id)
            else:
                # Convert from int to list
                rooms[room_name] = [room_values, room.id]

        return {
            _ATTR_ROOMS: rooms,
        }

    @override
    async def async_set_fan_speed(self, fan_speed: str, **kwargs: Any) -> None:
        """Set fan speed."""
        if TYPE_CHECKING:
            assert self._capability.fan_speed
        await self._device.execute_command(self._capability.fan_speed.set(fan_speed))

    @override
    async def async_return_to_base(self, **kwargs: Any) -> None:
        """Set the vacuum cleaner to return to the dock."""
        await self._device.execute_command(self._capability.charge.execute())

    @override
    async def async_stop(self, **kwargs: Any) -> None:
        """Stop the vacuum cleaner."""
        await self._clean_command(CleanAction.STOP)

    @override
    async def async_pause(self) -> None:
        """Pause the vacuum cleaner."""
        await self._clean_command(CleanAction.PAUSE)

    @override
    async def async_start(self) -> None:
        """Start the vacuum cleaner."""
        await self._clean_command(CleanAction.START)

    async def _clean_command(self, action: CleanAction) -> None:
        await self._device.execute_command(
            self._capability.clean.action.command(action)
        )

    @override
    async def async_locate(self, **kwargs: Any) -> None:
        """Locate the vacuum cleaner."""
        await self._device.execute_command(self._capability.play_sound.execute())

    @override
    async def async_send_command(
        self,
        command: str,
        params: dict[str, Any] | list[Any] | None = None,
        **kwargs: Any,
    ) -> None:
        """Send a command to a vacuum cleaner."""
        _LOGGER.debug("async_send_command %s with %s", command, params)
        if params is None:
            params = {}
        elif isinstance(params, list):
            raise ServiceValidationError(
                translation_domain=DOMAIN,
                translation_key="vacuum_send_command_params_dict",
            )

        if command == "agent_clean":
            # AI 智能托管（App 报文实测，jkzzec 1.103.0）：
            # App 切换「AI 智能托管」开关下发 setSwitchState {"agentClean": 1|0}；
            # 开启后由设备端按房间类型/地面材质自主生成吸力/水量等参数，
            # 全屋清洁走 Clean(START) 通道，不下发任何参数。
            # 注意：getCleanPreference 在该固件上为 20003 rcp not support，
            # 托管开关不是 clean.preference，而是 switchState.agentClean。
            enable = params.get("enable", True)
            await self._device.execute_command(
                CustomCommand("setSwitchState", {"agentClean": 1 if enable else 0})
            )
            if enable:
                await self._clean_command(CleanAction.START)
            return

        if command in ["spot_area", "custom_area"]:
            if params is None:
                raise ServiceValidationError(
                    translation_domain=DOMAIN,
                    translation_key="vacuum_send_command_params_required",
                    translation_placeholders={"command": command},
                )
            if self._capability.clean.action.area is None:
                info = self._device.device_info
                name = info.get("nick", info["name"])
                raise ServiceValidationError(
                    translation_domain=DOMAIN,
                    translation_key="vacuum_send_command_not_supported",
                    translation_placeholders={"command": command, "name": name},
                )

            if command == "spot_area":
                # 可选扩展参数：吸力/水量/拖地模式/清洁效率/次数。
                #
                # 1.103.0 固件实测（jkzzec）：freeClean 9 字段扩展格式下发成功
                # （code 0），但固件任务队列 clean_para 记录的全是全局默认值——
                # 新固件已不解析 9 字段的参数位（仅房间 ID 有效）。
                # 因此对齐 App 行为：先发全局设置命令（setSpeed/setWorkMode/
                # setWaterInfo/setCustomAreaMode/setCleanCount），再发
                # freeClean 短格式（仅房间 ID）。
                suction = params.get("suction")
                water = params.get("water")
                mop_type = params.get("mop_type")
                efficiency = params.get("efficiency")
                passes = int(params.get("passes", 1) or 1)

                room_ids: list[int] = []
                for item in params["rooms"]:
                    # 字典形式（每房间独立参数）已不支持——新固件参数走全局
                    # 设置命令，无任务级参数位；仅提取 id。
                    room_ids.append(
                        int(item["id"]) if isinstance(item, dict) else int(item)
                    )

                commands: list[Any] = []
                if suction:
                    commands.append(SetFanSpeed(_SUCTION_TO_FAN_SPEED[suction]))
                if mop_type:
                    commands.append(SetWorkMode(_MOP_TYPE_TO_WORK_MODE[mop_type]))
                if water is not None:
                    commands.append(SetWaterInfo(custom_amount=int(water)))
                if efficiency:
                    # 清洁效率（快速/标准/深度）：协议名 setCustomAreaMode，
                    # sweepMode 取值来自 T30 社区逆向（0=标准 1=深度 2=快速），
                    # deebot_client 未建模，用 CustomCommand 下发。
                    commands.append(
                        CustomCommand(
                            "setCustomAreaMode",
                            {"sweepMode": _EFFICIENCY_TO_SWEEP_MODE[efficiency]},
                        )
                    )
                if passes != 1:
                    commands.append(SetCleanCount(passes))
                commands.append(
                    T90FreeCleanV2(";".join(f"1,{rid}" for rid in room_ids))
                )
                for cmd in commands:
                    await self._device.execute_command(cmd)
                return
                await self._device.execute_command(
                    self._capability.clean.action.area(
                        CleanMode.SPOT_AREA,
                        params["rooms"],
                        params.get("cleanings", 1),
                    )
                )
            elif command == "custom_area":
                await self._device.execute_command(
                    self._capability.clean.action.area(
                        CleanMode.CUSTOM_AREA,
                        params["coordinates"],
                        params.get("cleanings", 1),
                    )
                )
        else:
            await self._device.execute_command(
                self._capability.custom.set(command, params)
            )

    async def async_raw_get_positions(
        self,
    ) -> dict[str, Any]:
        """Get bot and chargers positions."""
        _LOGGER.debug("async_raw_get_positions")

        if not (map_cap := self._capability.map) or not (
            position_commands := map_cap.position.get
        ):
            raise ServiceValidationError(
                translation_domain=DOMAIN,
                translation_key="vacuum_raw_get_positions_not_supported",
            )

        return await self._device.execute_command(position_commands[0])

    async def async_get_scenarios(self) -> list[dict[str, Any]]:
        """Fetch App quick commands (clean scenarios) from the device."""
        _LOGGER.debug("async_get_scenarios")
        await self._device.execute_command(GetQuickCommandT90())
        return list(get_scenarios(self._device.events))

    async def async_run_scenario(self, scenario: str) -> None:
        """Replay a saved App quick command by name or qcid."""
        scenarios = get_scenarios(self._device.events)
        entry = next(
            (
                item
                for item in scenarios
                if item["name"] == scenario or str(item["qcid"]) == scenario
            ),
            None,
        )
        if entry is None:
            # 缓存未命中时先刷新一次场景列表再重试
            scenarios = await self.async_get_scenarios()
            entry = next(
                (
                    item
                    for item in scenarios
                    if item["name"] == scenario or str(item["qcid"]) == scenario
                ),
                None,
            )
        if entry is None:
            raise ServiceValidationError(
                translation_domain=DOMAIN,
                translation_key="vacuum_scenario_not_found",
                translation_placeholders={"scenario": scenario},
            )

        # 场景内容来自固件自身（国行格式可能是字段数变体），校验失败时原样下发
        try:
            value = assert_valid_value(entry["content"])
        except FreeCleanError as error:
            _LOGGER.info(
                "Scenario %r content not 9-field standard, sending as-is: %s",
                scenario,
                error,
            )
            value = entry["content"]

        await self._device.execute_command(T90FreeCleanV2(value))

    @callback
    def _check_segments_changed(self) -> None:
        """Check if segments have changed and create repair issue."""
        last_seen = self.last_seen_segments
        if last_seen is None:
            return

        last_seen_ids = {seg.id for seg in last_seen}
        current_ids = {seg.id for seg in self._get_segments()}

        if current_ids != last_seen_ids:
            self.async_create_segments_issue()

    def _get_segments(self) -> list[Segment]:
        """Get the segments that can be cleaned."""
        last_seen = self.last_seen_segments or []
        if self._room_event is None or not self._maps:
            # If we don't have the necessary information to
            # determine segments, return the last seen segments to
            # avoid temporarily losing all segments until we get
            # the necessary information, which could cause
            # unnecessary issues to be created
            return last_seen

        map_id = self._room_event.map_id
        if (map_obj := self._maps.get(map_id)) is None:
            _LOGGER.warning("Map ID %s not found in available maps", map_id)
            return []

        id_prefix = f"{map_id}{_SEGMENTS_SEPARATOR}"
        other_map_ids = {
            map_obj.id
            for map_obj in self._maps.values()
            if map_obj.id != self._room_event.map_id
        }
        # Include segments from the current map and any segments
        # from other maps that were previously seen, as we want
        # to continue showing segments from other maps for
        # mapping purposes
        segments = [
            seg for seg in last_seen if _split_composite_id(seg.id)[0] in other_map_ids
        ]
        segments.extend(
            Segment(
                id=f"{id_prefix}{room.id}",
                name=room.name,
                group=map_obj.name,
            )
            for room in self._room_event.rooms
        )
        return segments

    @override
    async def async_get_segments(self) -> list[Segment]:
        """Get the segments that can be cleaned."""
        return self._get_segments()

    @override
    async def async_clean_segments(self, segment_ids: list[str], **kwargs: Any) -> None:
        """Perform an area clean.

        Only cleans segments from the currently selected map.
        """
        if not self._maps:
            _LOGGER.warning("No map information available, cannot clean segments")
            return

        valid_room_ids: list[int | float] = []
        for composite_id in segment_ids:
            map_id, segment_id = _split_composite_id(composite_id)
            if (map_obj := self._maps.get(map_id)) is None:
                _LOGGER.warning("Map ID %s not found in available maps", map_id)
                continue

            if not map_obj.using:
                room_name = next(
                    (
                        segment.name
                        for segment in self.last_seen_segments or []
                        if segment.id == composite_id
                    ),
                    "",
                )
                _LOGGER.warning(
                    'Map "%s" is not currently selected, skipping segment "%s" (%s)',
                    map_obj.name,
                    room_name,
                    segment_id,
                )
                continue

            valid_room_ids.append(int(segment_id))

        if not valid_room_ids:
            _LOGGER.warning(
                "No valid segments to clean after validation,"
                " skipping clean segments command"
            )
            return

        if TYPE_CHECKING:
            # Supported feature is only added if clean.action.area is not None
            assert self._capability.clean.action.area is not None

        await self._device.execute_command(
            self._capability.clean.action.area(
                CleanMode.SPOT_AREA,
                valid_room_ids,
                1,
            )
        )


@callback
def _split_composite_id(composite_id: str) -> tuple[str, str]:
    """Split a composite ID into its components."""
    map_id, _, segment_id = composite_id.partition(_SEGMENTS_SEPARATOR)
    return map_id, segment_id
