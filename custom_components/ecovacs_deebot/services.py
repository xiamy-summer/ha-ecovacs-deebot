"""Ecovacs services."""

import voluptuous as vol

from homeassistant.components.vacuum import DOMAIN as VACUUM_DOMAIN
from homeassistant.core import HomeAssistant, SupportsResponse, callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import service

from .const import DOMAIN

SERVICE_RAW_GET_POSITIONS = "raw_get_positions"
SERVICE_GET_CLEAN_SCENARIOS = "get_clean_scenarios"
SERVICE_RUN_SCENARIO = "run_scenario"

ATTR_SCENARIO = "scenario"

# 传普通 dict（而非 vol.Schema 实例）：HA 会经 make_entity_service_schema
# 自动补全 entity_id 处理，避免不同 HA 版本的 entity service schema 校验差异。
RUN_SCENARIO_SCHEMA = {
    vol.Required(ATTR_SCENARIO): cv.string,
}


@callback
def async_setup_services(hass: HomeAssistant) -> None:
    """Set up services."""

    # Vacuum Services
    service.async_register_platform_entity_service(
        hass,
        DOMAIN,
        SERVICE_RAW_GET_POSITIONS,
        entity_domain=VACUUM_DOMAIN,
        schema=None,
        func="async_raw_get_positions",
        supports_response=SupportsResponse.ONLY,
    )
    service.async_register_platform_entity_service(
        hass,
        DOMAIN,
        SERVICE_GET_CLEAN_SCENARIOS,
        entity_domain=VACUUM_DOMAIN,
        schema=None,
        func="async_get_scenarios",
        supports_response=SupportsResponse.ONLY,
    )
    service.async_register_platform_entity_service(
        hass,
        DOMAIN,
        SERVICE_RUN_SCENARIO,
        entity_domain=VACUUM_DOMAIN,
        schema=RUN_SCENARIO_SCHEMA,
        func="async_run_scenario",
        supports_response=SupportsResponse.NONE,
    )
