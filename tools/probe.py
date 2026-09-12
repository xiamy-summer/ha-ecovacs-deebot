#!/usr/bin/env python3
"""科沃斯 T90 PRO 上下水款（class: jkzzec）协议探测脚本。

用途：
  1. 用 deebot_client 库登录科沃斯中国区账号，列出账号下所有设备
  2. 把 jkzzec 映射到 twunby（T90 PRO OMNI）的机型定义
  3. 逐条发送地图/状态相关命令，打印机器人真实响应
  4. 监听 MQTT 推送（建议监听期间在 App 里启动一次清扫，观察地图事件）

用法：
  python3 probe.py --account 你的手机号或邮箱 --password 你的密码

  账号密码也可以用环境变量传入：
  ECOVACS_ACCOUNT=xxx ECOVACS_PASSWORD=xxx python3 probe.py

输出：
  - 控制台打印关键结果
  - probe.log 保存完整 DEBUG 日志（发给 AI 分析用）
"""

from __future__ import annotations

import argparse
import asyncio
import importlib
import logging
import os
import sys
import time
from typing import Any

# ---------------------------------------------------------------------------
# 第 0 步：注册机型别名 jkzzec -> twunby（T90 PRO OMNI 定义）
# 必须在创建任何 Device 之前执行。importlib 会优先查 sys.modules。
# ---------------------------------------------------------------------------
import deebot_client.hardware.twunby as twunby

sys.modules["deebot_client.hardware.jkzzec"] = twunby

from deebot_client.api_client import ApiClient  # noqa: E402
from deebot_client.authentication import Authenticator, create_rest_config  # noqa: E402
from deebot_client.commands.json import (  # noqa: E402
    battery,
    charge_state,
    clean_logs,
    error as error_cmd,
    fan_speed,
    life_span,
    map as map_cmds,
    pos,
    stats,
    water_info,
    work_state,
)
from deebot_client.device import Device  # noqa: E402
from deebot_client.events import (  # noqa: E402
    AvailabilityEvent,
    BatteryEvent,
    CachedMapInfoEvent,
    ErrorEvent,
    FanSpeedEvent,
    LifeSpanEvent,
    MapChangedEvent,
    PositionsEvent,
    ReportStatsEvent,
    StateEvent,
    StatsEvent,
)
from deebot_client.mqtt_client import MqttClient, create_mqtt_config  # noqa: E402
from deebot_client.util import md5  # noqa: E402

import aiohttp  # noqa: E402

COUNTRY = "cn"

PROBE_COMMANDS: list[tuple[str, Any]] = [
    # (说明, 命令实例)
    ("电量 GetBattery", battery.GetBattery()),
    ("充电状态 GetChargeState", charge_state.GetChargeState()),
    ("工作状态 GetWorkState", work_state.GetWorkState()),
    ("错误码 GetError", error_cmd.GetError()),
    ("缓存地图信息 GetCachedMapInfo（关键！）", map_cmds.GetCachedMapInfo()),
    ("主地图 GetMajorMap（关键！）", map_cmds.GetMajorMap()),
    ("地图V2 GetMapInfoV2", map_cmds.GetMapInfoV2()),
    ("地图轨迹 GetMapTrace", map_cmds.GetMapTrace()),
    ("当前位置 GetPos", pos.GetPos()),
    ("清扫记录 GetCleanLogs", clean_logs.GetCleanLogs(count=30)),
    ("实时统计 GetStats", stats.GetStats()),
    ("累计统计 GetTotalStats", stats.GetTotalStats()),
    ("风扇档位 GetFanSpeed", fan_speed.GetFanSpeed()),
    ("水量信息 GetWaterInfo", water_info.GetWaterInfo()),
]

# 监听的关键事件（地图相关事件会重点标记）
WATCH_EVENTS = [
    CachedMapInfoEvent,
    MapChangedEvent,
    PositionsEvent,
    BatteryEvent,
    StateEvent,
    StatsEvent,
    ReportStatsEvent,
    ErrorEvent,
    FanSpeedEvent,
    LifeSpanEvent,
    AvailabilityEvent,
]

MAP_EVENTS = {CachedMapInfoEvent, MapChangedEvent, PositionsEvent}

LISTEN_SECONDS = 120


def setup_logging() -> None:
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    root = logging.getLogger()
    root.setLevel(logging.DEBUG)
    fh = logging.FileHandler("probe.log", mode="w", encoding="utf-8")
    fh.setFormatter(fmt)
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    sh.setLevel(logging.INFO)
    root.addHandler(fh)
    root.addHandler(sh)


