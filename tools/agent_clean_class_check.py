"""本地校验 agent_clean.py 的类定义是否合法（无需安装 deebot_client）。

背景：本机的 deebot_client 不可用，而"库扩展类"的错误（NAME 元校验、
MRO 冲突）只在 HA 加载时才暴露，实测已连续踩两次：
  1. 从 MessageBodyDataDict 抽公共混入基类 → ValueError: must have a NAME
  2. class OnSwitchState(Message, MessageBodyDataDict) → TypeError: MRO

本脚本用桩模块复刻 deebot_client 的关键结构，直接 exec 真实源文件，
在本地暴露同类问题：
- Message.__init_subclass__ 强制每个直接子类有 NAME
- MessageBody(Message) → MessageBodyDataDict(MessageBody)
- Event / EventBus / HandlingResult / HandlingState
- Command / JsonCommand(Command) / CommandWithMessageHandling(MessageBody)
  / JsonCommandWithMessageHandling(JsonCommand, CommandWithMessageHandling, MessageBodyDataDict)
- messages.json.MESSAGES 注册表（注入目标）

用法：python3 tools/agent_clean_class_check.py
"""

from __future__ import annotations

from abc import ABC
from dataclasses import dataclass
from enum import IntEnum, auto
import sys
import types
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "custom_components" / "ecovacs_deebot" / "agent_clean.py"


# ---------- 桩：deebot_client 的关键类层次 ----------

class _Event:
    """deebot_client.events.Event 桩。"""


@dataclass
class _HandlingResult:
    state: "_HandlingState"
    args: object = None

    @classmethod
    def success(cls) -> "_HandlingResult":
        return cls(_HandlingState.SUCCESS)

    @classmethod
    def analyse(cls) -> "_HandlingResult":
        return cls(_HandlingState.ANALYSE)


class _HandlingState(IntEnum):
    SUCCESS = auto()
    FAILED = auto()
    ANALYSE = auto()
    ANALYSE_LOGGED = auto()


class _EventBus:
    def notify(self, event: object) -> None:  # noqa: D102
        self.notified.append(event)

    def __init__(self) -> None:
        self.notified: list[object] = []


def _verify_required_class_variables_exists(cls: type, required: tuple[str, ...]) -> None:
    """复刻库实现：直接基类含 ABC 的中间抽象类跳过校验。"""
    if ABC not in cls.__bases__:
        for name in required:
            if not hasattr(cls, name):
                raise ValueError(f"Class {cls.__name__} must have a {name} attribute")


class _Message(ABC):
    """Message 桩：复刻 __init_subclass__ 的 NAME 元校验。"""

    NAME: str

    def __init_subclass__(cls) -> None:
        _verify_required_class_variables_exists(cls, ("NAME",))
        return super().__init_subclass__()


class _MessageDictOrJson(_Message, ABC):
    """MessageDictOrJson 桩。"""


class _MessageBody(_MessageDictOrJson, ABC):
    """MessageBody 桩（中间抽象类，跳过 NAME 校验）。"""


class _MessageBodyData(_MessageBody, ABC):
    """MessageBodyData 桩。"""


class _MessageBodyDataDict(_MessageBodyData, ABC):
    """MessageBodyDataDict 桩。"""


class _Command(ABC):
    """Command 桩。"""


class _CommandWithMessageHandling(_MessageBody, ABC):
    """CommandWithMessageHandling 桩。"""


class _JsonCommand(_Command, ABC):
    DATA_TYPE = "j"


class _JsonCommandWithMessageHandling(
    _JsonCommand, _CommandWithMessageHandling, _MessageBodyDataDict, ABC,
):
    """与库同名同层次（库中为 JsonCommandWithMessageHandling）。"""


_JSON_MESSAGES: dict[str, type] = {}


