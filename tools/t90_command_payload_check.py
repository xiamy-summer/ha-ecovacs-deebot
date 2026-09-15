#!/usr/bin/env python3
"""校验 t90_map.py / agent_clean.py 智能体启动命令的 payload（本地桩，无需装 deebot_client）。

背景：HA 用智能体模式启动后，科沃斯 App 曾显示「按我的设置清扫」——2026-09-15
抓包（tools/ai_pref_probe.log，jkzzec 1.103.0）显示 App 的智能体启动统一走
``clean_V2`` 且额外携带 ``agentInfo`` 字段，缺该字段任务虽成功但 App 不认。

本脚本用桩模块复刻 deebot_client 的类层次（Clean/CleanV2/CleanAreaV2 的
``_get_args`` 按 DeebotUniverse/client.py dev 分支真实实现复刻），直接 exec
仓库中的真实源文件，验证：
  1. 生成的 payload 结构与抓包报文逐字段一致（key 集合硬编码自抓包）；
  2. 选房走 freeClean 短格式、全屋走 type=auto；
  3. 类定义可正常创建（MRO 无误）。

用法：python3 tools/t90_command_payload_check.py
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
import sys
import types
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
COMPONENT = ROOT / "custom_components" / "ecovacs_deebot"

# ---------------------------------------------------------------------------
# 抓包报文的结构常量（2026-09-15，jkzzec 1.103.0，clean_V2 start）
# ---------------------------------------------------------------------------
CAPTURE_ROOM_KEYS = {
    "area_temp_set", "order", "parameter", "petHotArea", "sub_area_para",
    "sub_type_deebot", "sub_type_omni", "task_area", "task_id", "task_status", "type",
}
CAPTURE_PARAMETER_KEYS = {"clean_para", "station_para"}
CAPTURE_CLEAN_PARA_KEYS = {"cycle", "efficiency", "label", "mode", "suction", "water_volume"}
CAPTURE_STATION_PARA_KEYS = {
    "dry_time", "is_deepWash", "mop_mode", "need_dry", "need_dustCollect", "need_washMop",
}
CAPTURE_TASK_AREA_KEYS = {
    "area_name", "area_type", "contour", "fur_room_id", "fur_type", "id", "map_id",
}
CAPTURE_TASK_STATUS_KEYS = {
    "end_time", "failure_reason", "insert_time", "source", "start_time", "status",
}
CAPTURE_AGENT_INFO_KEYS = {"content", "gen_reason", "queue_id", "queue_state", "start"}


# ---------------------------------------------------------------------------
# 桩：deebot_client（只复刻本校验需要的部分）
# ---------------------------------------------------------------------------
class CleanAction(StrEnum):
    START = "start"
    PAUSE = "pause"
    STOP = "stop"
    RESUME = "resume"


class CleanMode(StrEnum):
    AUTO = "auto"
    FREE_CLEAN = "freeClean"
    SPOT_AREA = "spotArea"
    CUSTOM_AREA = "customArea"


class Clean:
    """复刻 deebot_client.commands.json.clean.Clean。"""

    NAME = "clean"

    def __init__(self, action: CleanAction) -> None:
        self._args = self._get_args(action)

    def _get_args(self, action: CleanAction) -> dict[str, Any]:
        args: dict[str, Any] = {"act": action.value}
        if action == CleanAction.START:
            args["type"] = CleanMode.AUTO.value
        return args


class CleanV2(Clean):
    """复刻 deebot_client.commands.json.clean.CleanV2。"""

    NAME = "clean_V2"

    def _get_args(self, action: CleanAction) -> dict[str, Any]:
        content: dict[str, str] = {}
        args: dict[str, Any] = {"act": action.value, "content": content}
        if action == CleanAction.START:
            content["type"] = CleanMode.AUTO.value
        elif action in (CleanAction.STOP, CleanAction.PAUSE):
            content["type"] = ""
        return args


class CleanAreaV2(CleanV2):
    """复刻 deebot_client.commands.json.clean.CleanAreaV2。"""

    def __init__(self, mode: CleanMode, area: list[int | float], cleanings: int = 1) -> None:
        value = ",".join(str(i) for i in area)
        if mode == CleanMode.FREE_CLEAN:
            value = f"{cleanings},{value}"
        self._additional_content = {"type": mode.value, "value": value}
        super().__init__(CleanAction.START)

    def _get_args(self, action: CleanAction) -> dict[str, Any]:
        args = super()._get_args(action)
        if action == CleanAction.START:
            args["content"].update(self._additional_content)
        return args


class HandlingState(StrEnum):
    SUCCESS = "success"
    ANALYSE = "analyse"
    ERROR = "error"


@dataclass
class HandlingResult:
    state: HandlingState = HandlingState.SUCCESS
    args: dict[str, Any] | None = None

    @classmethod
    def success(cls, *args: Any, **kwargs: Any) -> HandlingResult:
        return cls(HandlingState.SUCCESS)

    @classmethod
    def analyse(cls, *args: Any, **kwargs: Any) -> HandlingResult:
        return cls(HandlingState.ANALYSE)


class _Stub:
    """通用桩：忽略一切调用。"""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        pass

    def __getattr__(self, name: str) -> Any:
        return lambda *a, **k: HandlingResult.analyse()


class GetMapSetV2(_Stub):
    @classmethod
    def _handle_rooms_subsets(cls, *args: Any, **kwargs: Any) -> HandlingResult:
        return HandlingResult.analyse()

    @classmethod
    def _notify_rooms(cls, *args: Any, **kwargs: Any) -> None:
        pass


class GetPos(_Stub):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__()


@dataclass(frozen=True)
class Room:
    name: str
    id: int
    coordinates: str


@dataclass(frozen=True)
class RoomsEvent:
    map_id: str
    rooms: list[Room]


class MapSetType(StrEnum):
    ROOMS = "ar"


class Event:
    pass


class MessageBodyDataDict(_Stub):
    pass


class MessageBodyDataList(_Stub):
    pass


class JsonCommandWithMessageHandling(_Stub):
    pass


class OnCachedMapInfo(_Stub):
    pass


class RotationAngle(_Stub):
    pass


def _install_stubs() -> None:
    """把桩模块塞进 sys.modules，使真实源文件可直接 exec。"""
    def mod(name: str, **attrs: Any) -> types.ModuleType:
        module = types.ModuleType(name)
        module.__dict__.update(attrs)
        sys.modules[name] = module
        return module

    mod("deebot_client")
    mod("deebot_client.commands")
    mod("deebot_client.commands.json")
    mod("deebot_client.commands.json.common",
        JsonCommandWithMessageHandling=JsonCommandWithMessageHandling)
    mod("deebot_client.commands.json.clean", Clean=Clean, CleanV2=CleanV2,
        CleanAreaV2=CleanAreaV2)
    mod("deebot_client.commands.json.map", GetMapSetV2=GetMapSetV2)
    mod("deebot_client.commands.json.pos", GetPos=GetPos)
    mod("deebot_client.commands.json.custom", CustomCommand=_Stub)
    mod("deebot_client.events", MapSetType=MapSetType, RoomsEvent=RoomsEvent,
        Event=Event)
    mod("deebot_client.events.base", Event=Event)
    mod("deebot_client.message", HandlingResult=HandlingResult,
        HandlingState=HandlingState, MessageBodyDataDict=MessageBodyDataDict,
        MessageBodyDataList=MessageBodyDataList)
    mod("deebot_client.messages")
    mod("deebot_client.messages.json", MESSAGES={})
    mod("deebot_client.messages.json.map")
    mod("deebot_client.messages.json.map.cached_map_info", OnCachedMapInfo=OnCachedMapInfo)
    mod("deebot_client.models", CleanAction=CleanAction, CleanMode=CleanMode,
        Room=Room, State=_Stub)
    mod("deebot_client.rs")
    mod("deebot_client.rs.map", RotationAngle=RotationAngle)
    mod("deebot_client.event_bus", EventBus=object)


def _load(name: str) -> dict[str, Any]:
    """exec 真实源文件；必须先把模块注册进 sys.modules，
    否则 @dataclass 处理 class 时会因 cls.__module__ 查不到模块而报
    AttributeError: 'NoneType' object has no attribute '__dict__'。
    """
    path = COMPONENT / name
    modname = f"check_{name[:-3]}"
    module = types.ModuleType(modname)
    module.__file__ = str(path)
    sys.modules[modname] = module
    exec(  # noqa: S102
        compile(path.read_text(encoding="utf-8"), str(path), "exec"),
        module.__dict__,
    )
    return module.__dict__


def main() -> int:
    _install_stubs()
    agent = _load("agent_clean.py")
    t90 = _load("t90_map.py")

    build_agent_info = agent["build_agent_info"]
    T90AgentCleanV2 = t90["T90AgentCleanV2"]
    T90AgentAutoCleanV2 = t90["T90AgentAutoCleanV2"]

    failures: list[str] = []

    def check(name: str, condition: bool, detail: str = "") -> None:
        print(f"{'PASS' if condition else 'FAIL'}  {name}{'' if condition else '  -> ' + detail}")
        if not condition:
            failures.append(name)

    did = "c4335df7-a74b-4cbf-9742-66ee34cc8914"
    map_id = 1293233709
    rooms = [(7, "哥哥房"), (9, "客厅"), (11, "餐厅")]
    info = build_agent_info(did, map_id, rooms)

    # --- agentInfo 结构 vs 抓包 ---
    check("agentInfo 顶层字段与抓包一致", set(info[0]) == CAPTURE_AGENT_INFO_KEYS,
          str(set(info[0]) ^ CAPTURE_AGENT_INFO_KEYS))
    check("agentInfo 房间数 = 传入房间数", len(info[0]["content"]) == 3)
    first = info[0]["content"][0]
    check("房间项字段与抓包一致", set(first) == CAPTURE_ROOM_KEYS,
          str(set(first) ^ CAPTURE_ROOM_KEYS))
    check("parameter 字段与抓包一致", set(first["parameter"]) == CAPTURE_PARAMETER_KEYS)
    check("clean_para 字段与抓包一致",
          set(first["parameter"]["clean_para"]) == CAPTURE_CLEAN_PARA_KEYS)
    check("station_para 字段与抓包一致",
          set(first["parameter"]["station_para"]) == CAPTURE_STATION_PARA_KEYS)
    check("task_area 字段与抓包一致", set(first["task_area"]) == CAPTURE_TASK_AREA_KEYS)
    check("task_status 字段与抓包一致", set(first["task_status"]) == CAPTURE_TASK_STATUS_KEYS)
    check("房间 order/task_id 从 1 递增",
          [r["order"] for r in info[0]["content"]] == [1, 2, 3]
          and [r["task_id"] for r in info[0]["content"]] == [1, 2, 3])
    check("task_area.id 与房间表一致",
          [r["task_area"]["id"] for r in info[0]["content"]] == [7, 9, 11])
    check("task_area.map_id = 当前地图", all(r["task_area"]["map_id"] == map_id for r in info[0]["content"]))
    check("task_area.area_name 使用设备房间名",
          [r["task_area"]["area_name"] for r in info[0]["content"]] == ["哥哥房", "客厅", "餐厅"])
    check("gen_reason 形态 = <did>_<8位>_cot",
          info[0]["gen_reason"].startswith(f"{did}_") and info[0]["gen_reason"].endswith("_cot")
          and len(info[0]["gen_reason"].split("_")[-2]) == 8)
    check("queue_id 为正整数", isinstance(info[0]["queue_id"], int) and info[0]["queue_id"] > 0)
    check("queue_state=0 且 start 占位", info[0]["queue_state"] == 0
          and info[0]["start"] == {"electricity": 255, "source": 0, "time": ""})

    # --- 选房启动 payload（对照 App：freeClean 短格式 + agentInfo）---
    args = T90AgentCleanV2("1,7;1,9;1,11", info)._args
    check("选房：命令字段 = act/content/agentInfo", set(args) == {"act", "content", "agentInfo"})
    check("选房：act=start", args.get("act") == "start")
    check("选房：content = freeClean 短格式",
          args.get("content") == {"type": "freeClean", "value": "1,7;1,9;1,11"})
    check("选房：携带 agentInfo", args.get("agentInfo") == info)

    # --- 全屋启动 payload（对照 App：type=auto + agentInfo 全房间）---
    full_info = build_agent_info(did, map_id, [(8, "主卧"), (7, "哥哥房")])
    args2 = T90AgentAutoCleanV2(full_info)._args
    check("全屋：命令字段 = act/content/agentInfo", set(args2) == {"act", "content", "agentInfo"})
    check("全屋：content = {type: auto}", args2.get("content") == {"type": "auto"})
    check("全屋：携带 agentInfo", args2.get("agentInfo") == full_info)

    # --- 名称继承（务必是 clean_V2，App 用的就是这条命令）---
    check("命令名继承自 CleanV2 = clean_V2",
          T90AgentCleanV2.NAME == "clean_V2" and T90AgentAutoCleanV2.NAME == "clean_V2")

    print()
    if failures:
        print(f"{len(failures)} 项失败：{failures}")
        return 1
    print("全部检查通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