async def probe_device(bot: Device) -> None:
    """逐条发送探测命令并打印原始响应。"""

    def on_event(event: Any) -> None:
        tag = " ★地图事件★ " if type(event) in MAP_EVENTS else " "
        logging.info("%s[EVENT] %s", tag, event)

    for evt in WATCH_EVENTS:
        bot.events.subscribe(evt, on_event)

    mqtt = MqttClient(
        create_mqtt_config(
            device_id=md5(str(time.time())), country=COUNTRY
        ),
        bot._authenticator,  # noqa: SLF001 - 探测脚本直接复用认证器
    )
    logging.info("=" * 60)
    logging.info("连接 MQTT 并订阅机器人主题 ...")
    await bot.initialize(mqtt)
    logging.info("MQTT 初始化完成，等待可用性检查 ...")
    await asyncio.sleep(5)

    logging.info("=" * 60)
    logging.info("开始逐条探测命令（每条间隔 2 秒）")
    results: dict[str, Any] = {}
    for desc, cmd in PROBE_COMMANDS:
        logging.info("--- %s ---", desc)
        try:
            resp = await bot.execute_command(cmd)
            results[type(cmd).__name__] = resp
            logging.info(">>> 响应: %s", resp)
        except Exception as ex:  # noqa: BLE001
            results[type(cmd).__name__] = f"ERROR: {ex}"
            logging.error(">>> 命令异常: %s", ex)
        await asyncio.sleep(2)

    logging.info("=" * 60)
    logging.info("命令探测完成，进入监听模式 %d 秒。", LISTEN_SECONDS)
    logging.info(">>> 现在请在科沃斯 App 里启动一次清扫，观察地图事件是否推送！")
    await asyncio.sleep(LISTEN_SECONDS)

    logging.info("=" * 60)
    logging.info("探测结果汇总：")
    for name, resp in results.items():
        logging.info("  %-22s %s", name, str(resp)[:200])
    logging.info("完整日志已保存到 probe.log，请把该文件内容发给 AI 分析。")


async def main() -> None:
    parser = argparse.ArgumentParser(description="科沃斯 T90 PRO 协议探测")
    parser.add_argument("--account", default=os.environ.get("ECOVACS_ACCOUNT", ""))
    parser.add_argument("--password", default=os.environ.get("ECOVACS_PASSWORD", ""))
    args = parser.parse_args()

    if not args.account or not args.password:
        parser.error("请通过 --account/--password 或 ECOVACS_ACCOUNT/ECOVACS_PASSWORD 提供账号密码")

    setup_logging()
    logging.info("登录科沃斯中国区服务器（账号: %s）...", args.account)

    async with aiohttp.ClientSession() as session:
        rest_config = create_rest_config(
            session, device_id=md5(str(time.time())), alpha_2_country=COUNTRY
        )
        authenticator = Authenticator(rest_config, args.account, md5(args.password))
        api_client = ApiClient(authenticator)

        devices = await api_client.get_devices()

        logging.info("=" * 60)
        logging.info("支持的 MQTT 设备（有机型定义）: %d 台", len(devices.mqtt))
        for d in devices.mqtt:
            api = d.api
            logging.info(
                "  [MQTT] name=%s model=%s class=%s did=%s company=%s",
                api.get("deviceName"), api.get("model"), api.get("class"),
                api.get("did"), api.get("company"),
            )
        logging.info("旧协议 XMPP 设备: %d 台", len(devices.xmpp))
        logging.info("!! 未识别的设备（无机型定义）: %d 台", len(devices.not_supported))
        for d in devices.not_supported:
            logging.info("  [未识别] class=%s name=%s", d.get("class"), d.get("deviceName"))

        if not devices.mqtt:
            logging.error("没有可用设备。若 T90 PRO 出现在未识别列表里属于预期（jkzzec 已在脚本内映射，"
                          "若仍出现说明别名未生效，请把 probe.log 发回分析）。")
            return

        # 优先选 jkzzec（T90 PRO 上下水款），否则选第一台
        target = next(
            (d for d in devices.mqtt if d.api.get("class") == "jkzzec"),
            devices.mqtt[0],
        )
        logging.info("选中探测目标: %s (class=%s)", target.api.get("deviceName"), target.api.get("class"))

        bot = Device(target, authenticator)
        await probe_device(bot)


if __name__ == "__main__":
    asyncio.run(main())