def _install_stub_modules() -> None:
    """把桩挂进 sys.modules，使真实源文件的 import 语句可解析。"""

    def mod(name: str, **attrs: object) -> types.ModuleType:
        module = types.ModuleType(name)
        for key, value in attrs.items():
            setattr(module, key, value)
        sys.modules[name] = module
        return module

    root = mod("deebot_client")
    mod("deebot_client.events", Event=_Event)
    mod("deebot_client.event_bus", EventBus=_EventBus)
    mod(
        "deebot_client.message",
        Message=_Message,
        MessageBody=_MessageBody,
        MessageBodyDataDict=_MessageBodyDataDict,
        HandlingResult=_HandlingResult,
        HandlingState=_HandlingState,
    )
    mod("deebot_client.command", Command=_Command, CommandWithMessageHandling=_CommandWithMessageHandling)
    mod("deebot_client.commands")
    mod("deebot_client.commands.json")
    mod(
        "deebot_client.commands.json.common",
        JsonCommand=_JsonCommand,
        JsonCommandWithMessageHandling=_JsonCommandWithMessageHandling,
    )
    mod("deebot_client.messages")
    mod("deebot_client.messages.json", MESSAGES=_JSON_MESSAGES)
    root.messages = sys.modules["deebot_client.messages"]  # type: ignore[attr-defined]


def main() -> int:
    _install_stub_modules()

    namespace: dict[str, object] = {"__name__": "agent_clean_under_test", "__file__": str(SRC)}
    # dataclasses 需要能在 sys.modules 里按 __module__ 找到本模块
    module = types.ModuleType("agent_clean_under_test")
    module.__file__ = str(SRC)
    sys.modules["agent_clean_under_test"] = module
    namespace["__loader__"] = None
    try:
        exec(compile(SRC.read_text(encoding="utf-8"), str(SRC), "exec"), namespace)  # noqa: S102
    except Exception as exc:  # noqa: BLE001
        import traceback

        traceback.print_exc()
        print(f"FAIL  模块导入：{type(exc).__name__}: {exc}")
        return 1
    print("PASS  模块导入（类定义 / NAME 元校验 / MRO 均合法）")

    failures = 0

    def check(label: str, ok: bool) -> None:
        nonlocal failures
        failures += not ok
        print(("PASS  " if ok else "FAIL  ") + label)

    for name in ("AgentCleanEvent", "GetSwitchState", "OnSwitchState", "_notify_agent_clean"):
        check(f"导出 {name}", name in namespace)

    check(
        "GetSwitchState.NAME",
        getattr(namespace.get("GetSwitchState"), "NAME", None) == "getSwitchState",
    )
    check(
        "OnSwitchState.NAME",
        getattr(namespace.get("OnSwitchState"), "NAME", None) == "onSwitchState",
    )
    check(
        "OnSwitchState 是 Message 后代且单继承",
        len(getattr(namespace["OnSwitchState"], "__bases__", ())) == 1,
    )
    check(
        "GetSwitchState 保持库同款多继承",
        len(getattr(namespace["GetSwitchState"], "__bases__", ())) == 2,
    )
    check("注册表已注入 onSwitchState", _JSON_MESSAGES.get("onSwitchState") is namespace["OnSwitchState"])

    # 行为验证：agentClean 解析与事件广播
    from_stub = namespace["_notify_agent_clean"]
    event_bus = _EventBus()
    from_stub(event_bus, {"agentClean": 1, "AiSetting": 1})
    notified = event_bus.notified
    check("agentClean:1 → 广播 AgentCleanEvent(enabled=True)",
          len(notified) == 1 and notified[0].enabled is True)

    event_bus2 = _EventBus()
    result = from_stub(event_bus2, {"AiSetting": 1})
    check("缺 agentClean → 不广播并返回 ANALYSE",
          not event_bus2.notified and result.state is _HandlingState.ANALYSE)

    print("\n全部检查通过" if failures == 0 else f"\n{failures} 项检查失败")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
