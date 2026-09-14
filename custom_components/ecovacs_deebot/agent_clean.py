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
