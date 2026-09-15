"""AI 智能托管（agentClean）开关状态：deebot_client 缺失命令/事件的桥接。

背景（jkzzec 固件 1.103.0 抓包实测）：
- App 的「AI 智能托管 / 智能体模式」开关 = ``setSwitchState {"agentClean": 0|1}``；
- 设备状态变化时通过 ``iot/atr/onSwitchState`` 推送全量开关表，
  ``body.data`` 中含 ``agentClean`` 字段（同族还有 AiSetting/aistain 等）。
- deebot_client 18.5.1 的消息注册表没有 ``onSwitchState``（``get_message``
  返回 None 后静默丢弃），也没有 ``getSwitchState`` 命令类，因此库层面
  拿不到设备侧的托管开关状态。

本模块自定义 Message/Command 并在导入时注册进库的 ``MESSAGES`` 表
（``iot/atr/+`` 是通配订阅，所有 atr 推送都会经 ``device._handle_message``
→ ``get_message`` 查表分发，注册即可生效，无需改库源码）。

注意：``MessageBodyDataDict`` 继承自 ``Message``，其 ``__init_subclass__``
要求每个直接子类必须有 ``NAME``——因此不能抽公共混入基类，两个类各自
直接继承，处理逻辑抽成模块级函数复用。
"""

from __future__ import annotations

from dataclasses import dataclass
import secrets
from typing import Any

from deebot_client.commands.json.common import JsonCommandWithMessageHandling
from deebot_client.event_bus import EventBus
from deebot_client.events import Event
from deebot_client.message import (
    HandlingResult,
    HandlingState,
    MessageBodyDataDict,
)


@dataclass(frozen=True)
class AgentCleanEvent(Event):
    """AI 智能托管（agentClean）开关状态事件。"""

    enabled: bool


def _notify_agent_clean(event_bus: EventBus, data: dict[str, Any]) -> HandlingResult:
    """解析 body.data 中的 agentClean 字段并广播事件。"""
    if "agentClean" not in data:
        # 设备推送的全量开关表偶发缺字段，忽略本次，等待下一次推送
        return HandlingResult(HandlingState.ANALYSE, "agentClean missing")
    event_bus.notify(AgentCleanEvent(enabled=bool(data["agentClean"])))
    return HandlingResult.success()


# 智能体任务的每房间默认参数（抓包观测值：多数房间均为这组；
# 厨房等特殊房间由云端 AI 单独生成，MQTT 通道抓不到生成来源）。
_DEFAULT_CLEAN_PARA = {
    "cycle": 1,
    "efficiency": 0,
    "label": 1,
    "mode": 0,
    "suction": 0,
    "water_volume": 15,
}
# station_para 抓包里全部为 255/0 的"未设置"占位值，设备端自行决定。
_DEFAULT_STATION_PARA = {
    "dry_time": 255,
    "is_deepWash": 255,
    "mop_mode": 255,
    "need_dry": 0,
    "need_dustCollect": 0,
    "need_washMop": 0,
}


def build_agent_info(
    did: str, map_id: int, rooms: list[tuple[int, str]]
) -> list[dict[str, Any]]:
    """构造 App「智能体模式」启动报文中的 agentInfo 字段。

    结构为 2026-09-15 抓包逆向（tools/ai_pref_probe.log，jkzzec 1.103.0）：
    App 智能体启动统一走 clean_V2 命令，无论全屋（content.type=auto）还是
    选房（content.type=freeClean + value），都额外携带 agentInfo[0]，
    其中 content 为每个房间的任务卡：task_area（房间 id/名称/map_id）+
    parameter（clean_para/station_para），order/task_id 按所选房间重新
    编号 1..N。**App 据此把本次任务标记为「智能体托管清扫」**——缺了
    agentInfo，App 就显示「按我的设置清扫」。

    每房间 clean_para 本应由云端 AI 按房间类型生成（抓包中各房间水量
    5/15/25/35 不等），生成走 App 云端 HTTPS 通道，MQTT 抓不到；此处用
    抓包中的多数默认值。queue_id/gen_reason 两次实测均不同、无规律
    （疑似云端生成），按观测形态随机生成，若设备/App 不认可再逆向。
    """
    content = [
        {
            "area_temp_set": [],
            "order": order,
            "parameter": {
                "clean_para": _DEFAULT_CLEAN_PARA.copy(),
                "station_para": _DEFAULT_STATION_PARA.copy(),
            },
            "petHotArea": 0,
            "sub_area_para": [],
            "sub_type_deebot": 1,
            "sub_type_omni": 255,
            "task_area": {
                "area_name": name,
                "area_type": 0,
                "contour": [],
                "fur_room_id": 255,
                "fur_type": 255,
                "id": room_id,
                "map_id": map_id,
            },
            "task_id": order,
            "task_status": {
                "end_time": "",
                "failure_reason": 255,
                "insert_time": "",
                "source": 0,
                "start_time": "",
                "status": 0,
            },
            "type": 1,
        }
        for order, (room_id, name) in enumerate(rooms, 1)
    ]
    return [
        {
            "content": content,
            "gen_reason": f"{did}_{secrets.token_hex(4)}_cot",
            "queue_id": secrets.randbelow(90000) + 10000,
            "queue_state": 0,
            "start": {"electricity": 255, "source": 0, "time": ""},
        }
    ]


class GetSwitchState(JsonCommandWithMessageHandling, MessageBodyDataDict):
    """getSwitchState 查询命令（固件是否支持以实测为准）。"""

    NAME = "getSwitchState"

    @classmethod
    def _handle_body_data_dict(
        cls, event_bus: EventBus, data: dict[str, Any]
    ) -> HandlingResult:
        """Handle message->body->data."""
        return _notify_agent_clean(event_bus, data)


class OnSwitchState(MessageBodyDataDict):
    """onSwitchState 设备推送消息（单继承：MessageBodyDataDict 已是 Message 子类）。"""

    NAME = "onSwitchState"

    @classmethod
    def _handle_body_data_dict(
        cls, event_bus: EventBus, data: dict[str, Any]
    ) -> HandlingResult:
        """Handle message->body->data."""
        return _notify_agent_clean(event_bus, data)


# deebot_client.messages.MESSAGES 顶层 dict 引用的就是 json.MESSAGES
# 同一对象，此处注册后 device._handle_message 的 get_message 即可命中。
from deebot_client.messages.json import MESSAGES as _JSON_MESSAGES  # noqa: E402

if "onSwitchState" not in _JSON_MESSAGES:
    _JSON_MESSAGES["onSwitchState"] = OnSwitchState
