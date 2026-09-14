#!/usr/bin/env python3
"""T90 PRO「AI 智能托管」命令探测脚本（只读，不会启动清扫）。

目的：
  验证国行 T90 PRO（class: jkzzec，固件 1.103.0）是否支持 App「AI 智能托管」
  背后的开关命令，为卡片新增该模式提供依据。

只做两件事：
  1. 只读查询：逐条发送 get* 命令，看固件是否应答、应答内容是什么
     （重点是 getCleanPreference —— deebot_client 里它是布尔开关，
      国行 X5 PRO 的机型定义 mxse7w 就有 clean.preference 这一项）
  2. MQTT 全量报文监听：打印机器人主题下收到的每一条原始 payload。
     监听期间你可以在 App 里【切换 AI 智能托管开关】（改设置，不会启动清扫），
     就能看到 App 真实下发的命令名与取值，从而实现零猜测复刻。

安全边界：
  - 本脚本不发送任何 set*/clean 之类的写命令，仅 get* 查询
  - 不会启动清扫、不会改变机器人任何设置
  - 唯一的"副作用"是登录科沃斯账号并订阅自己的设备主题

用法（在装有 deebot_client 的环境里跑，推荐 HA 容器内）：
  # 方式一：HA 容器内（推荐，依赖已就绪）
  docker cp tools/ai_pref_probe.py homeassistant:/tmp/
  docker exec -it homeassistant python3 /tmp/ai_pref_probe.py \
      --account 你的手机号 --password 你的密码

  # 方式二：本机 venv（HA 宿主机上没有 deebot_client 时需要先装）
  python3 -m venv .venv && .venv/bin/pip install "deebot-client>=18.5" aiohttp zstandard
  .venv/bin/python tools/ai_pref_probe.py --account 手机号 --password 密码

  可选参数：--listen 120（监听秒数，默认 90）  --queries-only（跳过监听阶段）

输出：
  - 控制台：查询结论一览 + 每个查询的原始应答
  - ai_pref_probe.log：完整 DEBUG 日志（含全部 MQTT 原始报文），可直接发回来分析
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import importlib
import json
import logging
import os
import sys
import time
from typing import Any

# ---------------------------------------------------------------------------
# 第 0 步：注册机型别名 jkzzec -> twunby（T90 PRO OMNI 定义）
# 必须在创建任何 Device 之前执行。
# ---------------------------------------------------------------------------
import deebot_client.hardware.twunby as twunby

sys.modules["deebot_client.hardware.jkzzec"] = twunby

import aiohttp  # noqa: E402
from deebot_client.api_client import ApiClient  # noqa: E402
from deebot_client.authentication import Authenticator, create_rest_config  # noqa: E402
from deebot_client.commands.json.custom import CustomCommand  # noqa: E402
from deebot_client.device import Device  # noqa: E402
from deebot_client.events import (  # noqa: E402
    AvailabilityEvent,
    BatteryEvent,
    CachedMapInfoEvent,
    CustomCommandEvent,
    ErrorEvent,
    MapChangedEvent,
    PositionsEvent,
    StateEvent,
)
from deebot_client.mqtt_client import MqttClient, create_mqtt_config  # noqa: E402
from deebot_client.util import md5  # noqa: E402

COUNTRY = "cn"

# 只读查询清单：全部是 get*，不改变设备任何状态。
# 前两条是本次调研的核心：
#   getCleanPreference -> 期望 {"enable": 0|1}，即 App 的「AI 智能托管」开关
#   getEfficiency      -> 期望 {"efficiency": 0|1}，注意这是能效模式(0 标准/1 节能)，
#                         与 App 的「清洁效率 快速/标准/深度」不是同一个东西
QUERIES: list[tuple[str, str]] = [
    ("getCleanPreference", "AI 智能托管开关（本次核心）"),
    ("getEfficiency", "能效模式 0=标准/1=节能（对照组）"),
    ("getAdvancedMode", "高级模式（X5 PRO 定义里有，对照组）"),
    ("getSweepMode", "扫拖模式设置（对照：确认既有命令语义）"),
    ("getCleanInfo", "当前清扫信息（能否反映托管态）"),
    ("getCleanInfo_V2", "当前清扫信息 V2（备选名）"),
    ("getWaterInfo", "水量信息（基线）"),
    ("getFanSpeed", "吸力档位（基线）"),
    ("getWorkMode", "工作模式（基线）"),
    ("getCleanCount", "清扫次数（基线）"),
    ("getWorkState", "工作状态（基线）"),
    ("getChargeState", "充电状态（基线）"),
]

# 收到这些事件时打印（有些事件类在老版本库里不存在，逐个 try 导入）
OPTIONAL_EVENTS = [
    "CleanPreferenceEvent",
    "EfficiencyModeEvent",
    "AdvancedModeEvent",
    "SweepModeEvent",
]

WATCH_EVENTS = [
    CachedMapInfoEvent,
    MapChangedEvent,
    PositionsEvent,
    BatteryEvent,
    StateEvent,
    ErrorEvent,
    AvailabilityEvent,
    CustomCommandEvent,
]

# 监听阶段会打印的提示
LISTEN_HINT = """
============================================================
进入 MQTT 监听阶段（%d 秒）。现在请打开科沃斯 App：
  1. 进入设备 → 清扫主界面 → 选择「全屋清洁」
  2. 把「AI 智能托管」开关【打开】，等 3 秒
  3. 再【关闭】，等 3 秒
