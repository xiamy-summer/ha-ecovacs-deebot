"""T90 Pro 中国区固件地图协议兼容命令。

Portions of this module are ported from:
  https://github.com/lifujie25/ha-ecovacs-t90-pro
  (custom_components/ecovacs_t90_patch/map.py, GPL-3.0)
  Copyright (c) lifujie25

Additional protocol knowledge (freeClean 9-field format, getQuickCommand
scenarios, zstd subsets fallback) ported from:
  https://github.com/Osezno-byte/ecovacs-omni-ha (MIT License)
  Copyright (c) Osezno-byte

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, version 3 of the License.

针对中国区 T90 系固件的差异：
- 使用复合命令 ``getInfo``（getCachedMapInfo + getRobotState + getWorkState）
  作为地图引导入口，并联动触发地图集/位置/房间/场景刷新；
- 房间子集使用中国区固件的 12 字段格式（官方库只识别 10/11 字段），
  并支持 base64+zstd 压缩 subsets 的回退解析（其他机型/固件变体）；
- 位置查询使用 ``getPos_V2``（带 mid 参数）；
- 旧版 ``getMajorMap`` 命令不受支持，不下发；
- 场景（快捷指令）通过 ``getQuickCommand`` 发现，可原样重放。
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from html import escape
import json
import re
from typing import TYPE_CHECKING, Any
from weakref import WeakKeyDictionary

from deebot_client.commands.json.common import JsonCommandWithMessageHandling
from deebot_client.commands.json.clean import CleanAreaV2, CleanV2
from deebot_client.commands.json.map import GetMapSetV2
from deebot_client.commands.json.pos import GetPos
from deebot_client.events import MapSetType, RoomsEvent
from deebot_client.events.base import Event
from deebot_client.message import (
    HandlingResult,
    HandlingState,
    MessageBodyDataDict,
    MessageBodyDataList,
)
from deebot_client.messages.json.map.cached_map_info import OnCachedMapInfo
from deebot_client.models import CleanAction, CleanMode, Room
from deebot_client.rs.map import RotationAngle

if TYPE_CHECKING:
    from deebot_client.event_bus import EventBus

try:  # zstd 房间解析回退为可选能力，缺少依赖时静默降级
    import zstandard as _zstandard
except ImportError:  # pragma: no cover
    _zstandard = None

_ZSTD_MAX_OUTPUT = 1 << 20


@dataclass(frozen=True)
class T90Room:
    """房间元数据：用于地图标签与交互式选区。"""

    id: int
    name: str
    x: float
    y: float


_ROOMS: WeakKeyDictionary[EventBus, tuple[T90Room, ...]] = WeakKeyDictionary()
_SCENARIOS: WeakKeyDictionary[EventBus, tuple[dict[str, Any], ...]] = WeakKeyDictionary()
_ROOM_PATH_RE = re.compile(r"(?:^|\s)r\d+(?:\s|$)")


@dataclass(frozen=True)
class ScenariosEvent(Event):
    """App 快捷指令（清洁场景）列表更新事件。"""

    scenarios: tuple[dict[str, Any], ...] = ()


def get_scenarios(event_bus: EventBus) -> tuple[dict[str, Any], ...]:
    """Return the last known App quick commands for this device."""
    return _SCENARIOS.get(event_bus, ())


def _decode_zstd_subsets(subsets: str) -> list[list[Any]] | None:
    """Decode a base64+zstd ``subsets`` blob (non-China firmware variant).

    解压后为 JSON 数组，每行代表一个房间：
    ``[id, name, roomType, neighborIds, <未知>, x, y, ...]``
    """
    if _zstandard is None:
        return None
    try:
        raw = base64.b64decode(subsets)
        rows = _zstandard.ZstdDecompressor().decompress(
            raw, max_output_size=_ZSTD_MAX_OUTPUT
        )
        decoded = json.loads(rows)
    except Exception:  # noqa: BLE001 - 固件变体差异多，全部静默降级
        return None
    if isinstance(decoded, list) and all(isinstance(row, list) for row in decoded):
        return decoded
    return None


def _rotate_point(x: float, y: float, rotation: RotationAngle) -> tuple[float, float]:
    """Apply the same coordinate transform as deebot-client's SVG renderer."""
    if rotation == RotationAngle.DEG_90:
        return y / 50, x / 50
    if rotation == RotationAngle.DEG_180:
        return -x / 50, y / 50
    if rotation == RotationAngle.DEG_270:
        return -y / 50, -x / 50
    return x / 50, -y / 50


