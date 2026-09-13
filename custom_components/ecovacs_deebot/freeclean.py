"""freeClean 9 字段房间清洁值编码器（T90 系固件）。

Ported from:
  https://github.com/Osezno-byte/ecovacs-omni-ha
  (custom_components/ecovacs_omni_supplement/freeclean.py, MIT License)
  Copyright (c) Osezno-byte

Licensed under the MIT License; incorporated into this GPL-3.0 project with
attribution. Protocol notes kept from the original implementation:

固件将每个房间片段解析为固定 9 字段向量；字段“数量”错误会触发固件
C++ ``vector::_M_range_check`` 硬错误（code 1000），因此本模块在发出前
断言每段恰好 9 个字段。

线上验证参考（单房间，area 3，2 遍，安静吸力，纯扫）::

    "1,3,,2,1000,30,1,1,0"   ->  {code: 0, "ok"}

字段布局（``1,<areaID>,,<passes>,<suction>,<water>,<mopType>,1,0``）：

    f0 常量 1   f1 房间 ID   f2 空   f3 遍数   f4 吸力
    f5 水量     f6 拖地模式  f7 常量 1          f8 常量 0

本模块为纯字符串构建，无 Home Assistant / deebot-client 依赖，便于单测。
"""

from __future__ import annotations

import re
from collections.abc import Iterable

FIELDS_PER_SEGMENT = 9

# 吸力代码（f4）。来源 ecovacs-deebot.js CLEAN_SPEED_TO_ECOVACS
# （{1:1000, 2:0, 3:1, 4:2}），与 HA 扫地机实体的风速标签一致。
SUCTION_CODES: dict[str, str] = {
    "quiet": "1000",
    "normal": "0",
    "max": "1",
    "max_plus": "2",
}

# 拖地模式 / workmode 代码（f6）。来源 ecovacs-deebot.js WORKMODE_TO_ECOVACS。
WORKMODE_CODES: dict[str, str] = {
    "vacuum_and_mop": "0",
    "vacuum": "1",
    "mop": "2",
    "mop_after_vacuum": "3",
}

# 各工作模式的默认水量（f5）：吸尘约 30，拖地约 20。
_DEFAULT_WATER: dict[str, int] = {
    "vacuum_and_mop": 20,
    "vacuum": 30,
    "mop": 20,
    "mop_after_vacuum": 20,
}

DEFAULT_PASSES = 1  # 与既有行为一致；Osezno 实测 2，遍数 >2 未在 1.93.0 验证
DEFAULT_SUCTION = "quiet"
DEFAULT_WORKMODE = "vacuum"

# 供服务/选项流选择器使用的标签列表。
SUCTION_LABELS = list(SUCTION_CODES)
WORKMODE_LABELS = list(WORKMODE_CODES)


class FreeCleanError(ValueError):
    """Raised when a freeClean value would be malformed (bad param or field count)."""


def _suction_code(suction: str) -> str:
    try:
        return SUCTION_CODES[suction]
    except KeyError:
        raise FreeCleanError(
            f"unknown suction {suction!r}; expected one of {SUCTION_LABELS}"
        ) from None


def _workmode_code(workmode: str) -> str:
    try:
        return WORKMODE_CODES[workmode]
    except KeyError:
        raise FreeCleanError(
            f"unknown workmode {workmode!r}; expected one of {WORKMODE_LABELS}"
        ) from None


def build_room_segment(
    area_id: int | str,
    *,
    passes: int = DEFAULT_PASSES,
    suction: str = DEFAULT_SUCTION,
    workmode: str = DEFAULT_WORKMODE,
    water: int | None = None,
) -> str:
    """Build one 9-field room segment.

    ``1,<areaID>,,<passes>,<suction>,<water>,<mopType>,1,0``
    """
    area = str(area_id).strip()
    if not area:
        raise FreeCleanError("area_id must be non-empty")
    # 区域 ID 是固件地图分段 ID：仅允许 ASCII 数字。字段数校验无法拦截
    # "3 3"、"abc" 之类的垃圾输入（仍是一个字段），因此在这里用正则校验。
    if not re.fullmatch(r"[0-9]+", area):
        raise FreeCleanError(f"area_id {area!r} must be a numeric room id")
    try:
        passes_i = int(passes)
    except (TypeError, ValueError):
        raise FreeCleanError(f"passes must be an integer, got {passes!r}") from None
    if passes_i < 1:
        raise FreeCleanError(f"passes must be >= 1, got {passes_i}")

    suction_code = _suction_code(suction)
    mop_code = _workmode_code(workmode)
    water_i = int(_DEFAULT_WATER[workmode] if water is None else water)

    segment = f"1,{area},,{passes_i},{suction_code},{water_i},{mop_code},1,0"
    _assert_segment(segment)
    return segment


def build_value(
    area_ids: Iterable[int | str],
    *,
    passes: int = DEFAULT_PASSES,
    suction: str = DEFAULT_SUCTION,
    workmode: str = DEFAULT_WORKMODE,
    water: int | None = None,
) -> str:
    """Build a ``;``-joined freeClean value for one or more rooms sharing params."""
    ids = [str(a).strip() for a in area_ids if str(a).strip()]
    if not ids:
        raise FreeCleanError("at least one area id is required")
    segments = [
        build_room_segment(
            a, passes=passes, suction=suction, workmode=workmode, water=water
        )
        for a in ids
    ]
    return ";".join(segments)


def _assert_segment(segment: str) -> None:
    n = len(segment.split(","))
    if n != FIELDS_PER_SEGMENT:
        raise FreeCleanError(
            f"freeClean segment must have exactly {FIELDS_PER_SEGMENT} fields, "
            f"got {n}: {segment!r} (a wrong field count throws a firmware "
            "vector range_check error)"
        )


def assert_valid_value(value: str) -> str:
    """Validate *and normalize* a full ``;``-joined freeClean value.

    Strips surrounding and per-field whitespace, tolerates a trailing or doubled
    ``;``, and asserts every segment has exactly 9 fields. Returns the
    **normalized** value — use the return, not the input — so a hand-pasted
    scenario with stray spaces never dispatches a non-numeric ``f0`` to the
    firmware. Raises :class:`FreeCleanError` on a bad field count or an
    all-empty value.
    """
    if not value or not value.strip():
        raise FreeCleanError("freeClean value is empty")
    segments: list[str] = []
    for raw in value.split(";"):
        seg = raw.strip()
        if not seg:
            continue  # tolerate a trailing or doubled ';'
        # 字段数由逗号决定，字段内部空白不影响计数。
        _assert_segment(seg)
        segments.append(",".join(field.strip() for field in seg.split(",")))
    if not segments:
        raise FreeCleanError("freeClean value has no segments")
    return ";".join(segments)
