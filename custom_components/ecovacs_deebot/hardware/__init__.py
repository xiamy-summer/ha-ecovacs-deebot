"""Bundled hardware definitions for models not (yet) in the deebot_client library.

内置机型定义：
  - jkzzec: DEEBOT T90 PRO 上下水款（SHAKESPEARE_WH_AUTO），基于 T90 PRO OMNI (twunby)
"""

from __future__ import annotations

import asyncio
from importlib import import_module
from typing import TYPE_CHECKING

from deebot_client.logging_filter import get_logger

if TYPE_CHECKING:
    from deebot_client.models import StaticDeviceInfo

__all__ = ["get_bundled_static_device_info", "SUPPORTED_CLASSES"]

_LOGGER = get_logger(__name__)

# class_id -> 本包内的模块名
_BUNDLED: dict[str, str] = {
    "jkzzec": "jkzzec",
}

_DEVICES: dict[str, StaticDeviceInfo] = {}


async def get_bundled_static_device_info(class_id: str) -> StaticDeviceInfo | None:
    """Get bundled static device info for the given class id, if defined."""
    if module_name := _BUNDLED.get(class_id):
        if (info := _DEVICES.get(class_id)) is not None:
            return info
        try:
            module = await asyncio.to_thread(
                import_module, f".{module_name}", __package__
            )
        except ImportError:
            _LOGGER.exception("Failed to load bundled definition for %s", class_id)
            return None
        device = module.get_device_info()
        _DEVICES[class_id] = device
        _LOGGER.debug("Loaded bundled capabilities for %s", class_id)
        return device
    return None


SUPPORTED_CLASSES = tuple(_BUNDLED)
