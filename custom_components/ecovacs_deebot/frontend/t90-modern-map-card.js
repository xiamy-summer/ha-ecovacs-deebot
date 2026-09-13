/**
 * 科沃斯 T90 现代简约地图卡片 (t90-modern-map-card)
 *
 * 基于项目内置的地图卡片重设计：现代化、简约风格。
 * 功能：地图缩放/全屏、房间点选、吸力/模式选择、区域清扫、停止清扫。
 *
 * 本文件是 ha-ecovacs-deebot 项目的一部分（GPL-3.0）。
 * 地图协议兼容实现参考并移植自：
 *   https://github.com/lifujie25/ha-ecovacs-t90-pro (GPL-3.0)
 *   https://github.com/Osezno-byte/ecovacs-omni-ha (MIT)
 */
class T90ModernMapCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = {};
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  setConfig(config) {
    this._config = { ...config };
    this._render();
  }

  _render() {
    if (!this._hass) return;
    this.shadowRoot.innerHTML = `
      <style>
        .form { display: grid; gap: 16px; padding: 8px 0; }
        ha-textfield, ha-entity-picker { width: 100%; }
        .hint { color: var(--secondary-text-color); font-size: 13px; line-height: 1.5; }
        .order-section {
          border: 1px solid var(--divider-color); border-radius: 8px; padding: 12px;
        }
        .toggles { display: grid; gap: 10px; }
        .toggles label {
          display: flex; align-items: center; gap: 10px; font-size: 14px; cursor: pointer;
        }
        .order-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
        .order-title { font-weight: 600; font-size: 14px; }
        .order-load {
          border: 0; border-radius: 6px; padding: 6px 12px; cursor: pointer;
          background: var(--primary-color); color: var(--text-primary-color, #fff); font-size: 13px;
        }
        .order-list { display: grid; gap: 6px; }
        .order-row {
          display: flex; align-items: center; gap: 6px; touch-action: none; cursor: grab;
          padding: 6px 8px; border-radius: 6px; background: var(--secondary-background-color, #f5f5f5);
          border: 1px solid transparent;
        }
        .order-row.dragging {
          opacity: .5; cursor: grabbing;
          border: 1px dashed var(--primary-color);
        }
        .order-row button {
          width: 28px; height: 26px; border: 1px solid var(--divider-color); border-radius: 6px;
          background: var(--card-background-color, #fff); cursor: pointer; font-size: 13px;
          touch-action: auto;
        }
        .order-row button:disabled { opacity: .35; cursor: default; }
        .order-empty { color: var(--secondary-text-color); font-size: 13px; }
      </style>
      <div class="form">
        <ha-textfield class="title" label="卡片标题"></ha-textfield>
        <ha-entity-picker class="image" label="地图图像实体（必选）"></ha-entity-picker>
        <ha-entity-picker class="vacuum" label="扫地机器人实体（必选）"></ha-entity-picker>
        <ha-textfield class="interval" type="number" min="5" max="300"
          label="刷新间隔（秒）"></ha-textfield>
        <ha-entity-picker class="status-entity" label="附加状态实体（可选，如基站/烘干传感器）"
          clearable></ha-entity-picker>
        <div class="order-head" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <span style="font-weight:600;font-size:14px">显示开关</span>
        </div>
        <div class="toggles">
          <label><ha-switch class="t-rooms"></ha-switch>区域选择行</label>
          <label><ha-switch class="t-params"></ha-switch>清扫参数（吸力/模式/水量/次数）</label>
          <label><ha-switch class="t-dock"></ha-switch>返回基站按钮</label>
          <label><ha-switch class="t-locate"></ha-switch>定位按钮</label>
        </div>
        <div class="order-head">
          <span class="order-title">区域排序</span>
          <button class="order-load">重新载入列表</button>
        </div>
        <div class="order-section">
          <div class="order-list"></div>
          <div class="order-empty" style="display:none"></div>
          <div class="hint" style="margin-top:8px">
            拖动房间可调整顺序（也可用 ↑↓）。排序保存在仪表盘配置中，PC/APP 同步生效。
          </div>
        </div>
        <div class="hint">
          选择官方 Ecovacs 集成生成的地图图像实体和扫地机器人实体。
          工作期间会按间隔刷新，空闲时最多每分钟刷新一次。
          附加状态实体的状态会显示在卡片标题栏（如烘干、基站状态等传感器）。
          多个实体可用 YAML 配置 status_entities 列表。
        </div>
      </div>`;

    const title = this.shadowRoot.querySelector(".title");
    title.value = this._config.title || "T90 地图";
    title.addEventListener("input", (event) => {
      this._updateConfig("title", event.target.value);
    });

    const image = this.shadowRoot.querySelector(".image");
    image.hass = this._hass;
    image.value = this._config.image_entity || "";
    image.includeDomains = ["image"];
    image.allowCustomEntity = true;
    image.addEventListener("value-changed", (event) => {
      this._updateConfig("image_entity", event.detail.value);
    });

    const vacuum = this.shadowRoot.querySelector(".vacuum");
    vacuum.hass = this._hass;
    vacuum.value = this._config.vacuum_entity || "";
    vacuum.includeDomains = ["vacuum"];
    vacuum.allowCustomEntity = true;
    vacuum.addEventListener("value-changed", (event) => {
      this._updateConfig("vacuum_entity", event.detail.value);
    });

    const interval = this.shadowRoot.querySelector(".interval");
    interval.value = String(this._config.refresh_interval || 10);
    interval.addEventListener("input", (event) => {
      this._updateConfig(
        "refresh_interval",
        Math.min(300, Math.max(5, Number(event.target.value) || 10)),
      );
    });

    const statusEntity = this.shadowRoot.querySelector(".status-entity");
    statusEntity.hass = this._hass;
    const current = this._config.status_entities ?? this._config.status_entity;
    statusEntity.value = Array.isArray(current) ? current[0] || "" : current || "";
    statusEntity.includeDomains = ["binary_sensor", "sensor"];
    statusEntity.allowCustomEntity = true;
    statusEntity.addEventListener("value-changed", (event) => {
      this._updateConfig("status_entity", event.detail.value || "");
    });

    this._roomsForOrder = null;
    this.shadowRoot.querySelector(".order-load").addEventListener("click", () => {
      this._roomsForOrder = null; // 强制重新拉取
      this._loadRoomsForOrder();
    });
    // 显示开关
    const toggleMap = [
      [".t-rooms", "show_rooms", true],
      [".t-params", "show_params", true],
      [".t-dock", "show_dock", true],
      [".t-locate", "show_locate", true],
    ];
    for (const [selector, key, defaultValue] of toggleMap) {
      const sw = this.shadowRoot.querySelector(selector);
      sw.checked = this._config[key] !== false ? true : false;
      if (this._config[key] === undefined) sw.checked = defaultValue;
      sw.addEventListener("change", () => {
        this._updateConfig(key, sw.checked);
      });
    }
    // 房间列表已缓存时直接渲染，无需重新载入
    if (this._roomsForOrder) {
      this._renderOrderList();
    } else if (this._config.image_entity) {
      this._loadRoomsForOrder();
    }
  }

  async _loadRoomsForOrder() {
    const empty = this.shadowRoot.querySelector(".order-empty");
    const list = this.shadowRoot.querySelector(".order-list");
    if (!empty || !list) return;
    const entity = this._hass?.states[this._config.image_entity];
    const picture = entity?.attributes?.entity_picture;
    if (!picture) {
      empty.style.display = "";
      empty.textContent = "请先选择地图图像实体";
      return;
    }
    empty.style.display = "";
    empty.textContent = "正在读取地图…";
    list.replaceChildren();
    try {
      const separator = picture.includes("?") ? "&" : "?";
      const url = this._hass.hassUrl(`${picture}${separator}_t90order=${Date.now()}`);
      const response = await fetch(url, { credentials: "same-origin" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const svgText = await response.text();
      const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
      const rooms = new Map();
      doc.querySelectorAll("[data-room-id]").forEach((el) => {
        const id = Number(el.getAttribute("data-room-id"));
        if (!rooms.has(id)) {
          rooms.set(id, {
            id,
            name: el.getAttribute("data-room-name") || `区域 ${id}`,
          });
        }
      });
      this._roomsForOrder = [...rooms.values()];
      if (!this._roomsForOrder.length) {
        empty.textContent = "地图中未找到房间信息（请确认机器人已保存过地图）";
        return;
      }
      empty.style.display = "none";
      this._renderOrderList();
    } catch (error) {
      empty.textContent = `读取失败：${error.message}`;
    }
  }

  _renderOrderList() {
    const list = this.shadowRoot.querySelector(".order-list");
    if (!list || !this._roomsForOrder) return;
    const known = this._roomsForOrder;
    const configured = (this._config.room_order || []).map(Number);
    let order = configured.filter((id) => known.some((room) => room.id === id));
    for (const room of known) {
      if (!order.includes(room.id)) order.push(room.id);
    }
    list.replaceChildren();
    order.forEach((id, index) => {
      const room = known.find((item) => item.id === id);
      const row = document.createElement("div");
      row.className = "order-row";
      row.dataset.roomId = String(id);
      const name = document.createElement("span");
      name.className = "order-name";
      name.style.cssText = "flex:1;font-size:13px";
      name.textContent = room?.name || `区域 ${id}`;
      const up = document.createElement("button");
      up.textContent = "↑";
      up.disabled = index === 0;
      up.addEventListener("click", () => {
        [order[index - 1], order[index]] = [order[index], order[index - 1]];
        this._updateConfig("room_order", [...order]);
        this._renderOrderList();
      });
      const down = document.createElement("button");
      down.textContent = "↓";
      down.disabled = index === order.length - 1;
      down.addEventListener("click", () => {
        [order[index + 1], order[index]] = [order[index], order[index + 1]];
        this._updateConfig("room_order", [...order]);
        this._renderOrderList();
      });
      row.append(name, up, down);
      // 拖拽排序（触屏/鼠标通用；按钮区域不触发）
      row.addEventListener("pointerdown", (event) => {
        if (event.target.closest("button") || event.button !== 0) return;
        event.preventDefault();
        row.setPointerCapture(event.pointerId);
        row.classList.add("dragging");
        const onMove = (moveEvent) => {
          const el = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
          const target = el?.closest?.(".order-row");
          if (!target || target === row || target.parentElement !== list) return;
          const rect = target.getBoundingClientRect();
          const insertBefore = moveEvent.clientY < rect.top + rect.height / 2;
          list.insertBefore(row, insertBefore ? target : target.nextSibling);
        };
        const onUp = () => {
          row.classList.remove("dragging");
          row.removeEventListener("pointermove", onMove);
          row.removeEventListener("pointerup", onUp);
          row.removeEventListener("pointercancel", onUp);
          const newOrder = [...list.querySelectorAll(".order-row")]
            .map((el) => Number(el.dataset.roomId));
          this._updateConfig("room_order", newOrder);
          this._renderOrderList();
        };
        row.addEventListener("pointermove", onMove);
        row.addEventListener("pointerup", onUp);
        row.addEventListener("pointercancel", onUp);
      });
      list.append(row);
    });
  }

  _updateConfig(key, value) {
    const config = { ...this._config, [key]: value };
    this._config = config;
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config },
        bubbles: true,
        composed: true,
      }),
    );
  }
}