def add_room_metadata_to_svg(
    svg: str, event_bus: EventBus, rotation: RotationAngle
) -> str:
    """Add room names and selection metadata to a generated SVG map."""
    rooms = _ROOMS.get(event_bus)
    if not rooms or 'id="t90-room-labels"' in svg:
        return svg

    room_paths = []
    for match in re.finditer(r"<path\b[^>]*>", svg):
        tag = match.group(0)
        class_match = re.search(r'class="([^"]*)"', tag)
        if class_match and _ROOM_PATH_RE.search(class_match.group(1)):
            room_paths.append(match)

    # MapInfo V2 按房间 ID 顺序输出房间路径；多余的彩色路径属于新图层，
    # 因此每个房间只标注第一个匹配的 path。
    annotated = svg
    offset = 0
    for path_match, room in zip(room_paths, sorted(rooms, key=lambda entry: entry.id)):
        metadata = (
            f' data-room-id="{room.id}" data-room-name="{escape(room.name)}"'
            ' class="t90-room '
        )
        original = path_match.group(0)
        replacement = original.replace('class="', metadata, 1)
        start = path_match.start() + offset
        end = path_match.end() + offset
        annotated = annotated[:start] + replacement + annotated[end:]
        offset += len(replacement) - len(original)

    labels = []
    for room in rooms:
        x, y = _rotate_point(room.x, room.y, rotation)
        label = escape(room.name)
        width = max(16, len(room.name) * 5 + 7)
        labels.append(
            f'<g class="t90-room-label" data-room-id="{room.id}" '
            f'data-room-name="{escape(room.name)}" '
            f'transform="translate({x:.2f} {y:.2f})">'
            f'<rect x="{-width / 2:.2f}" y="-4.5" width="{width}" height="9" '
            'rx="2.5"/>'
            f'<text y="1.8">{label}</text></g>'
        )

    overlay = (
        '<g id="t90-room-labels">' + "".join(labels) + '</g><style id="t90-room-style">'
        ".t90-room{cursor:pointer;transition:filter .15s,stroke .15s}"
        ".t90-room:hover{filter:brightness(.92)}"
        ".t90-room.t90-selected{stroke:#1677ff;stroke-width:3}"
        ".t90-room-label{cursor:pointer;pointer-events:auto}"
        ".t90-room-label.t90-selected rect{fill:#dbeafe;stroke:#1677ff;stroke-width:1}"
        ".t90-room-label rect{fill:#fff;fill-opacity:.88;stroke:#64748b;stroke-width:.35}"
        ".t90-room-label text{fill:#1f2937;font-family:sans-serif;font-size:5px;"
        "font-weight:600;text-anchor:middle}"
        "</style>"
    )
    return annotated.replace("</svg>", f"{overlay}</svg>")


class GetMapSetV2T90(GetMapSetV2):
    """解析中国区 T90 固件的 12 字段房间格式（含 zstd 压缩回退）。"""

    @classmethod
    def _notify_rooms(
        cls,
        event_bus: EventBus,
        map_id: str,
        rooms: tuple[T90Room, ...],
    ) -> None:
        _ROOMS[event_bus] = rooms
        event_bus.notify(
            RoomsEvent(
                map_id,
                [Room(room.name, room.id, f"{room.x},{room.y}") for room in rooms],
            ),
        )

    @classmethod
    def _handle_rooms_subsets(
        cls,
        event_bus: EventBus,
        data: dict[str, Any],
        subsets: list[list[str]] | str,
        map_id: str,
    ) -> HandlingResult:
        if isinstance(subsets, str) and subsets:
            # 其他固件变体：subsets 为 base64+zstd 压缩 blob
            if (rows := _decode_zstd_subsets(subsets)) and all(
                len(row) >= 7 for row in rows
            ):
                rooms = tuple(
                    T90Room(
                        id=int(row[0]),
                        name=str(row[1]).strip() or f"区域 {row[0]}",
                        x=float(row[5]),
                        y=float(row[6]),
                    )
                    for row in rows
                )
                cls._notify_rooms(event_bus, map_id, rooms)
                return HandlingResult.success()
            return super()._handle_rooms_subsets(event_bus, data, subsets, map_id)

        if subsets and all(len(subset) >= 7 for subset in subsets):
            rooms = tuple(
                T90Room(
                    id=int(subset[0]),
                    name=subset[1].strip() or f"区域 {subset[0]}",
                    x=float(subset[5]),
                    y=float(subset[6]),
                )
                for subset in subsets
            )
            cls._notify_rooms(event_bus, map_id, rooms)
            return HandlingResult.success()

        return super()._handle_rooms_subsets(event_bus, data, subsets, map_id)


class GetPosV2(GetPos):
    """获取 T90 地图上的机器人与充电座位置。"""

    NAME = "getPos_V2"

    def __init__(self, map_id: str) -> None:
        JsonCommandWithMessageHandling.__init__(
            self,
            {
                "type": ["chargePos", "deebotPos"],
                "mid": map_id,
            },
        )