（只改开关，不要点启动；本阶段脚本不发送任何命令）
本脚本会把 App 发出的原始命令名与取值全部打印出来。
============================================================
"""


def setup_logging() -> None:
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    root = logging.getLogger()
    root.setLevel(logging.DEBUG)
    fh = logging.FileHandler("ai_pref_probe.log", mode="w", encoding="utf-8")
    fh.setFormatter(fmt)
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    sh.setLevel(logging.INFO)
    root.addHandler(fh)
    root.addHandler(sh)


def decode_payload(raw: Any) -> str:
    """原始 payload -> 可读文本：先试 JSON，再试 base64+zstd，最后原样截断。"""
    if isinstance(raw, (bytes, bytearray)):
        text = bytes(raw).decode("utf-8", errors="replace")
    else:
        text = str(raw)
    try:
        return json.dumps(json.loads(text), ensure_ascii=False)
    except Exception:  # noqa: BLE001
        pass
    # 部分回包（如 onCleanTaskQueue）是 base64 + zstd
    try:
        import zstandard

        data = base64.b64decode(text)
        out = zstandard.ZstdDecompressor().decompress(data, max_output_size=1 << 22)
        return "[zstd] " + out.decode("utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        return text[:2000]


def install_mqtt_tap() -> None:
    """在 MqttClient._handle_message 上挂一层监听，打印所有进出报文。

    用运行时 monkey-patch 而不是改库文件：不动 site-packages，退出即失效。
    """
    original = MqttClient._handle_message

    def tapped(self: MqttClient, message: Any) -> None:
        try:
            topic = getattr(getattr(message, "topic", None), "value", None) or str(
                getattr(message, "topic", "?")
            )
            payload = getattr(message, "payload", b"")
            logging.info("[RAW MQTT] topic=%s\n          payload=%s", topic, decode_payload(payload))
        except Exception:  # noqa: BLE001
            logging.exception("打印原始报文时出错（不影响主流程）")
        return original(self, message)

    MqttClient._handle_message = tapped  # type: ignore[method-assign]
    logging.info("已挂载 MQTT 全量报文监听（不改动库文件，退出即失效）")


def classify_response(resp: Any) -> str:
    """把原始应答 dict 归纳成"支持 / 不支持 / 格式异常"一句话结论。"""
    body = resp.get("body") if isinstance(resp, dict) else None
    if not isinstance(body, dict):
        return f"应答格式异常：{resp!r}"
    code = body.get("code")
    data = body.get("data")
    if code == 0:
        return f"支持，data={json.dumps(data, ensure_ascii=False)}"
    return f"不支持（code={code}, msg={body.get('msg')}）"


async def probe_queries(bot: Device) -> dict[str, str]:
    """逐条发送只读查询，返回 命令名 -> 结论。

    device.execute_command() 不做能力表校验，直接回原始应答 dict，
    因此可以用它探测"机型定义里没写、但固件可能支持"的命令。
    """
    results: dict[str, str] = {}
    for name, desc in QUERIES:
        assert not name.lower().startswith(("set", "charge", "play")), (
            f"只读脚本不允许发送写命令：{name}"
        )
        logging.info("-" * 60)
        logging.info("查询 %s（%s）", name, desc)
        try:
            resp = await bot.execute_command(CustomCommand(name, {}))
            logging.info(">>> 原始应答: %r", resp)
            results[name] = classify_response(resp)
        except Exception as ex:  # noqa: BLE001
            results[name] = f"异常: {ex}"
            logging.error(">>> 异常: %s", ex)
        await asyncio.sleep(2)
    return results


async def main() -> None:
    parser = argparse.ArgumentParser(description="T90 PRO AI 托管开关只读探测")
    parser.add_argument("--account", default=os.environ.get("ECOVACS_ACCOUNT", ""))
    parser.add_argument("--password", default=os.environ.get("ECOVACS_PASSWORD", ""))
    parser.add_argument("--listen", type=int, default=90, help="监听秒数，默认 90")
    parser.add_argument("--queries-only", action="store_true", help="只跑查询，跳过监听")
    args = parser.parse_args()

    if not args.account or not args.password:
        parser.error(
            "请通过 --account/--password 或 ECOVACS_ACCOUNT/ECOVACS_PASSWORD 提供账号密码"
        )

    setup_logging()
    logging.info("登录科沃斯中国区服务器（账号: %s）...", args.account)

    async with aiohttp.ClientSession() as session:
        rest_config = create_rest_config(
            session, device_id=md5(str(time.time())), alpha_2_country=COUNTRY
        )
        authenticator = Authenticator(rest_config, args.account, md5(args.password))
        api_client = ApiClient(authenticator)
        devices = await api_client.get_devices()

        logging.info("MQTT 设备（有机型定义）: %d 台", len(devices.mqtt))
        for d in devices.mqtt:
            api = d.api
            logging.info(
                "  [MQTT] name=%s model=%s class=%s did=%s",
                api.get("deviceName"), api.get("model"), api.get("class"), api.get("did"),
            )
        for d in devices.not_supported:
            logging.info("  [未识别] class=%s name=%s", d.get("class"), d.get("deviceName"))

        if not devices.mqtt:
            logging.error("没有可用设备，请检查账号或机型别名。")
            return

        target = next(
            (d for d in devices.mqtt if d.api.get("class") == "jkzzec"), devices.mqtt[0]
        )
        logging.info(
            "选中目标: %s (class=%s)", target.api.get("deviceName"), target.api.get("class")
        )

        bot = Device(target, authenticator)

        def on_event(event: Any) -> None:
            logging.info("[EVENT] %s", event)

        for evt in WATCH_EVENTS:
            bot.events.subscribe(evt, on_event)
        for name in OPTIONAL_EVENTS:
            evt = getattr(importlib.import_module("deebot_client.events"), name, None)
            if evt is not None:
                bot.events.subscribe(evt, on_event)
            else:
                logging.info("（本版本库无 %s，跳过订阅）", name)

        mqtt = MqttClient(
            create_mqtt_config(device_id=md5(str(time.time())), country=COUNTRY),
            authenticator,
        )
        install_mqtt_tap()
        await bot.initialize(mqtt)
        logging.info("MQTT 初始化完成，等待可用性检查 ...")
        await asyncio.sleep(5)

        results = await probe_queries(bot)

        if not args.queries_only:
            logging.info(LISTEN_HINT, args.listen)
            await asyncio.sleep(args.listen)

        logging.info("=" * 60)
        logging.info("查询结论一览（详细应答见上方 RAW MQTT 与 >>> 返回）:")
        for name, desc in QUERIES:
            logging.info("  %-20s %-40s %s", name, desc, results.get(name, "(未执行)"))
        logging.info("完整日志已保存到 ai_pref_probe.log，请把该文件发回分析。")


if __name__ == "__main__":
    asyncio.run(main())