const ICONS = {
  robot: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="2.6"/><path d="M12 3.8v2.4M9 20.2h6"/></svg>`,
  expand: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/></svg>`,
  close: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  zoomIn: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6M11 8v6"/></svg>`,
  zoomOut: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6"/></svg>`,
  reset: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/></svg>`,
  play: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>`,
  stop: `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><rect x="6.5" y="6.5" width="11" height="11" rx="2"/></svg>`,
  dock: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11.5 12 4l8 7.5"/><path d="M6.5 10v9h11v-9"/><rect x="9.6" y="13.6" width="4.8" height="3" rx="0.8"/></svg>`,
  locate: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3"/><circle cx="12" cy="12" r="7.2"/></svg>`,
  check: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5 10-11"/></svg>`,
  swap: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v13m0 0l-3.5-3.5M7 17l3.5-3.5M17 20V7m0 0l-3.5 3.5M17 7l3.5 3.5"/></svg>`,
};

class T90ModernMapCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._zoom = 1;
    this._dialogZoom = 1;
    this._selectedRooms = new Map();
    this._availableRooms = new Map();
    this._refreshing = false;
    this._cleaning = false;
    this._stopping = false;
    this._lastRefresh = 0;
    this._timer = null;
    this._roomOrder = [];
    this._resizeObserver = null;
    this._dragId = null;
  }

  setConfig(config) {
    if (!config.image_entity || !config.vacuum_entity) {
      throw new Error("image_entity and vacuum_entity are required");
    }
    this._config = {
      title: "T90 地图",
      refresh_interval: 10,
      show_rooms: true,
      show_params: true,
      show_dock: true,
      show_locate: true,
      ...config,
    };
    this._roomOrder = this._loadRoomOrder();
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    this._updateVacuumState();
    if (!this._mapLoaded) this._loadMap();
  }

  connectedCallback() {
    this._startTimer();
  }

  disconnectedCallback() {
    if (this._timer) window.clearInterval(this._timer);
    this._timer = null;
  }

  getCardSize() {
    return 8;
  }

  static getConfigElement() {
    return document.createElement("t90-modern-map-card-editor");
  }

  static getStubConfig(hass) {
    const entityIds = Object.keys(hass?.states || {});
    const imageEntities = entityIds.filter((entityId) => entityId.startsWith("image."));
    const vacuumEntities = entityIds.filter((entityId) => entityId.startsWith("vacuum."));
    const preferredImage =
      imageEntities.find((entityId) => entityId.includes("t90") && entityId.endsWith("_map")) ||
      imageEntities.find((entityId) => entityId.endsWith("_map")) ||
      imageEntities[0] ||
      "";
    const preferredVacuum =
      vacuumEntities.find((entityId) => entityId.includes("t90")) ||
      vacuumEntities[0] ||
      "";

    return {
      title: "T90 地图",
      image_entity: preferredImage,
      vacuum_entity: preferredVacuum,
      refresh_interval: 10,
    };
  }

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card {
          overflow: hidden;
          border-radius: var(--ha-card-border-radius, 20px);
          border: 1px solid color-mix(in srgb, var(--primary-color, #03a9f4) 10%, var(--divider-color, transparent));
          box-shadow: 0 4px 24px rgb(0 0 0 / .06);
          background: var(--card-background-color, #fff);
        }

        /* ---------- 头部 ---------- */
        .header {
          display: flex; align-items: center; gap: 11px;
          padding: 14px 16px 12px;
        }
        .logo {
          width: 34px; height: 34px; border-radius: 11px; flex: 0 0 auto;
          display: flex; align-items: center; justify-content: center; color: #fff;
          background: linear-gradient(135deg,
            var(--primary-color, #03a9f4),
            color-mix(in srgb, var(--primary-color, #03a9f4) 45%, #7c4dff));
        }
        .logo svg { width: 19px; height: 19px; }
        .title {
          min-width: 0; flex: 1; font-size: 15px; font-weight: 600;
          letter-spacing: .1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .status {
          display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto;
          font-size: 12.5px; font-weight: 500; white-space: nowrap;
          color: var(--status-color, var(--secondary-text-color));
        }
        .status .dot {
          width: 7px; height: 7px; border-radius: 50%;
          background: var(--status-color, var(--secondary-text-color));
        }
        .status.cleaning .dot { animation: t90-modern-pulse 1.4s ease-in-out infinite; }
        @keyframes t90-modern-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: .3; transform: scale(.65); }
        }
        .extra-status {
          display: inline-flex; align-items: center; gap: 10px; flex: 0 0 auto;
        }
        .extra-status .status { font-size: 12px; }
        .ghost-btn {
          width: 32px; height: 32px; flex: 0 0 auto;
          display: inline-flex; align-items: center; justify-content: center;
          border: 0; border-radius: 10px; padding: 0; cursor: pointer;
          color: var(--secondary-text-color); background: transparent;
          transition: background .15s, color .15s;
        }
        .ghost-btn:hover { color: var(--primary-color); background: color-mix(in srgb, var(--primary-color) 10%, transparent); }
        .ghost-btn:active { transform: scale(.92); }

        /* ---------- 地图 ---------- */
        .viewport {
          margin: 0 12px; border-radius: 14px; overflow: auto;
          background:
            radial-gradient(circle at 50% 0%,
              color-mix(in srgb, var(--primary-color, #03a9f4) 6%, transparent), transparent 62%),
            var(--secondary-background-color, #f5f5f5);
          overscroll-behavior: contain;
          transition: height .3s ease;
        }
        .map {
          display: flex; min-width: 100%; min-height: 100%;
          align-items: center; justify-content: center; padding: 12px; box-sizing: border-box;
        }
        .map svg {
          display: block; flex: 0 0 auto; height: auto; max-width: none;
          touch-action: pan-x pan-y; border-radius: 8px;
        }
        .loading, .error { margin: auto; padding: 36px; color: var(--secondary-text-color); }
        .loading { display: flex; align-items: center; gap: 10px; font-size: 13.5px; }
        .loading::before {
          content: ""; width: 16px; height: 16px; border-radius: 50%;
          border: 2px solid var(--divider-color); border-top-color: var(--primary-color);
          animation: t90-modern-spin .9s linear infinite;
        }
        @keyframes t90-modern-spin { to { transform: rotate(360deg); } }
        .error { color: var(--error-color, #f44336); font-size: 13.5px; }

        /* ---------- 区域选择 ---------- */
        .rooms { display: flex; align-items: center; gap: 7px;
          padding: 12px 16px 4px; overflow-x: auto; scrollbar-width: none; }
        .rooms::-webkit-scrollbar { display: none; }
        .sort-toggle.active {
          color: var(--primary-color);
          background: color-mix(in srgb, var(--primary-color) 12%, transparent);
        }
        .rooms.sorting .room-chip {
          touch-action: none; cursor: grabbing;
          border-color: color-mix(in srgb, var(--primary-color) 45%, transparent);
        }
        .rooms-label {
          flex: 0 0 auto; color: var(--secondary-text-color); font-size: 12.5px; margin-right: 3px;
        }
        .room-chip {
          flex: 0 0 auto; height: 31px; padding: 0 13px;
          display: inline-flex; align-items: center; gap: 5px; cursor: pointer;
          border: 1px solid var(--divider-color); border-radius: 15px;
          background: transparent; color: var(--primary-text-color);
          font-size: 12.5px; font-weight: 500;
          transition: all .15s ease;
        }
        .room-chip:hover { border-color: var(--primary-color); color: var(--primary-color); }
        .room-chip:active { transform: scale(.95); }
        .room-chip.selected {
          border-color: var(--primary-color); color: var(--primary-color);
          background: color-mix(in srgb, var(--primary-color) 12%, transparent);
          font-weight: 600;
        }
        .room-chip.selected svg { display: inline-block; }
        .room-chip svg { display: none; }
        .room-chip.selected svg { display: inline-block; }
        .room-chip[draggable="true"] { cursor: grab; }
        .room-chip.dragging { opacity: .4; border-style: dashed; }
        .room-chip.clear {
          color: var(--error-color, #f44336);
          border-color: color-mix(in srgb, var(--error-color, #f44336) 35%, transparent);
        }

        /* ---------- 参数 ---------- */
        .params {
          display: flex; align-items: center; gap: 8px;
          padding: 8px 16px 4px; flex-wrap: wrap;
        }
        .param {
          display: inline-flex; align-items: center; gap: 6px;
        }
        .param-label { color: var(--secondary-text-color); font-size: 12.5px; }
        .param select {
          height: 29px; padding: 0 26px 0 10px;
          border: 1px solid var(--divider-color); border-radius: 14px;
          background: transparent; color: var(--primary-text-color);
          font-size: 12.5px; cursor: pointer; outline: none; appearance: none;
          background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23888' stroke-width='1.6' stroke-linecap='round'/%3E%3C/svg%3E");
          background-repeat: no-repeat; background-position: right 9px center;
          transition: border-color .15s;
        }
        .param select:hover, .param select:focus { border-color: var(--primary-color); }

        /* ---------- 底部操作栏 ---------- */
        .actionbar {
          display: flex; align-items: center; gap: 10px;
          padding: 12px 16px 14px;
        }
        .tool-group {
          display: inline-flex; align-items: center; gap: 2px; flex: 0 0 auto;
          padding: 3px; border-radius: 12px;
          background: var(--secondary-background-color, #f5f5f5);
        }
        .tool-btn {
          width: 30px; height: 30px; padding: 0; border: 0; border-radius: 9px;
          display: inline-flex; align-items: center; justify-content: center;
          background: transparent; color: var(--primary-text-color); cursor: pointer;
          transition: background .15s, color .15s;
        }
        .tool-btn:hover { color: var(--primary-color); background: color-mix(in srgb, var(--primary-color) 10%, transparent); }
        .tool-btn:active { transform: scale(.9); }
        .spacer { flex: 1; }
        .action-btn {
          height: 38px; padding: 0 18px; border: 0; border-radius: 19px; flex: 0 0 auto;
          display: inline-flex; align-items: center; justify-content: center; gap: 7px;
          font-size: 13.5px; font-weight: 600; letter-spacing: .2px; cursor: pointer;
          transition: filter .15s, transform .1s, opacity .15s, box-shadow .15s;
        }
        .action-btn:active { transform: scale(.96); }
        .action-btn:disabled { opacity: .35; cursor: default; transform: none; }
        .action-btn.clean {
          color: #fff; background: var(--primary-color);
          box-shadow: 0 3px 12px color-mix(in srgb, var(--primary-color) 38%, transparent);
        }
        .action-btn.clean:hover:not(:disabled) { filter: brightness(1.07); }
        .action-btn.stop {
          color: var(--error-color, #f44336);
          background: color-mix(in srgb, var(--error-color, #f44336) 10%, transparent);
        }
        .action-btn.stop:hover:not(:disabled) { background: color-mix(in srgb, var(--error-color, #f44336) 18%, transparent); }

        /* ---------- 命令状态 ---------- */
        .command-status {
          min-height: 16px; padding: 0 16px 11px;
          color: var(--secondary-text-color); font-size: 12.5px; text-align: center;
        }
        .command-status:empty { display: none; }
        .command-status.error { color: var(--error-color, #f44336); }
        .command-status.success { color: var(--success-color, #2e7d32); }

        /* ---------- 全屏弹窗 ---------- */
        dialog.map-dialog {
          width: min(96vw, 1440px); height: 92vh; max-width: none; max-height: none;
          margin: auto; padding: 0; border: 0; border-radius: 20px;
          color: var(--primary-text-color); background: var(--card-background-color, #fff);
          box-shadow: 0 12px 48px rgb(0 0 0 / .32); overflow: hidden;
        }
        dialog.map-dialog::backdrop { background: rgb(0 0 0 / .55); }
        .dialog-layout { height: 100%; display: flex; flex-direction: column; }
        .dialog-header {
          display: flex; align-items: center; gap: 10px; flex: 0 0 auto;
          padding: 12px 12px 12px 18px;
        }
        .dialog-title { min-width: 0; flex: 1; font-size: 15px; font-weight: 600; }
        .dialog-scale { min-width: 44px; color: var(--secondary-text-color); text-align: right; font-size: 12.5px; }
        .dialog-viewport {
          min-height: 0; flex: 1 1 auto; margin: 0 14px; border-radius: 14px;
          overflow: auto; overscroll-behavior: contain;
          background: var(--secondary-background-color, #f5f5f5);
        }
        .dialog-map {
          display: flex; min-width: 100%; min-height: 100%;
          align-items: center; justify-content: center; padding: 12px; box-sizing: border-box;
        }
        .dialog-map svg {
          display: block; flex: 0 0 auto; height: auto; max-width: none;
          touch-action: pan-x pan-y; border-radius: 8px;
        }
        .dialog-footer {
          display: flex; align-items: center; gap: 8px; flex: 0 0 auto;
          padding: 12px 14px 14px; justify-content: center;
        }
        @media (max-width: 600px) {
          .viewport { height: 52vh; min-height: 280px; }
          .actionbar { flex-wrap: wrap; }
          .action-btn.clean, .action-btn.stop { flex: 1 1 100%; border-radius: 12px; }
          dialog.map-dialog { width: 100vw; height: 100dvh; border-radius: 0; }
        }
      </style>
      <ha-card>
        <div class="header">
          <div class="logo">${ICONS.robot}</div>
          <div class="title"></div>
          <span class="extra-status"></span>
          <div class="status"><span class="dot"></span><span class="status-text"></span></div>
          <button class="ghost-btn expand" title="全屏查看" aria-label="全屏查看">${ICONS.expand}</button>
        </div>
        <div class="viewport"><div class="map"><div class="loading">正在加载地图</div></div></div>
        <div class="rooms"><button class="tool-btn sort-toggle" title="排序模式" aria-label="排序模式">${ICONS.swap}</button><span class="rooms-label">未选择区域</span></div>
        <div class="params">
          <span class="param">
            <span class="param-label">吸力</span>
            <select class="param-suction" aria-label="清扫吸力">
              <option value="">跟随设置</option>
              <option value="quiet">安静</option>
              <option value="normal">标准</option>
              <option value="max">强力</option>
              <option value="max_plus">强力+</option>
            </select>
          </span>
          <span class="param">
            <span class="param-label">模式</span>
            <select class="param-mop" aria-label="清扫模式">
              <option value="">跟随设置</option>
              <option value="vacuum">纯扫</option>
              <option value="mop">纯拖</option>
              <option value="vacuum_and_mop">扫拖同启</option>
              <option value="mop_after_vacuum">扫后拖</option>
            </select>
          </span>
          <span class="param">
            <span class="param-label">水量</span>
            <select class="param-water" aria-label="出水量">
              <option value="">跟随设置</option>
              <option value="20">低</option>
              <option value="25">中</option>
              <option value="30">高</option>
            </select>
          </span>
          <span class="param">
            <span class="param-label">次数</span>
            <select class="param-passes" aria-label="清扫次数">
              <option value="1">1 次</option>
              <option value="2">2 次</option>
              <option value="3">3 次</option>
            </select>
          </span>
        </div>
        <div class="actionbar">
          <span class="tool-group">
            <button class="tool-btn zoom-out" title="缩小" aria-label="缩小">${ICONS.zoomOut}</button>
            <button class="tool-btn zoom-in" title="放大" aria-label="放大">${ICONS.zoomIn}</button>
            <button class="tool-btn refresh" title="刷新地图和位置" aria-label="刷新地图和位置">${ICONS.refresh}</button>
            <button class="tool-btn locate" title="定位扫地机" aria-label="定位扫地机">${ICONS.locate}</button>
            <button class="tool-btn dock" title="返回基站" aria-label="返回基站">${ICONS.dock}</button>
          </span>
          <span class="spacer"></span>
          <button class="action-btn stop" disabled>${ICONS.stop}<span>停止</span></button>
          <button class="action-btn clean" disabled>${ICONS.play}<span>清扫全屋</span></button>
        </div>
        <div class="command-status" aria-live="polite"></div>
      </ha-card>
      <dialog class="map-dialog" aria-label="T90 地图全屏">
        <div class="dialog-layout">
          <div class="dialog-header">
            <div class="dialog-title"></div>
            <div class="dialog-scale">100%</div>
            <button class="ghost-btn dialog-close" title="关闭" aria-label="关闭">${ICONS.close}</button>
          </div>
          <div class="dialog-viewport"><div class="dialog-map"></div></div>
          <div class="dialog-footer">
            <span class="tool-group">
              <button class="tool-btn dialog-zoom-out" title="缩小" aria-label="缩小">${ICONS.zoomOut}</button>
              <button class="tool-btn dialog-reset" title="恢复 100%" aria-label="恢复 100%">${ICONS.reset}</button>
              <button class="tool-btn dialog-zoom-in" title="放大" aria-label="放大">${ICONS.zoomIn}</button>
            </span>
          </div>
        </div>
      </dialog>`;

    this.shadowRoot.querySelector(".title").textContent = this._config.title;
    this._mapElement = this.shadowRoot.querySelector(".map");
    this._roomsElement = this.shadowRoot.querySelector(".rooms");
    this._cleanButton = this.shadowRoot.querySelector(".clean");
    this._stopButton = this.shadowRoot.querySelector(".stop");
    this._dialog = this.shadowRoot.querySelector(".map-dialog");
    this._dialogMapElement = this.shadowRoot.querySelector(".dialog-map");
    this._extraStatusElement = this.shadowRoot.querySelector(".extra-status");
    this._roomsElement = this.shadowRoot.querySelector(".rooms");
    this._sorting = false;
    this.shadowRoot.querySelector(".sort-toggle").addEventListener("click", () => {
      this._sorting = !this._sorting;
      this.shadowRoot.querySelector(".sort-toggle").classList.toggle("active", this._sorting);
      this._roomsElement.classList.toggle("sorting", this._sorting);
    });
    this._viewport = this.shadowRoot.querySelector(".viewport");
    if (!this._resizeObserver) {
      this._resizeObserver = new ResizeObserver(() => this._applyZoom());
      this._resizeObserver.observe(this._viewport);
    }
    this._zoomStep = 1;
    this.shadowRoot.querySelector(".dialog-title").textContent = this._config.title;
    this.shadowRoot.querySelector(".expand").addEventListener("click", () => this._openMapDialog());
    this.shadowRoot.querySelector(".zoom-out").addEventListener("click", () => this._setZoom(this._zoom - 0.1));
    this.shadowRoot.querySelector(".zoom-in").addEventListener("click", () => this._setZoom(this._zoom + 0.1));
    this.shadowRoot.querySelector(".refresh").addEventListener("click", () => this._refreshMap(true));
    this.shadowRoot.querySelector(".dialog-close").addEventListener("click", () => this._dialog.close());
    this.shadowRoot.querySelector(".dialog-zoom-out").addEventListener("click", () => this._setDialogZoom(this._dialogZoom - 0.1));
    this.shadowRoot.querySelector(".dialog-zoom-in").addEventListener("click", () => this._setDialogZoom(this._dialogZoom + 0.1));
    this.shadowRoot.querySelector(".dialog-reset").addEventListener("click", () => this._setDialogZoom(1));
    this._dialog.addEventListener("click", (event) => {
      if (event.target === this._dialog) this._dialog.close();
    });
    this._dialog.addEventListener("wheel", (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      this._setDialogZoom(this._dialogZoom + (event.deltaY < 0 ? 0.1 : -0.1));
    }, { passive: false });
    this._viewport.addEventListener("wheel", (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      this._setZoom(this._zoom + (event.deltaY < 0 ? 0.1 : -0.1));
    }, { passive: false });
    this._cleanButton.addEventListener("click", () => this._cleanSelectedRooms());
    this._stopButton.addEventListener("click", () => this._stopCleaning());
    this.shadowRoot.querySelector(".dock").addEventListener("click", () =>
      this._vacuumAction("return_to_base", "正在发送返回基站命令…", "已发送返回基站命令"));
    this.shadowRoot.querySelector(".locate").addEventListener("click", () =>
      this._vacuumAction("locate", "正在定位扫地机…", "已发送定位命令"));
    // 按配置控制各区块显示
    const visibility = [
      [".rooms", this._config.show_rooms !== false],
      [".params", this._config.show_params !== false],
      [".dock", this._config.show_dock !== false],
      [".locate", this._config.show_locate !== false],
    ];
    for (const [selector, visible] of visibility) {
      const el = this.shadowRoot.querySelector(selector);
      if (el) el.style.display = visible ? "" : "none";
    }
    this._startTimer();
  }

  _startTimer() {
    if (this._timer || !this.isConnected || !this._config) return;
    const seconds = Math.max(5, Number(this._config.refresh_interval) || 10);
    this._timer = window.setInterval(() => {
      const vacuum = this._hass?.states[this._config.vacuum_entity];
      const active = ["cleaning", "returning", "paused"].includes(vacuum?.state);
      if (active || Date.now() - this._lastRefresh > 60000) this._refreshMap(false);
    }, seconds * 1000);
  }

  async _refreshMap(force) {
    if (!this._hass || this._refreshing) return;
    this._refreshing = true;
    try {
      await this._hass.callService("homeassistant", "update_entity", {
        entity_id: this._config.image_entity,
      });
      await new Promise((resolve) => window.setTimeout(resolve, force ? 500 : 250));
      await this._loadMap(true);
      this._lastRefresh = Date.now();
    } finally {
      this._refreshing = false;
    }
  }

  async _loadMap(cacheBust = false) {
    if (!this._hass || !this._config) return;
    const entity = this._hass.states[this._config.image_entity];
    const picture = entity?.attributes?.entity_picture;
    if (!picture) {
      this._showError("地图实体尚未提供图像");
      return;
    }
    try {
      const separator = picture.includes("?") ? "&" : "?";
      const url = this._hass.hassUrl(`${picture}${separator}_t90=${cacheBust ? Date.now() : 0}`);
      const response = await fetch(url, { credentials: "same-origin" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const svg = await response.text();
      if (!svg.includes("<svg")) throw new Error("Invalid SVG response");
      this._mapElement.innerHTML = svg;
      this._mapLoaded = true;
      this._availableRooms.clear();
      this._bindRoomEvents(this._mapElement, true);
      this._prepareSvg(this._mapElement.querySelector("svg"));
      // 等浏览器完成两帧布局后再计算自适应尺寸，避免卡片宽度未就绪导致初始尺寸偏差
      requestAnimationFrame(() => {
        requestAnimationFrame(() => this._applyZoom());
      });
      this._applySelection();
      if (this._dialog?.open) this._syncDialogMap();
    } catch (error) {
      this._showError(`地图加载失败: ${error.message}`);
    }
  }

  _showError(message) {
    if (this._mapElement) this._mapElement.innerHTML = `<div class="error"></div>`;
    const error = this._mapElement?.querySelector(".error");
    if (error) error.textContent = message;
  }

  _setZoom(value) {
    this._zoom = Math.min(3, Math.max(0.5, Math.round(value * 10) / 10));
    this._applyZoom();
  }

  _prepareSvg(svg) {
    if (!svg) return;
    // 剥离固定 width/height 属性，确保 viewBox 存在：
    // 固有尺寸会让 PC 端在按容器缩放前以原始大小渲染（APP 分辨率小反而不明显）
    const width = parseFloat(svg.getAttribute("width") || "");
    const height = parseFloat(svg.getAttribute("height") || "");
    if (!svg.getAttribute("viewBox") && Number.isFinite(width) && Number.isFinite(height) && width > 0) {
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    }
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    svg.style.maxWidth = "none";
  }

  _applyZoom(retried = 0) {
    const svg = this._mapElement?.querySelector("svg");
    if (!svg || !this._viewport) return;
    const view = svg.viewBox?.baseVal;
    if (!view?.width || !view?.height) return;
    // 卡片尚未完成布局（宽度为 0）时稍后重试
    if (this._viewport.clientWidth < 40) {
      if (retried < 20) requestAnimationFrame(() => this._applyZoom(retried + 1));
      return;
    }
    // 以视口实际宽度为基准计算像素宽高（按 viewBox 比例显式设置，杜绝固有尺寸干扰）
    const padding = 24;
    const base = Math.max(200, this._viewport.clientWidth - padding);
    const width = Math.round(base * this._zoom);
    const height = Math.round((width * view.height) / view.width);
    svg.style.width = `${width}px`;
    svg.style.height = `${height}px`;
    if (this._zoom === 1) {
      const fit = height + padding;
      const max = Math.max(280, Math.round(window.innerHeight * 0.62));
      this._viewport.style.height = `${Math.min(Math.max(fit, 260), max)}px`;
    }
  }

  _openMapDialog() {
    if (!this._dialog || !this._mapElement?.querySelector("svg")) return;
    this._dialogZoom = this._zoom;
    this._syncDialogMap();
    this._setDialogZoom(this._dialogZoom);
    if (!this._dialog.open) this._dialog.showModal();
  }

  _syncDialogMap() {
    const svg = this._mapElement?.querySelector("svg");
    if (!svg || !this._dialogMapElement) return;
    const clone = svg.cloneNode(true);
    // 清掉主地图的内联像素尺寸，让弹窗按自己的容器宽度缩放
    clone.style.width = "";
    clone.style.height = "";
    this._dialogMapElement.replaceChildren(clone);
    this._bindRoomEvents(this._dialogMapElement, false);
    this._applyDialogZoom();
    this._applySelection();
  }

  _setDialogZoom(value) {
    this._dialogZoom = Math.min(4, Math.max(0.4, Math.round(value * 10) / 10));
    const scale = this.shadowRoot.querySelector(".dialog-scale");
    if (scale) scale.textContent = `${Math.round(this._dialogZoom * 100)}%`;
    this._applyDialogZoom();
  }

  _applyDialogZoom() {
    const svg = this._dialogMapElement?.querySelector("svg");
    if (svg) svg.style.width = `${this._dialogZoom * 100}%`;
  }

  _bindRoomEvents(container, collectRooms) {
    container?.querySelectorAll("[data-room-id]").forEach((room) => {
      const id = Number(room.dataset.roomId);
      const name = room.dataset.roomName || `区域 ${id}`;
      if (collectRooms) this._availableRooms.set(id, name);
      room.addEventListener("pointerup", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this._toggleRoom(id, name);
      });
    });
  }

  _toggleRoom(id, name) {
    if (this._selectedRooms.has(id)) this._selectedRooms.delete(id);
    else this._selectedRooms.set(id, name);
    this._applySelection();
  }

  _orderKey() {
    return `t90-modern-room-order:${this._config?.vacuum_entity || "default"}`;
  }

  _loadRoomOrder() {
    try {
      const raw = JSON.parse(localStorage.getItem(this._orderKey()) || "[]");
      return Array.isArray(raw) ? raw.map(Number).filter(Number.isFinite) : [];
    } catch {
      return [];
    }
  }

  _saveRoomOrder() {
    try { localStorage.setItem(this._orderKey(), JSON.stringify(this._roomOrder)); } catch {}
  }

  _orderedRoomIds() {
    const available = [...this._availableRooms.keys()];
    // 优先级：编辑器配置 room_order > 本地拖拽排序 > 地图自然顺序
    const configured = (this._config?.room_order || []).map(Number);
    let order;
    if (configured.length) {
      order = configured.filter((id) => available.includes(id));
    } else {
      order = this._roomOrder.filter((id) => available.includes(id));
    }
    for (const id of available) {
      if (!order.includes(id)) order.push(id);
    }
    this._roomOrder = order;
    return order;
  }

  _statusEntityIds() {
    const raw =
      this._config.status_entities ??
      (this._config.status_entity ? [this._config.status_entity] : []);
    const list = Array.isArray(raw) ? raw : [raw];
    return list.filter((item) => typeof item === "string" && item);
  }

  _applySelection() {
    this._mapElement?.querySelectorAll("[data-room-id]").forEach((room) => {
      room.classList.toggle("t90-selected", this._selectedRooms.has(Number(room.dataset.roomId)));
    });
    this._dialogMapElement?.querySelectorAll("[data-room-id]").forEach((room) => {
      room.classList.toggle("t90-selected", this._selectedRooms.has(Number(room.dataset.roomId)));
    });
    if (!this._roomsElement) return;
    this._roomsElement.replaceChildren();
    const label = document.createElement("span");
    label.className = "rooms-label";
    label.textContent = this._selectedRooms.size ? `已选 ${this._selectedRooms.size} 个区域` : "未选择区域";
    this._roomsElement.append(label);
    for (const id of this._orderedRoomIds()) {
      const name = this._availableRooms.get(id);
      const chip = document.createElement("button");
      chip.className = "room-chip";
      chip.dataset.roomId = String(id);
      const selected = this._selectedRooms.has(id);
      chip.classList.toggle("selected", selected);
      if (selected) chip.insertAdjacentHTML("afterbegin", ICONS.check);
      chip.append(name);
      chip.addEventListener("click", () => {
        if (this._sorting) return;
        this._toggleRoom(id, name);
      });
      // 排序模式：Pointer 事件拖拽（触屏与鼠标通用）
      chip.addEventListener("pointerdown", (event) => {
        if (!this._sorting || event.button !== 0) return;
        event.preventDefault();
        const container = this._roomsElement;
        chip.setPointerCapture(event.pointerId);
        chip.classList.add("dragging");
        let moved = false;
        const onMove = (moveEvent) => {
          moved = true;
          const el = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
          const target = el?.closest?.(".room-chip");
          if (!target || target === chip || target.parentElement !== container) return;
          const rect = target.getBoundingClientRect();
          const insertBefore = moveEvent.clientX < rect.left + rect.width / 2;
          container.insertBefore(chip, insertBefore ? target : target.nextSibling);
        };
        const onUp = () => {
          chip.classList.remove("dragging");
          chip.removeEventListener("pointermove", onMove);
          chip.removeEventListener("pointerup", onUp);
          chip.removeEventListener("pointercancel", onUp);
          if (!moved) return;
          const order = [...container.querySelectorAll(".room-chip:not(.clear)")]
            .map((el) => Number(el.dataset.roomId))
            .filter((num) => this._availableRooms.has(num));
          if (order.length) {
            this._roomOrder = order;
            this._saveRoomOrder();
          }
          this._applySelection();
        };
        chip.addEventListener("pointermove", onMove);
        chip.addEventListener("pointerup", onUp);
        chip.addEventListener("pointercancel", onUp);
      });
      this._roomsElement.append(chip);
    }
    if (this._selectedRooms.size) {
      const clear = document.createElement("button");
      clear.className = "room-chip clear";
      clear.insertAdjacentHTML("afterbegin", ICONS.close);
      clear.append("清除");
      clear.addEventListener("click", () => {
        this._selectedRooms.clear();
        this._applySelection();
      });
      this._roomsElement.append(clear);
    }
    // 未选房间 = 全屋清扫；已选 = 只清扫所选
    const wholeHouse = this._selectedRooms.size === 0;
    this._cleanButton.disabled =
      this._cleaning || this._stopping ||
      (wholeHouse && this._availableRooms.size === 0);
    if (!this._cleaning) {
      const btnSpan = this._cleanButton.querySelector("span");
      if (btnSpan) btnSpan.textContent = wholeHouse ? "清扫全屋" : "清扫所选区域";
    }
  }

  _cleanParams() {
    const params = {};
    const suction = this.shadowRoot.querySelector(".param-suction")?.value;
    const mopType = this.shadowRoot.querySelector(".param-mop")?.value;
    const water = this.shadowRoot.querySelector(".param-water")?.value;
    const passes = Number(this.shadowRoot.querySelector(".param-passes")?.value || 1);
    if (suction) params.suction = suction;
    if (mopType) params.mop_type = mopType;
    if (water) params.water = Number(water);
    if (passes > 1) params.passes = passes;
    return params;
  }

  _describeParams(params) {
    const suctionNames = { quiet: "安静", normal: "标准", max: "强力", max_plus: "强力+" };
    const mopNames = {
      vacuum: "纯扫", mop: "纯拖",
      vacuum_and_mop: "扫拖同启", mop_after_vacuum: "扫后拖",
    };
    const parts = [];
    if (params.suction) parts.push(`吸力=${suctionNames[params.suction] || params.suction}`);
    if (params.mop_type) parts.push(`模式=${mopNames[params.mop_type] || params.mop_type}`);
    if (params.water) parts.push(`水量=${params.water >= 30 ? "高" : params.water >= 25 ? "中" : "低"}`);
    if (params.passes > 1) parts.push(`次数=${params.passes}`);
    return parts.join("，");
  }

  async _cleanSelectedRooms() {
    if (!this._hass || this._cleaning || this._stopping) return;
    const wholeHouse = this._selectedRooms.size === 0;
    const roomIds = wholeHouse ? this._orderedRoomIds() : [...this._selectedRooms.keys()];
    if (!roomIds.length) return;
    const names = wholeHouse
      ? "全屋"
      : [...this._selectedRooms.values()].join("、");
    const params = this._cleanParams();
    const description = this._describeParams(params);
    const confirmText = wholeHouse
      ? `确认清扫全屋？${description ? `\n参数：${description}` : ""}`
      : `确认清扫以下区域？\n${names}${description ? `\n参数：${description}` : ""}`;
    if (!window.confirm(confirmText)) return;
    this._cleaning = true;
    this._cleanButton.disabled = true;
    const buttonText = this._cleanButton.querySelector("span");
    if (buttonText) buttonText.textContent = "正在发送";
    this._setCommandStatus("正在发送清扫命令…");
    try {
      await this._hass.callService("vacuum", "send_command", {
        entity_id: this._config.vacuum_entity,
        command: "spot_area",
        params: {
          rooms: roomIds,
          cleanings: 1,
          ...params,
        },
      });
      this._setCommandStatus(
        `已发送清扫命令：${names}${description ? `（${description}）` : ""}`,
        false,
        true,
      );
      this._selectedRooms.clear();
    } catch (error) {
      const message = error?.message || String(error);
      this._setCommandStatus(`清扫命令发送失败：${message}`, true);
    } finally {
      this._cleaning = false;
      if (buttonText) buttonText.textContent = wholeHouse ? "清扫全屋" : "清扫所选区域";
      this._applySelection();
      this._updateVacuumState();
    }
  }

  async _vacuumAction(service, pendingMessage, successMessage) {
    if (!this._hass || this._cleaning || this._stopping) return;
    this._setCommandStatus(pendingMessage);
    try {
      await this._hass.callService("vacuum", service, {
        entity_id: this._config.vacuum_entity,
      });
      this._setCommandStatus(successMessage, false, true);
    } catch (error) {
      const message = error?.message || String(error);
      this._setCommandStatus(`命令发送失败：${message}`, true);
    }
  }

  async _stopCleaning() {
    if (!this._hass || this._stopping || this._cleaning) return;
    this._stopping = true;
    this._stopButton.disabled = true;
    this._applySelection();
    const buttonText = this._stopButton.querySelector("span");
    if (buttonText) buttonText.textContent = "正在停止";
    this._setCommandStatus("正在发送停止命令…");
    try {
      await this._hass.callService("vacuum", "stop", {
        entity_id: this._config.vacuum_entity,
      });
      this._setCommandStatus("已发送停止清扫命令", false, true);
    } catch (error) {
      const message = error?.message || String(error);
      this._setCommandStatus(`停止命令发送失败：${message}`, true);
    } finally {
      this._stopping = false;
      if (buttonText) buttonText.textContent = "停止";
      this._applySelection();
      this._updateVacuumState();
    }
  }

  _setCommandStatus(message, isError = false, isSuccess = false) {
    const status = this.shadowRoot.querySelector(".command-status");
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("error", isError);
    status.classList.toggle("success", isSuccess);
  }

  _updateVacuumState() {
    const state = this._hass?.states[this._config.vacuum_entity]?.state || "unknown";
    const stateNames = {
      cleaning: "清扫中",
      docked: "在基站",
      idle: "空闲",
      paused: "已暂停",
      returning: "返回基站",
      unavailable: "不可用",
      unknown: "状态未知",
    };
    const colorMap = {
      cleaning: "var(--primary-color)",
      docked: "#4caf50",
      returning: "#03a9f4",
      paused: "#ff9800",
      idle: "var(--secondary-text-color)",
      unavailable: "var(--error-color, #f44336)",
    };
    const element = this.shadowRoot.querySelector(".status");
    if (element) {
      element.classList.toggle("cleaning", state === "cleaning");
      element.style.setProperty("--status-color", colorMap[state] || "var(--secondary-text-color)");
      const text = element.querySelector(".status-text");
      if (text) text.textContent = stateNames[state] || state;
    }
    // 附加状态实体（如基站/烘干传感器）
    if (this._extraStatusElement) {
      this._extraStatusElement.replaceChildren();
      const simpleStates = { on: "开", off: "关", unavailable: "不可用", unknown: "未知" };
      for (const entityId of this._statusEntityIds()) {
        const stateObj = this._hass?.states[entityId];
        if (!stateObj) continue;
        const name = stateObj.attributes?.friendly_name || entityId;
        const raw = stateObj.state;
        const value = raw in simpleStates ? simpleStates[raw] : raw;
        const badge = document.createElement("span");
        badge.className = "status";
        badge.innerHTML = `<span class="dot"></span><span class="status-text"></span>`;
        badge.querySelector(".status-text").textContent = `${name} ${value}`;
        this._extraStatusElement.append(badge);
      }
    }
    if (this._stopButton) {
      this._stopButton.disabled = this._stopping || this._cleaning;
    }
  }
}

if (!customElements.get("t90-modern-map-card-editor")) {
  customElements.define("t90-modern-map-card-editor", T90ModernMapCardEditor);
}

if (!customElements.get("t90-modern-map-card")) {
  customElements.define("t90-modern-map-card", T90ModernMapCard);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === "t90-modern-map-card")) {
  window.customCards.push({
    type: "t90-modern-map-card",
    name: "科沃斯 T90 地图（现代版）",
    description: "现代化简约地图卡片：全屋/区域清扫、吸力/模式/水量/次数、缩放全屏、返回基站与定位",
    preview: true,
  });
}