class GetMapBootstrap(JsonCommandWithMessageHandling, MessageBodyDataDict):
    """通过复合命令 ``getInfo`` 发现 T90 当前使用中的地图。"""

    NAME = "getInfo"

    def __init__(self) -> None:
        # 科沃斯 App 在当前 T90 固件上使用的请求形态。
        super().__init__(["getCachedMapInfo", "getRobotState", "getWorkState"])

    @classmethod
    def _handle_body_data_dict(
        cls, event_bus: EventBus, data: dict[str, Any]
    ) -> HandlingResult:
        cached_map_info = data.get("getCachedMapInfo")
        if (
            not isinstance(cached_map_info, dict)
            or cached_map_info.get("code") != 0
            or not isinstance(cached_map_info.get("data"), dict)
        ):
            return HandlingResult.analyse()

        result = OnCachedMapInfo._handle_body_data_dict(
            event_bus, cached_map_info["data"]
        )
        if (
            result.state != HandlingState.SUCCESS
            or not result.args
            or not (map_capability := event_bus.capabilities.map)
        ):
            return result

        map_id = result.args["map_id"]
        commands = [
            map_capability.set.execute(map_id, map_set_type)
            for map_set_type in MapSetType
        ]
        if map_capability.info:
            commands.append(map_capability.info.execute(map_id))
        commands.append(GetPosV2(map_id))
        # 顺带刷新 App 快捷指令（清洁场景），供场景实体/服务使用
        commands.append(GetQuickCommandT90())

        return HandlingResult(
            HandlingState.SUCCESS,
            result.args,
            requested_commands=commands,
        )

    def _handle_response(
        self, event_bus: EventBus, response: dict[str, Any]
    ) -> HandlingResult:
        # CommandWithMessageHandling 会丢弃消息处理器返回的后续命令，
        # 这里显式保留复合响应触发的命令。
        if response.get("ret") == "ok":
            return self.handle(event_bus, response.get("resp", response))

        return super()._handle_response(event_bus, response)


class T90CleanAreaV2(CleanAreaV2):
    """把 HA 的选区清扫翻译成 T90 Pro 的 freeClean V2 方言。"""

    def __init__(
        self, mode: CleanMode, area: list[int | float], cleanings: int = 1
    ) -> None:
        if mode == CleanMode.SPOT_AREA:
            mode = CleanMode.FREE_CLEAN
        super().__init__(mode, area, cleanings)


class T90FreeCleanV2(CleanV2):
    """下发 9 字段扩展 freeClean 值（带吸力/水量/拖地模式/遍数）。

    与基类的短格式（``cleanings,area...``）不同，此命令的 value 由
    freeclean.build_value 生成，每房间固定 9 字段，固件按定宽向量解析。
    """

    def __init__(self, value: str) -> None:
        super().__init__(CleanAction.START)
        self._additional_content = {
            "type": CleanMode.FREE_CLEAN.value,
            "value": value,
        }

    def _get_args(self, action: CleanAction) -> dict[str, Any]:
        args = super()._get_args(action)
        if action == CleanAction.START:
            args["content"].update(self._additional_content)
        return args


class GetQuickCommandT90(
    JsonCommandWithMessageHandling, MessageBodyDataList
):
    """发现 App 保存的快捷指令（清洁场景）。

    请求 ``{"type": "1,2"}``；回复为场景列表，每条含
    ``name/qcid/mid/type/content``，其中 ``content`` 即 9 字段 freeClean
    值，可原样作为 ``clean_V2`` 的 ``value`` 重放。
    """

    NAME = "getQuickCommand"

    def __init__(self) -> None:
        super().__init__({"type": "1,2"})

    @classmethod
    def _handle_body_data_list(
        cls, event_bus: EventBus, data: list[Any]
    ) -> HandlingResult:
        scenarios = tuple(
            {
                "name": str(entry.get("name", f"场景 {entry.get('qcid', i)}")),
                "qcid": entry.get("qcid"),
                "mid": entry.get("mid"),
                "content": str(entry.get("content", "")),
            }
            for i, entry in enumerate(data)
            if isinstance(entry, dict) and entry.get("content")
        )
        _SCENARIOS[event_bus] = scenarios
        event_bus.notify(ScenariosEvent(scenarios))
        return HandlingResult(HandlingState.SUCCESS, {"scenarios": scenarios})

    @classmethod
    def _handle_body_data(
        cls, event_bus: EventBus, data: dict[str, Any] | list[Any]
    ) -> HandlingResult:
        # 部分固件把列表包在字典里（如 {"quickCommands": [...]}）
        if isinstance(data, dict):
            for value in data.values():
                if isinstance(value, list):
                    return cls._handle_body_data_list(event_bus, value)
            return HandlingResult.analyse()
        return super()._handle_body_data(event_bus, data)


__all__ = [
    "GetMapBootstrap",
    "GetMapSetV2T90",
    "GetPosV2",
    "GetQuickCommandT90",
    "ScenariosEvent",
    "T90CleanAreaV2",
    "T90FreeCleanV2",
    "add_room_metadata_to_svg",
    "get_scenarios",
]
