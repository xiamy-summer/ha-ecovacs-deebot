/**
 * 科沃斯 T90 现代简约地图卡片 (t90-modern-map-card)
 *
 * 按国行科沃斯 App「全屋清洁」页设计模式重排参数区：
 *   启动大按钮 → 清洁模式（扫地/边扫边拖/先扫后拖）→ 吸力（四档扇叶图标）
 *   → 水量（1-50 滑块）→ 清洁效率（标准/快速/深度）→ 次数（×1/×2）。
 * 房间直接在地图上点选（带位移阈值防误触），下方仅保留选择状态栏。
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
    const first = !this._hass;
    this._hass = hass;
    // 注意：HA 会高频推送 hass 更新。若每次都整树重建 shadowRoot，
    // 正在进行的拖拽手势会被销毁（拖拽失效+编辑器闪烁），因此只在
    // 首次拿到 hass 或配置变化时重建；房间列表尚未加载成功时补拉。
    if (first || !this._rendered) {
      this._render();
    } else if (this._config?.image_entity) {
      // 设备房间表（集成订阅 RoomsEvent 后写在地图实体的 rooms 属性上）可能
      // 晚于首次渲染才到达；此前若只能从 SVG 解析，会缺少没有路径的房间，
      // 顺序也未必与 App 一致，因此拿到设备房间表后自动升级一次。
      const deviceRooms = this._roomsFromDevice();
      if (deviceRooms.length && (this._roomsFromSvg || !this._roomsForOrder)) {
        this._roomsForOrder = deviceRooms;
        this._roomsFromSvg = false;
        this._renderOrderList();
        this._renderOrderSource();
      } else if (!this._roomsForOrder) {
        this._loadRoomsForOrder();
      }
    }
  }

  setConfig(config) {
    this._config = { ...config };
    this._rendered = false;
    if (this._hass) this._render();
  }

  _render() {
    if (!this._hass || this._rendered) return;
    if (this._dragActive) {
      // 拖拽中重建 shadowRoot 会销毁正在拖的行、打断排序手势，
      // 记为待渲染，手势结束后补一次。
      this._renderPending = true;
      return;
    }
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
        .order-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
        .order-title { font-weight: 600; font-size: 14px; }
        .order-actions { display: inline-flex; align-items: center; gap: 6px; }
        .order-load {
          border: 0; border-radius: 6px; padding: 6px 12px; cursor: pointer;
          background: var(--primary-color); color: var(--text-primary-color, #fff); font-size: 13px;
        }
        .order-reset {
          border: 1px solid var(--divider-color); border-radius: 6px; padding: 6px 12px;
          cursor: pointer; background: transparent; color: var(--primary-text-color); font-size: 13px;
        }
        .order-source { color: var(--secondary-text-color); font-size: 12px; margin-bottom: 6px; }
        .order-list { display: grid; gap: 6px; }
        .order-row {
          display: flex; align-items: center; gap: 6px; touch-action: pan-y;
          padding: 6px 8px; border-radius: 6px; background: var(--secondary-background-color, #f5f5f5);
          border: 1px solid transparent;
        }
        .order-row.dragging {
          opacity: .5; cursor: grabbing;
          border: 1px dashed var(--primary-color);
        }
        .drag-handle {
          flex: 0 0 auto; touch-action: none; cursor: grab;
          color: var(--secondary-text-color);
          padding: 2px 4px; user-select: none; -webkit-user-select: none;
        }
        .order-row.dragging .drag-handle { cursor: grabbing; }
        .order-row button {
          width: 28px; height: 26px; border: 1px solid var(--divider-color); border-radius: 6px;
          background: var(--card-background-color, #fff); cursor: pointer; font-size: 13px;
          touch-action: auto;
        }
        .order-row button:disabled { opacity: .35; cursor: default; }
        .order-empty { color: var(--secondary-text-color); font-size: 13px; }
      </style>
      <div class="form">
        <ha-textfield class="title" label="标题（仅全屏窗口顶部显示）"></ha-textfield>
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
          <label><ha-switch class="t-rooms"></ha-switch>地图点选区域 + 选择状态栏</label>
          <label><ha-switch class="t-params"></ha-switch>启动按钮 + 清扫参数（模式/吸力/水量/效率/次数）</label>
          <label><ha-switch class="t-dock"></ha-switch>返回基站按钮</label>
          <label><ha-switch class="t-locate"></ha-switch>定位按钮</label>
        </div>
        <div class="order-head">
          <span class="order-title">全屋清扫顺序</span>
          <span class="order-actions">
            <button class="order-reset">恢复设备顺序</button>
            <button class="order-load">重新载入列表</button>
          </span>
        </div>
        <div class="order-section">
          <div class="order-source"></div>
          <div class="order-list"></div>
          <div class="order-empty" style="display:none"></div>
          <div class="hint" style="margin-top:8px">
            未在地图上选择区域时，启动按钮按此顺序清扫全屋。按住房间左侧的 ⠿ 手柄拖动可调整顺序（PC 上可直接拖整行，也可用 ↑↓）。
            排序保存在仪表盘配置中，PC/APP 同步生效。
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

    // 房间列表缓存：仅在地图实体变化时清空，避免面板重建时反复重新拉取
    if (this._renderedImageEntity !== this._config.image_entity) {
      this._roomsForOrder = null;
      this._renderedImageEntity = this._config.image_entity;
    }
    this.shadowRoot.querySelector(".order-load").addEventListener("click", () => {
      this._roomsForOrder = null; // 强制重新拉取
      this._roomsFromSvg = true;
      this._loadRoomsForOrder();
    });
    this.shadowRoot.querySelector(".order-reset").addEventListener("click", () => {
      // 清空自定义顺序 → 回落到设备（固件/App）的房间顺序
      this._updateConfig("room_order", []);
      this._renderOrderList();
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
      this._renderOrderSource();
    } else if (this._config.image_entity) {
      this._loadRoomsForOrder();
    }
    this._rendered = true;
  }

  async _loadRoomsForOrder() {
    if (this._loadingRooms) return; // 防止 hass 高频推送导致并发重复拉取
    this._loadingRooms = true;
    try {
      await this._loadRoomsForOrderInner();
    } finally {
      this._loadingRooms = false;
    }
  }

  /** 从地图实体的 rooms 属性读取设备端房间表（顺序 = 固件/App 的房间顺序）。 */
  _roomsFromDevice() {
    const attrs = this._hass?.states?.[this._config?.image_entity]?.attributes || {};
    const raw = attrs.rooms;
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for (const item of raw) {
      const id = Number(typeof item === "object" && item !== null ? item.id : item);
      if (!Number.isFinite(id) || seen.has(id)) continue;
      seen.add(id);
      const name =
        (typeof item === "object" && item !== null ? String(item.name || "") : "") ||
        `区域 ${id}`;
      out.push({ id, name });
    }
    return out;
  }

  _renderOrderSource() {
    const el = this.shadowRoot.querySelector(".order-source");
    if (!el) return;
    el.textContent = this._roomsFromSvg
      ? "房间表来自地图 SVG（可能缺少未绘制路径的房间，建议重启集成后重载）"
      : "顺序来源：设备房间表（与 App 的房间列表一致），可拖动调整";
  }

  async _loadRoomsForOrderInner() {
    const empty = this.shadowRoot.querySelector(".order-empty");
    const list = this.shadowRoot.querySelector(".order-list");
    if (!empty || !list) return;
    // 首选设备房间表：包含全部房间，顺序即固件/App 的列表顺序。
    const deviceRooms = this._roomsFromDevice();
    if (deviceRooms.length) {
      this._roomsForOrder = deviceRooms;
      this._roomsFromSvg = false;
      empty.style.display = "none";
      this._renderOrderList();
      this._renderOrderSource();
      return;
    }
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
      this._roomsFromSvg = true;
      if (!this._roomsForOrder.length) {
        empty.textContent = "地图中未找到房间信息（请确认机器人已保存过地图）";
        this._renderOrderSource();
        return;
      }
      empty.style.display = "none";
      this._renderOrderList();
      this._renderOrderSource();
    } catch (error) {
      empty.textContent = `读取失败：${error.message}`;
    }
  }

  _renderOrderList() {
    const list = this.shadowRoot.querySelector(".order-list");
    if (!list || !this._roomsForOrder) return;
    if (this._dragActive) return; // 拖拽中不重建列表（会销毁正在拖的行）
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
      const handle = document.createElement("span");
      handle.className = "drag-handle";
      handle.textContent = "⠿";
      handle.title = "拖动排序";
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
      row.append(handle, name, up, down);
      // ---------- 拖拽排序 ----------
      // 三个关键点（前两个是此前拖不动的根因）：
      //  1) 监听挂在 window 捕获阶段，绝不用 setPointerCapture。拖动过程中
      //     insertBefore 会把行元素从文档摘下来再插回去，元素一旦脱离文档，
      //     浏览器会立刻自动释放指针捕获，后续 pointermove 再也收不到——
      //     表现为"拖一下卡住 / 完全拖不动"。
      //  2) 命中判断用各行 getBoundingClientRect 计算，不用 elementFromPoint
      //     （无法可靠穿透 HA 编辑器的多层 shadow DOM）。
      //  3) 触屏只允许从 ⠿ 手柄起拖（行本体保留 pan-y，配置面板仍可滚动）；
      //     PC 上整行都可以拖。
      const liveList = () => this.shadowRoot.querySelector(".order-list") || list;
      const startDrag = (startEvent) => {
        if (startEvent.pointerType === "mouse" && startEvent.button !== 0) return;
        if (this._dragActive) return;
        startEvent.preventDefault();
        startEvent.stopPropagation();
        this._dragActive = true;
        row.classList.add("dragging");
        const orderAtStart = [...liveList().querySelectorAll(".order-row")].map((el) =>
          Number(el.dataset.roomId),
        );

        const place = (target, before) => {
          const parent = liveList();
          if (!parent) return;
          if (before) {
            if (target !== row) parent.insertBefore(row, target);
            return;
          }
          // 用 nextElementSibling（列表里只有 .order-row 元素，
          // 避免被空白文本节点干扰）
          if (target.nextElementSibling !== row) {
            parent.insertBefore(row, target.nextElementSibling);
          }
        };

        const onMove = (moveEvent) => {
          const y = moveEvent.clientY;
          const rows = [...liveList().querySelectorAll(".order-row")];
          if (rows.length < 2) return;
          const firstRect = rows[0].getBoundingClientRect();
          const lastRect = rows[rows.length - 1].getBoundingClientRect();
          if (y < firstRect.top) {
            if (rows[0] !== row) place(rows[0], true);
            return;
          }
          if (y > lastRect.bottom) {
            if (rows[rows.length - 1] !== row) {
              const parent = liveList();
              if (parent) parent.append(row);
            }
            return;
          }
          // 命中行矩形则用命中行；落在行间 6px 间隙时退化到"最近一行"，
          // 避免指针在缝里移动时毫无反应（会被误认为拖不动）。
          let best = null;
          let before = false;
          let bestDistance = Infinity;
          for (const candidate of rows) {
            if (candidate === row) continue;
            const rect = candidate.getBoundingClientRect();
            const center = rect.top + rect.height / 2;
            if (y >= rect.top && y <= rect.bottom) {
              best = candidate;
              before = y < center;
              break;
            }
            const distance = Math.abs(y - center);
            if (distance < bestDistance) {
              bestDistance = distance;
              best = candidate;
              before = y < center;
            }
          }
          if (best) place(best, before);
        };

        const onUp = () => {
          window.removeEventListener("pointermove", onMove, true);
          window.removeEventListener("pointerup", onUp, true);
          window.removeEventListener("pointercancel", onUp, true);
          this._dragActive = false;
          row.classList.remove("dragging");
          const newOrder = [...liveList().querySelectorAll(".order-row")].map((el) =>
            Number(el.dataset.roomId),
          );
          // 与"拖动开始时的实际顺序"比较：只是点一下没拖动就不写配置，
          // 否则会把设备默认顺序固化成一份自定义顺序（"恢复设备顺序"也就失效了）。
          if (newOrder.join(",") !== orderAtStart.join(",")) {
            this._updateConfig("room_order", newOrder);
          }
          if (this._renderPending) {
            // 拖拽期间有被推迟的整树渲染，现在补上（内部会重建列表）
            this._renderPending = false;
            this._rendered = false;
            this._render();
            return;
          }
          this._renderOrderList();
        };

        window.addEventListener("pointermove", onMove, true);
        window.addEventListener("pointerup", onUp, true);
        window.addEventListener("pointercancel", onUp, true);
      };

      // 触屏/手写笔：只能从手柄起拖
      handle.addEventListener("pointerdown", startDrag);
      // 鼠标：整行可拖（避开手柄与 ↑↓ 按钮，防止重复启动）
      row.addEventListener("pointerdown", (event) => {
        if (event.pointerType !== "mouse") return;
        if (event.target.closest(".drag-handle, button")) return;
        startDrag(event);
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
  // zoomIn/zoomOut 仅全屏对话框工具条使用（卡片主界面已去掉缩放按钮）
  zoomIn: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6M11 8v6"/></svg>`,
  zoomOut: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6"/></svg>`,
  expand: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/></svg>`,
  close: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  reset: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>`,
  play: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>`,
  pause: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="6" y="5" width="4.2" height="14" rx="1.3"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.3"/></svg>`,
  stop: `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><rect x="6.5" y="6.5" width="11" height="11" rx="2"/></svg>`,
  dock: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11.5 12 4l8 7.5"/><path d="M6.5 10v9h11v-9"/><rect x="9.6" y="13.6" width="4.8" height="3" rx="0.8"/></svg>`,
  locate: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3"/><circle cx="12" cy="12" r="7.2"/></svg>`,
};

// 吸力档位图标：扇叶数量随档位递增（安静1叶 → 强力+4叶），风格贴近 App 螺旋扇
const _blade = `<path d="M12 12C12 6.6 15.4 3.6 20.4 4.1 19.9 9 16.9 12 12 12Z" fill="currentColor"/>`;
const _fan = (blades, withRing) => {
  let inner = "";
  for (let i = 0; i < blades; i++) {
    inner += `<g transform="rotate(${(i * 360) / blades} 12 12)">${_blade}</g>`;
  }
  if (withRing) {
    inner += `<circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="1.4"/>`;
  }
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none">${inner}</svg>`;
};
const SUCTION_ICONS = {
  quiet: _fan(1, false),
  normal: _fan(2, false),
  max: _fan(3, false),
  max_plus: _fan(4, true),
};

// 清洁效率图标：路径形态隐喻（快速=长直线，标准=适中弓字形，深度=密折线）
const EFFICIENCY_ICONS = {
  fast: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4.5 7.5h15M4.5 16.5h15"/></svg>`,
  standard: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h5v8h6V8h5v8"/></svg>`,
  deep: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8h2.2v8h3V8h3v8h3V8h3v8h2.8"/></svg>`,
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
    this._selectionLocked = false;
    this._toastTimer = null;
    this._cleanGuard = null;
    // 乐观锁定：命令已发出但实体状态尚未变为 cleaning/paused 的窗口期，
    // 防止状态上报延迟（数秒）期间重复点击启动（与科沃斯 App 行为一致）
    this._pendingClean = false;
    this._pendingGuard = null;
    this._confirmResolve = null;
    this._lastRefresh = 0;
    this._timer = null;
    this._roomOrder = [];
    this._resizeObserver = null;
    // 清扫参数：空值 = 跟随系统（不下发该参数），与后端语义一致
    this._params = {
      mode: "",
      suction: "",
      water: null,
      efficiency: "",
      passes: 1,
      agent: false,
    };
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

        /* ---------- 地图容器 ---------- */
        .map-wrap { position: relative; margin: 14px 12px 0; }
        .viewport {
          border-radius: 14px; overflow: auto;
          background:
            radial-gradient(circle at 50% 0%,
              color-mix(in srgb, var(--primary-color, #03a9f4) 6%, transparent), transparent 62%),
            var(--secondary-background-color, #f5f5f5);
          overscroll-behavior: contain;
          transition: height .3s ease;
        }
        .viewport.locked .map [data-room-id] { cursor: default; }

        /* ---------- 地图下方工具（状态行右侧：定位/回充/全屏） ---------- */
        .status-actions {
          margin-left: auto; display: inline-flex; gap: 4px; flex: 0 0 auto;
        }
        .map-tool {
          width: 30px; height: 30px;
          display: inline-flex; align-items: center; justify-content: center;
          border: 0; border-radius: 9px; padding: 0; cursor: pointer;
          color: var(--secondary-text-color); background: transparent;
          transition: background .15s, color .15s;
        }
        .map-tool:hover:not(:disabled) { color: var(--primary-color); background: color-mix(in srgb, var(--primary-color) 10%, transparent); }
        .map-tool:active:not(:disabled) { transform: scale(.92); }
        .map-tool:disabled { opacity: .35; cursor: default; }

        /* ---------- 命令提示 toast（地图顶部居中悬浮） ---------- */
        .toast {
          position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
          z-index: 3; max-width: 78%;
          padding: 7px 15px; border-radius: 18px;
          font-size: 12.5px; font-weight: 500; text-align: center;
          color: var(--primary-text-color);
          background: color-mix(in srgb, var(--card-background-color, #fff) 88%, transparent);
          backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
          box-shadow: 0 2px 12px rgb(0 0 0 / .14);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          animation: t90-modern-toast-in .18s ease-out;
        }
        .toast.error { color: var(--error-color, #f44336); }
        .toast.success { color: var(--success-color, #2e7d32); }
        @keyframes t90-modern-toast-in {
          from { opacity: 0; transform: translateX(-50%) translateY(-6px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }

        /* ---------- 地图 ---------- */
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
        .map [data-room-id] { cursor: pointer; }

        /* ---------- 状态行（地图下方） ---------- */
        .status-row {
          display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
          padding: 10px 18px 0; min-height: 20px;
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

        /* ---------- 选择状态栏 ---------- */
        .selection-bar {
          display: flex; align-items: center; gap: 8px;
          padding: 9px 18px 2px; min-height: 22px;
        }
        .selection-text {
          flex: 1; min-width: 0; font-size: 12.5px;
          color: var(--secondary-text-color);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .selection-text.has-sel { color: var(--primary-color); font-weight: 600; }
        .clear-sel {
          flex: 0 0 auto; height: 25px; padding: 0 11px;
          display: inline-flex; align-items: center; gap: 4px;
          border: 1px solid color-mix(in srgb, var(--error-color, #f44336) 35%, transparent);
          border-radius: 13px; background: transparent; cursor: pointer;
          color: var(--error-color, #f44336); font-size: 12px; font-weight: 500;
        }
        .clear-sel svg { width: 11px; height: 11px; }
        .clear-sel:active { transform: scale(.95); }

        /* ---------- 启动大按钮 ---------- */
        .start-wrap { padding: 10px 16px 2px; }
        .start-btn {
          width: 100%; height: 46px; border: 0; border-radius: 13px; cursor: pointer;
          display: inline-flex; align-items: center; justify-content: center; gap: 9px;
          color: #fff; font-size: 15px; font-weight: 600; letter-spacing: 2px;
          background: linear-gradient(90deg,
            color-mix(in srgb, var(--primary-color, #03a9f4) 62%, #7986cb),
            var(--primary-color, #03a9f4));
          box-shadow: 0 4px 16px color-mix(in srgb, var(--primary-color) 38%, transparent);
          transition: filter .15s, transform .1s, opacity .15s, box-shadow .15s;
        }
        .start-btn:hover:not(:disabled) { filter: brightness(1.06); }
        .start-btn:active:not(:disabled) { transform: scale(.985); }
        .start-btn:disabled { opacity: .4; cursor: default; box-shadow: none; }
        .start-btn svg { width: 17px; height: 17px; }
        .start-scope {
          font-size: 12px; font-weight: 500; letter-spacing: .5px;
          opacity: .85; padding-left: 2px;
        }

        /* ---------- 启动前确认（卡片内确认，不用 window.confirm） ----------
           HA 手机 APP（iOS/Android WebView）会静默拦截原生对话框，
           confirm() 直接返回 false 且不弹任何东西 —— 表现就是"点了启动没反应"。 */
        .confirm-sheet {
          border: 1px solid color-mix(in srgb, var(--primary-color) 35%, transparent);
          border-radius: 13px; padding: 12px 14px;
          background: color-mix(in srgb, var(--primary-color) 6%, transparent);
        }
        .confirm-text {
          font-size: 13px; line-height: 1.65; white-space: pre-line;
          color: var(--primary-text-color);
        }
        .confirm-actions {
          display: grid; grid-template-columns: 1fr 1.4fr; gap: 10px; margin-top: 12px;
        }
        .confirm-actions button {
          height: 38px; border-radius: 11px; cursor: pointer;
          border: 1px solid var(--divider-color);
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color);
          font-size: 13.5px; font-weight: 600;
        }
        .confirm-actions button:active { transform: scale(.97); }
        .confirm-actions .confirm-yes {
          border: 0; color: #fff;
          background: linear-gradient(90deg,
            color-mix(in srgb, var(--primary-color, #03a9f4) 62%, #7986cb),
            var(--primary-color, #03a9f4));
        }

        /* ---------- 参数区（App 风格） ---------- */
        .params { padding: 8px 16px 18px; display: grid; gap: 14px; }
        .param-head {
          display: flex; align-items: baseline; gap: 8px; margin-bottom: 7px;
        }
        .param-title { font-size: 13.5px; font-weight: 600; color: var(--primary-text-color); }
        .param-value { font-size: 12.5px; font-weight: 500; color: var(--primary-color); flex: 1; }
        .follow-pill {
          height: 22px; padding: 0 10px; border-radius: 11px; cursor: pointer;
          border: 1px solid var(--divider-color); background: transparent;
          color: var(--secondary-text-color); font-size: 11.5px; line-height: 1;
          transition: all .15s;
        }
        .follow-pill.active {
          border-color: color-mix(in srgb, var(--primary-color) 45%, transparent);
          color: var(--primary-color);
          background: color-mix(in srgb, var(--primary-color) 8%, transparent);
        }
        .seg-row { display: grid; gap: 8px; }
        .seg {
          min-height: 44px; padding: 6px 4px; cursor: pointer;
          display: inline-flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
          border: 1.5px solid transparent; border-radius: 11px;
          background: var(--secondary-background-color, #f5f5f5);
          color: var(--primary-text-color); font-size: 12.5px; font-weight: 500;
          transition: all .15s ease; user-select: none; -webkit-user-select: none;
        }
        .seg svg { width: 22px; height: 22px; color: var(--secondary-text-color); transition: color .15s; }
        .seg:active { transform: scale(.96); }
        .seg.active {
          border-color: var(--primary-color);
          background: var(--card-background-color, #fff);
          color: var(--primary-color); font-weight: 600;
          box-shadow: 0 2px 10px color-mix(in srgb, var(--primary-color) 12%, transparent);
        }
        .seg.active svg { color: var(--primary-color); }

        /* ---------- 水量滑块 ---------- */
        .water-row { display: flex; align-items: center; gap: 10px; }
        .water-row input[type="range"] {
          flex: 1; height: 26px; margin: 0; cursor: pointer;
          accent-color: var(--primary-color);
        }
        .water-row input[type="range"]:disabled { cursor: default; opacity: .45; }
        .water-num {
          min-width: 34px; text-align: center; font-size: 13px; font-weight: 600;
          color: var(--primary-color); font-variant-numeric: tabular-nums;
        }
        .water-hint {
          margin-top: 6px; padding: 5px 10px; border-radius: 8px;
          background: color-mix(in srgb, var(--primary-color) 7%, transparent);
          color: var(--primary-color); font-size: 11.5px; text-align: center;
        }

        /* ---------- AI 智能托管（开启时隐藏手动参数区） ---------- */
        .agent-hint {
          margin-top: 6px; font-size: 11px; line-height: 1.5;
          color: var(--secondary-text-color);
        }
        .params.agent-on .param-block:not(.agent-block) { display: none; }

        /* ---------- 清扫中操作（暂停 / 结束并返回，替换启动按钮） ---------- */
        .active-actions {
          display: none; grid-template-columns: 1fr 1fr; gap: 10px;
        }
        .active-actions.show { display: grid; }
        .pause-btn, .end-btn {
          height: 46px; border-radius: 13px; cursor: pointer;
          display: inline-flex; align-items: center; justify-content: center; gap: 8px;
          font-size: 14px; font-weight: 600; letter-spacing: 1px;
          transition: filter .15s, transform .1s, opacity .15s;
        }
        .pause-btn:active:not(:disabled), .end-btn:active:not(:disabled) { transform: scale(.98); }
        .pause-btn:disabled, .end-btn:disabled { opacity: .4; cursor: default; }
        .pause-btn {
          border: 1.5px solid color-mix(in srgb, var(--primary-color) 45%, transparent);
          color: var(--primary-color);
          background: color-mix(in srgb, var(--primary-color) 6%, var(--card-background-color, #fff));
        }
        .pause-btn svg { width: 15px; height: 15px; }
        .end-btn {
          border: 0; color: var(--error-color, #f44336);
          background: color-mix(in srgb, var(--error-color, #f44336) 9%, var(--card-background-color, #fff));
        }
        .end-btn svg { width: 14px; height: 14px; }

        /* ---------- 全屏弹窗专用工具条样式 ---------- */
        .ghost-btn {
          width: 32px; height: 32px; flex: 0 0 auto;
          display: inline-flex; align-items: center; justify-content: center;
          border: 0; border-radius: 10px; padding: 0; cursor: pointer;
          color: var(--secondary-text-color); background: transparent;
          transition: background .15s, color .15s;
        }
        .ghost-btn:hover { color: var(--primary-color); }
        .ghost-btn:active { transform: scale(.92); }
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
        .tool-btn:hover:not(:disabled) { color: var(--primary-color); background: color-mix(in srgb, var(--primary-color) 10%, transparent); }
        .tool-btn:active:not(:disabled) { transform: scale(.9); }
        .tool-btn:disabled { opacity: .35; cursor: default; }

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
          .active-actions { grid-template-columns: 1fr 1fr; }
          dialog.map-dialog { width: 100vw; height: 100dvh; border-radius: 0; }
        }
      </style>
      <ha-card>
        <div class="map-wrap">
          <div class="viewport"><div class="map"><div class="loading">正在加载地图</div></div></div>
          <div class="toast" aria-live="polite" style="display:none"></div>
        </div>
        <div class="status-row">
          <div class="status"><span class="dot"></span><span class="status-text"></span></div>
          <span class="extra-status"></span>
          <span class="status-actions">
            <button class="map-tool locate" title="定位扫地机" aria-label="定位扫地机">${ICONS.locate}</button>
            <button class="map-tool dock" title="返回基站" aria-label="返回基站">${ICONS.dock}</button>
            <button class="map-tool expand-float" title="全屏查看" aria-label="全屏查看">${ICONS.expand}</button>
          </span>
        </div>
        <div class="selection-bar">
          <span class="selection-text">未选择区域 · 点击地图选择（默认清扫全屋）</span>
          <button class="clear-sel" style="display:none">${ICONS.close}清除</button>
        </div>
        <div class="params-wrap">
          <div class="start-wrap">
            <button class="start-btn" disabled>${ICONS.play}<span class="start-text">启 动</span><span class="start-scope"></span></button>
            <div class="confirm-sheet" style="display:none">
              <div class="confirm-text"></div>
              <div class="confirm-actions">
                <button class="confirm-no">取消</button>
                <button class="confirm-yes">开始清扫</button>
              </div>
            </div>
            <div class="active-actions">
              <button class="pause-btn"><span class="pi-pause">${ICONS.pause}</span><span class="pi-play" style="display:none">${ICONS.play}</span><span class="pause-text">暂停</span></button>
              <button class="end-btn">${ICONS.stop}<span class="end-text">结束并返回</span></button>
            </div>
          </div>
          <div class="params">
            <div class="param-block agent-block">
              <div class="param-head">
                <span class="param-title">AI 智能托管</span>
                <span class="param-value" data-value="agent">关闭</span>
              </div>
              <div class="seg-row" data-param="agent" style="grid-template-columns:repeat(2,1fr)">
                <button class="seg" data-value="off"><span>关闭</span></button>
                <button class="seg" data-value="on"><span>开启</span></button>
              </div>
              <div class="agent-hint">开启后吸力/水量/模式/效率由机器人按房间类型与地面材质自主决定；可清扫全屋，也可点选地图上的房间</div>
            </div>
            <div class="param-block">
              <div class="param-head">
                <span class="param-title">清洁模式</span>
                <span class="param-value" data-value="mode"></span>
              </div>
              <div class="seg-row" data-param="mode" style="grid-template-columns:repeat(3,1fr)">
                <button class="seg" data-value="vacuum">扫地</button>
                <button class="seg" data-value="vacuum_and_mop">边扫边拖</button>
                <button class="seg" data-value="mop_after_vacuum">先扫后拖</button>
              </div>
            </div>
            <div class="param-block">
              <div class="param-head">
                <span class="param-title">吸力</span>
                <span class="param-value" data-value="suction"></span>
              </div>
              <div class="seg-row" data-param="suction" style="grid-template-columns:repeat(4,1fr)">
                <button class="seg" data-value="quiet" title="安静">${SUCTION_ICONS.quiet}<span>安静</span></button>
                <button class="seg" data-value="normal" title="标准">${SUCTION_ICONS.normal}<span>标准</span></button>
                <button class="seg" data-value="max" title="强力">${SUCTION_ICONS.max}<span>强力</span></button>
                <button class="seg" data-value="max_plus" title="强力+">${SUCTION_ICONS.max_plus}<span>强力+</span></button>
              </div>
            </div>
            <div class="param-block">
              <div class="param-head">
                <span class="param-title">水量</span>
                <span class="param-value" data-value="water"></span>
                <button class="follow-pill" data-follow="water">跟随设置</button>
              </div>
              <div class="water-row">
                <input type="range" class="water-slider" min="1" max="50" step="1" value="20"
                  aria-label="出水量" disabled>
                <span class="water-num"></span>
              </div>
              <div class="water-hint"></div>
            </div>
            <div class="param-block">
              <div class="param-head">
                <span class="param-title">清洁效率</span>
                <span class="param-value" data-value="efficiency"></span>
                <button class="follow-pill" data-follow="efficiency">跟随设置</button>
              </div>
              <div class="seg-row" data-param="efficiency" style="grid-template-columns:repeat(3,1fr)">
                <button class="seg" data-value="fast">${EFFICIENCY_ICONS.fast}<span>快速</span></button>
                <button class="seg" data-value="standard">${EFFICIENCY_ICONS.standard}<span>标准</span></button>
                <button class="seg" data-value="deep">${EFFICIENCY_ICONS.deep}<span>深度</span></button>
              </div>
            </div>
            <div class="param-block">
              <div class="param-head">
                <span class="param-title">次数</span>
                <span class="param-value" data-value="passes"></span>
              </div>
              <div class="seg-row" data-param="passes" style="grid-template-columns:repeat(2,1fr)">
                <button class="seg" data-value="1"><span>×1</span></button>
                <button class="seg" data-value="2"><span>×2</span></button>
              </div>
            </div>
          </div>
        </div>
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

    this._mapElement = this.shadowRoot.querySelector(".map");
    this._selectionText = this.shadowRoot.querySelector(".selection-text");
    this._clearButton = this.shadowRoot.querySelector(".clear-sel");
    this._startButton = this.shadowRoot.querySelector(".start-btn");
    this._activeActions = this.shadowRoot.querySelector(".active-actions");
    this._pauseButton = this.shadowRoot.querySelector(".pause-btn");
    this._pauseText = this.shadowRoot.querySelector(".pause-text");
    this._endButton = this.shadowRoot.querySelector(".end-btn");
    this._toast = this.shadowRoot.querySelector(".toast");
    this._dialog = this.shadowRoot.querySelector(".map-dialog");
    this._dialogMapElement = this.shadowRoot.querySelector(".dialog-map");
    this._extraStatusElement = this.shadowRoot.querySelector(".extra-status");
    this._viewport = this.shadowRoot.querySelector(".viewport");
    // 主操作按钮最先绑定：即使后面某个绑定抛错（选择器失配 / ResizeObserver
    // 等），启动/暂停/结束也必须可用。以前这些绑在全段最后，任何一处异常都会
    // 让"启动"变成完全没反应，而 HA 日志里看不到任何痕迹。
    this._confirmBox = this.shadowRoot.querySelector(".confirm-sheet");
    this._confirmYes = this.shadowRoot.querySelector(".confirm-yes");
    this._confirmNo = this.shadowRoot.querySelector(".confirm-no");
    this._startButton.addEventListener("click", () => this._cleanSelectedRooms());
    this._pauseButton.addEventListener("click", () => this._togglePause());
    this._endButton.addEventListener("click", () => this._endAndReturn());
    this._clearButton.addEventListener("click", () => {
      this._selectedRooms.clear();
      this._applySelection();
    });
    this._confirmYes?.addEventListener("click", () => this._resolveConfirm(true));
    this._confirmNo?.addEventListener("click", () => this._resolveConfirm(false));
    if (!this._resizeObserver) {
      this._resizeObserver = new ResizeObserver(() => this._applyZoom());
      this._resizeObserver.observe(this._viewport);
    }
    this.shadowRoot.querySelector(".dialog-title").textContent = this._config.title;
    this.shadowRoot.querySelector(".expand-float").addEventListener("click", () => this._openMapDialog());
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
    this.shadowRoot.querySelector(".dock").addEventListener("click", () =>
      this._vacuumAction("return_to_base", "正在发送返回基站命令…", "已发送返回基站命令"));
    this.shadowRoot.querySelector(".locate").addEventListener("click", () =>
      this._vacuumAction("locate", "正在定位扫地机…", "已发送定位命令"));
    // 参数分段选择（模式/吸力/效率/次数）：再次点击已选项 = 恢复跟随设置
    this.shadowRoot.querySelectorAll(".seg-row").forEach((row) => {
      row.addEventListener("click", (event) => {
        const seg = event.target.closest(".seg");
        if (!seg) return;
        const param = row.dataset.param;
        const value = seg.dataset.value;
        if (param === "agent") {
          // 与 App 一致：进入/退出智能体模式立即下发开关（仅切开关，
          // 绝不启动清扫），关闭时设备恢复手动参数模式
          this._setAgentMode(value === "on");
          return;
        }
        if (param === "passes") {
          this._params.passes = Number(value);
        } else {
          const key = param === "mode" ? "mode" : param;
          this._params[key] = this._params[key] === value ? "" : value;
        }
        this._syncParamUI();
      });
    });
    // 水量滑块：拖动即退出"跟随设置"
    const slider = this.shadowRoot.querySelector(".water-slider");
    slider.addEventListener("input", () => {
      this._params.water = Number(slider.value);
      this._syncParamUI();
    });
    // 跟随设置开关（水量/清洁效率）
    this.shadowRoot.querySelectorAll(".follow-pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        const key = pill.dataset.follow;
        if (key === "water") {
          this._params.water = this._params.water === null ? Number(slider.value) : null;
        } else {
          this._params.efficiency = this._params.efficiency ? "" : "standard";
        }
        this._syncParamUI();
      });
    });
    this._syncParamUI();
    // 按配置控制各区块显示
    const visibility = [
      [".selection-bar", this._config.show_rooms !== false],
      [".params-wrap", this._config.show_params !== false],
      [".dock", this._config.show_dock !== false],
      [".locate", this._config.show_locate !== false],
    ];
    for (const [selector, visible] of visibility) {
      const el = this.shadowRoot.querySelector(selector);
      if (el) el.style.display = visible ? "" : "none";
    }
    this._startTimer();
  }

  /** 同步参数区 UI（分段选中态/数值标签/水量滑块/跟随开关） */
  _syncParamUI() {
    const valueNames = {
      mode: { "": "跟随设置", vacuum: "扫地", vacuum_and_mop: "边扫边拖", mop_after_vacuum: "先扫后拖" },
      suction: { "": "跟随设置", quiet: "安静", normal: "标准", max: "强力", max_plus: "强力+" },
      efficiency: { "": "跟随设置", standard: "标准", fast: "快速", deep: "深度" },
    };
    for (const param of ["mode", "suction", "efficiency"]) {
      const row = this.shadowRoot.querySelector(`.seg-row[data-param="${param}"]`);
      const current = this._params[param];
      row?.querySelectorAll(".seg").forEach((seg) => {
        seg.classList.toggle("active", seg.dataset.value === current);
      });
      const label = this.shadowRoot.querySelector(`.param-value[data-value="${param}"]`);
      if (label) label.textContent = valueNames[param][current] || "跟随设置";
    }
    // AI 智能托管（开关语义）
    this.shadowRoot.querySelectorAll('.seg-row[data-param="agent"] .seg').forEach((seg) => {
      seg.classList.toggle("active", (seg.dataset.value === "on") === this._params.agent);
    });
    const agentLabel = this.shadowRoot.querySelector('.param-value[data-value="agent"]');
    if (agentLabel) agentLabel.textContent = this._params.agent ? "开启" : "关闭";
    // 次数
    this.shadowRoot.querySelectorAll('.seg-row[data-param="passes"] .seg').forEach((seg) => {
      seg.classList.toggle("active", Number(seg.dataset.value) === this._params.passes);
    });
    const passesLabel = this.shadowRoot.querySelector('.param-value[data-value="passes"]');
    if (passesLabel) passesLabel.textContent = `${this._params.passes} 次`;
    // 水量
    const slider = this.shadowRoot.querySelector(".water-slider");
    const followWater = this._params.water === null;
    const waterValue = followWater ? Number(slider?.value || 20) : this._params.water;
    if (slider) slider.disabled = followWater;
    const waterLabel = this.shadowRoot.querySelector('.param-value[data-value="water"]');
    if (waterLabel) waterLabel.textContent = followWater ? "跟随设置" : String(waterValue);
    const waterNum = this.shadowRoot.querySelector(".water-num");
    if (waterNum) waterNum.textContent = String(waterValue);
    const waterHint = this.shadowRoot.querySelector(".water-hint");
    if (waterHint) {
      waterHint.textContent = followWater
        ? "开启滑块后按 App 相同的 1-50 刻度自定义出水量"
        : this._waterHint(waterValue);
    }
    const waterPill = this.shadowRoot.querySelector('.follow-pill[data-follow="water"]');
    waterPill?.classList.toggle("active", followWater);
    const effPill = this.shadowRoot.querySelector('.follow-pill[data-follow="efficiency"]');
    effPill?.classList.toggle("active", !this._params.efficiency);
    effPill.textContent = this._params.efficiency ? "自定义中" : "跟随设置";
  }

  _waterHint(value) {
    if (value <= 16) return "接近干拖，仅少量湿润，适合抛光除味";
    if (value <= 27) return "适合湿润环境，拖地水量小，水偏少";
    if (value <= 39) return "水量适中，适合日常湿拖";
    return "水量充沛，适合重污深度湿拖";
  }

  _startTimer() {
    if (this._timer || !this.isConnected || !this._config) return;
    const seconds = Math.max(5, Number(this._config.refresh_interval) || 10);
    this._timer = window.setInterval(() => {
      const vacuum = this._hass?.states[this._config.vacuum_entity];
      // 仅在清扫相关状态下周期刷新地图；空闲（在基站/空闲）时地图是静止的，
      // 周期刷新只会造成无意义的重建与闪烁。
      const active = ["cleaning", "returning", "paused"].includes(vacuum?.state);
      if (active) this._refreshMap(false);
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
      // 内容未变化时跳过重建：避免定时刷新造成可见闪烁与滚动位置丢失
      if (svg === this._lastSvgHtml) {
        this._mapLoaded = true;
        return;
      }
      // 重建前记录视口滚动位置，替换后恢复，防止地图刷新导致滚动条回到顶部
      const prevTop = this._viewport?.scrollTop ?? 0;
      const prevLeft = this._viewport?.scrollLeft ?? 0;
      this._mapElement.innerHTML = svg;
      this._lastSvgHtml = svg;
      this._mapLoaded = true;
      if (this._viewport) {
        this._viewport.scrollTop = prevTop;
        this._viewport.scrollLeft = prevLeft;
      }
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
      // 已成功加载过地图时，瞬时失败（如刷新令牌轮换竞态）不覆盖现有地图，
      // 避免周期刷新偶发的"白屏闪烁"；仅控制台记录，下次刷新自动恢复。
      if (this._mapLoaded) {
        console.warn("[t90-modern-map-card] 地图刷新失败（保留当前地图）:", error);
        return;
      }
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
      // 点选带位移阈值：按住拖动地图（平移/缩放）不会误触发选房
      let downPos = null;
      room.addEventListener("pointerdown", (event) => {
        downPos = { x: event.clientX, y: event.clientY };
      });
      room.addEventListener("pointerup", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (downPos) {
          const dx = event.clientX - downPos.x;
          const dy = event.clientY - downPos.y;
          downPos = null;
          if (dx * dx + dy * dy > 144) return; // 移动超过 12px 视为拖动地图
        }
        this._toggleRoom(id, name);
      });
      room.addEventListener("pointercancel", () => {
        downPos = null;
      });
    });
  }

  _vacuumState() {
    return this._hass?.states[this._config.vacuum_entity]?.state || "unknown";
  }

  _toggleRoom(id, name) {
    // 与科沃斯 App 一致：清扫中/暂停时不允许选择区域
    if (this._selectionLocked) {
      this._setCommandStatus("清扫进行中，无法选择区域", true);
      return;
    }
    if (this._selectedRooms.has(id)) this._selectedRooms.delete(id);
    else this._selectedRooms.set(id, name);
    this._applySelection();
  }

  _loadRoomOrder() {
    try {
      const raw = JSON.parse(localStorage.getItem(this._orderKey()) || "[]");
      return Array.isArray(raw) ? raw.map(Number).filter(Number.isFinite) : [];
    } catch {
      return [];
    }
  }

  _orderKey() {
    return `t90-modern-room-order:${this._config?.vacuum_entity || "default"}`;
  }

  /** 设备端房间表（地图实体的 rooms 属性），顺序即固件/App 的房间列表顺序。 */
  _roomsFromDevice() {
    const attrs = this._hass?.states?.[this._config?.image_entity]?.attributes || {};
    const raw = attrs.rooms;
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for (const item of raw) {
      const id = Number(typeof item === "object" && item !== null ? item.id : item);
      if (!Number.isFinite(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  _orderedRoomIds() {
    // 全屋清扫的"全屋"以设备房间表为准：SVG 里没有绘制路径的房间
    // （如未命名的区域）也必须参与清扫，否则会漏扫。
    const device = this._roomsFromDevice();
    const available = [...this._availableRooms.keys()];
    const pool = device.length ? [...device] : [...available];
    for (const id of available) {
      if (!pool.includes(id)) pool.push(id);
    }
    // 优先级：编辑器配置 room_order > 设备房间顺序
    const configured = (this._config?.room_order || []).map(Number);
    const order = configured.filter((id) => pool.includes(id));
    for (const id of pool) {
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
    // 清扫中/暂停：选择锁定提示（与 App 行为一致）
    if (this._selectionLocked) {
      if (this._selectionText) {
        this._selectionText.textContent =
          this._vacuumState() === "paused"
            ? "已暂停 · 暂停选择区域"
            : "清扫进行中 · 暂停选择区域";
        this._selectionText.classList.remove("has-sel");
      }
      if (this._clearButton) this._clearButton.style.display = "none";
      return;
    }
    // 选择状态栏
    if (this._selectionText) {
      if (this._selectedRooms.size) {
        this._selectionText.textContent = `已选：${[...this._selectedRooms.values()].join("、")}`;
        this._selectionText.classList.add("has-sel");
      } else {
        this._selectionText.textContent = "未选择区域 · 点击地图选择（默认清扫全屋）";
        this._selectionText.classList.remove("has-sel");
      }
    }
    if (this._clearButton) {
      this._clearButton.style.display = this._selectedRooms.size ? "" : "none";
    }
    // 启动按钮：未选房间 = 全屋清扫；已选 = 只清扫所选
    const wholeHouse = this._selectedRooms.size === 0;
    this._startButton.disabled =
      this._cleaning || this._stopping || this._pendingClean ||
      (wholeHouse && this._availableRooms.size === 0 && this._roomsFromDevice().length === 0);
    const btnText = this._startButton.querySelector(".start-text");
    const btnScope = this._startButton.querySelector(".start-scope");
    if (!this._cleaning && btnText) btnText.textContent = "启 动";
    if (btnScope) {
      btnScope.textContent = this._cleaning
        ? "发送中…"
        : wholeHouse ? "全屋" : `${this._selectedRooms.size} 个区域`;
    }
    // AI 智能托管：始终显示（App 智能体模式独立于选房）；开启时隐藏手动参数区。
    // 注意第二参数必须是布尔：toggle(name, undefined) 等于无强制切换，
    // 会把类"翻转"（有则去/无则加），造成参数区随每次 hass 推送闪烁
    const agentBlock = this.shadowRoot.querySelector(".agent-block");
    if (agentBlock) agentBlock.style.display = "";
    this.shadowRoot.querySelector(".params")?.classList.toggle(
      "agent-on", this._params.agent === true,
    );
    this._syncButtons();
  }

  _cleanParams() {
    const params = {};
    if (this._params.suction) params.suction = this._params.suction;
    if (this._params.mode) params.mop_type = this._params.mode;
    if (this._params.water !== null) params.water = this._params.water;
    if (this._params.efficiency) params.efficiency = this._params.efficiency;
    if (this._params.passes > 1) params.passes = this._params.passes;
    return params;
  }

  _describeParams(params) {
    const suctionNames = { quiet: "安静", normal: "标准", max: "强力", max_plus: "强力+" };
    const mopNames = {
      vacuum: "纯扫", mop: "纯拖",
      vacuum_and_mop: "边扫边拖", mop_after_vacuum: "先扫后拖",
    };
    const effNames = { standard: "标准", fast: "快速", deep: "深度" };
    const parts = [];
    if (params.mop_type) parts.push(`模式=${mopNames[params.mop_type] || params.mop_type}`);
    if (params.suction) parts.push(`吸力=${suctionNames[params.suction] || params.suction}`);
    if (params.water !== undefined) parts.push(`水量=${params.water}（${this._waterHint(params.water)}）`);
    if (params.efficiency) parts.push(`效率=${effNames[params.efficiency] || params.efficiency}`);
    if (params.passes > 1) parts.push(`次数=${params.passes}`);
    return parts.join("，");
  }

  async _cleanSelectedRooms() {
    if (!this._hass) return;
    // 任何一次点击都必须有可见反馈：之前这里多处静默 return，
    // 表现就是"点了启动完全没有反应"，无从判断卡在哪一步。
    if (this._cleaning || this._stopping || this._pendingClean) {
      this._setCommandStatus(
        this._pendingClean
          ? "清扫命令已发送，等待机器人开始清扫…"
          : "上一条清扫命令仍在发送中，请稍候…",
        true,
      );
      return;
    }
    if (this._selectionLocked) {
      this._setCommandStatus(
        this._vacuumState() === "paused"
          ? "已暂停：请先「继续清扫」或「结束并返回」"
          : "清扫进行中：请先「暂停」或「结束并返回」",
        true,
      );
      this._syncRunState();
      return;
    }
    const wholeHouse = this._selectedRooms.size === 0;
    const raw = wholeHouse ? this._orderedRoomIds() : [...this._selectedRooms.keys()];
    const roomIds = raw.map((id) => Number(id)).filter((id) => Number.isFinite(id));
    // AI 智能托管（与 App「智能体模式」一致）：开关独立于选房——
    // 全屋托管不需要房间列表；选区托管走 freeClean 短格式（仅房间 ID），
    // 参数由设备端托管生成，不下发手动参数。
    const agentMode = this._params.agent;
    if (!roomIds.length && !(agentMode && wholeHouse)) {
      this._setCommandStatus("未获取到房间列表：请稍后重试（正在重新加载地图）", true);
      this._refreshMap(true);
      return;
    }
    const names = wholeHouse
      ? "全屋"
      : [...this._selectedRooms.values()].join("、");
    const params = agentMode ? {} : this._cleanParams();
    const description = this._describeParams(params);
    const confirmText = agentMode
      ? `确认以「AI 智能托管」清扫${wholeHouse ? "全屋" : `以下区域？\n${names}`}\n吸力/水量/模式/效率由机器人按房间自主决定`
      : wholeHouse
        ? `确认清扫全屋？${description ? `\n参数：${description}` : ""}`
        : `确认清扫以下区域？\n${names}${description ? `\n参数：${description}` : ""}`;
    if (!(await this._askConfirm(confirmText))) {
      this._setCommandStatus("已取消启动");
      return;
    }
    this._cleaning = true;
    this._applySelection();
    const btnScope = this._startButton?.querySelector(".start-scope");
    if (btnScope) btnScope.textContent = "发送中…";
    this._setCommandStatus("正在发送清扫命令…");
    // 兜底：命令卡住（网络/令牌问题）时 20 秒后自动解锁，避免按钮永久失效
    this._cleanGuard = window.setTimeout(() => {
      if (!this._cleaning) return;
      this._cleaning = false;
      this._setCommandStatus("命令发送超时，已解除锁定；请检查网络后重试", true);
      this._applySelection();
    }, 20000);
    try {
      if (agentMode) {
        // AI 智能托管（实测 App 报文）：setSwitchState {"agentClean":1}
        // 全屋走 Clean(START)；选区走 freeClean 短格式（仅房间 ID），
        // 两种都不下发手动参数——参数由设备端托管生成。
        // start:true = 启动清扫；不带 start 的 agent_clean 只切开关
        // （切换开关时用，曾因缺此区分导致一点开启就自动清扫全屋）
        await this._hass.callService("vacuum", "send_command", {
          entity_id: this._config.vacuum_entity,
          command: "agent_clean",
          params: { enable: true, start: true, rooms: wholeHouse ? [] : roomIds },
        });
      } else {
        await this._hass.callService("vacuum", "send_command", {
          entity_id: this._config.vacuum_entity,
          command: "spot_area",
          params: {
            rooms: roomIds,
            cleanings: 1,
            ...params,
          },
        });
      }
      this._setCommandStatus(
        agentMode
          ? `已发送 AI 智能托管清扫命令：${names}`
          : `已发送清扫命令：${names}${description ? `（${description}）` : ""}`,
        false,
        true,
      );
      this._selectedRooms.clear();
      // 乐观锁定：状态上报有延迟，发送成功后立即锁定，
      // 直到实体状态变为 cleaning/paused（_syncRunState）或超时
      this._setPendingClean(true);
    } catch (error) {
      const message = error?.message || String(error);
      this._setCommandStatus(`清扫命令发送失败：${message}`, true);
      this._setPendingClean(false);
    } finally {
      if (this._cleanGuard) {
        window.clearTimeout(this._cleanGuard);
        this._cleanGuard = null;
      }
      this._cleaning = false;
      this._applySelection();
      this._updateVacuumState();
    }
  }

  /** 切换 AI 智能托管：仅下发开关命令（agent_clean 不带 start），
   * 绝不启动清扫——启动只由「启动」按钮触发（start:true）。 */
  _setAgentMode(on) {
    this._params.agent = on;
    this._syncParamUI();
    this._applySelection();
    if (this._hass && this._config?.vacuum_entity) {
      this._hass
        .callService("vacuum", "send_command", {
          entity_id: this._config.vacuum_entity,
          command: "agent_clean",
          params: { enable: on },
        })
        .then(
          () =>
            this._setCommandStatus(
              on ? "已开启 AI 智能托管" : "已关闭 AI 智能托管",
              false,
              true,
            ),
          (error) =>
            this._setCommandStatus(
              `AI 智能托管开关发送失败：${error?.message || error}`,
              true,
            ),
        );
    }
  }

  /** 卡片内确认框（替代 window.confirm，见 .confirm-sheet 注释）。 */
  _askConfirm(text) {
    const box = this._confirmBox;
    if (!box) return Promise.resolve(true); // 极端情况下不阻塞启动
    const textEl = box.querySelector(".confirm-text");
    if (textEl) textEl.textContent = text;
    box.style.display = "";
    if (this._startButton) this._startButton.style.display = "none";
    return new Promise((resolve) => {
      this._confirmResolve = resolve;
    });
  }

  _resolveConfirm(ok) {
    const resolve = this._confirmResolve;
    this._confirmResolve = null;
    if (this._confirmBox) this._confirmBox.style.display = "none";
    if (this._startButton && !this._selectionLocked) {
      this._startButton.style.display = "";
    }
    this._applySelection();
    resolve?.(ok);
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

  async _togglePause() {
    if (!this._hass || this._stopping || this._cleaning) return;
    const paused = this._vacuumState() === "paused";
    const service = paused ? "start" : "pause";
    const pending = paused ? "正在发送继续命令…" : "正在发送暂停命令…";
    const success = paused ? "已继续清扫" : "已暂停清扫";
    this._setCommandStatus(pending);
    try {
      await this._hass.callService("vacuum", service, {
        entity_id: this._config.vacuum_entity,
      });
      this._setCommandStatus(success, false, true);
    } catch (error) {
      const message = error?.message || String(error);
      this._setCommandStatus(`命令发送失败：${message}`, true);
    } finally {
      this._syncRunState();
    }
  }

  async _endAndReturn() {
    if (!this._hass || this._stopping || this._cleaning) return;
    this._stopping = true;
    this._syncButtons();
    const endText = this._endButton?.querySelector(".end-text");
    if (endText) endText.textContent = "正在结束";
    this._setCommandStatus("正在结束清扫并返回基站…");
    try {
      await this._hass.callService("vacuum", "stop", {
        entity_id: this._config.vacuum_entity,
      });
      // 等状态落地后再回充，避免 stop/charge 命令竞态
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
      await this._hass.callService("vacuum", "return_to_base", {
        entity_id: this._config.vacuum_entity,
      });
      this._setCommandStatus("已结束清扫，正在返回基站", false, true);
    } catch (error) {
      const message = error?.message || String(error);
      this._setCommandStatus(`命令发送失败：${message}`, true);
    } finally {
      this._stopping = false;
      if (endText) endText.textContent = "结束并返回";
      this._syncRunState();
    }
  }

  _setCommandStatus(message, isError = false, isSuccess = false) {
    const toast = this._toast || this.shadowRoot.querySelector(".toast");
    if (!toast) return;
    toast.textContent = message;
    toast.style.display = message ? "" : "none";
    toast.classList.toggle("error", isError);
    toast.classList.toggle("success", isSuccess);
    if (this._toastTimer) window.clearTimeout(this._toastTimer);
    if (message) {
      // 成功/过程提示 3.5s 自动消失，错误停留更久
      this._toastTimer = window.setTimeout(() => {
        toast.style.display = "none";
      }, isError ? 8000 : 3500);
    }
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
    this._syncRunState();
  }

  /**
   * 乐观锁定开关：命令发送成功 → 开启；实体状态确认清扫/暂停 → 关闭。
   * 90 秒兜底超时自动解除（命令被设备接受但机器人始终未启动的场景，
   * 如故障/找不到地图），避免按钮永久锁死。
   */
  _setPendingClean(on) {
    this._pendingClean = on;
    if (this._pendingGuard) {
      window.clearTimeout(this._pendingGuard);
      this._pendingGuard = null;
    }
    if (on) {
      this._pendingGuard = window.setTimeout(() => {
        this._pendingGuard = null;
        if (!this._pendingClean) return;
        this._pendingClean = false;
        this._setCommandStatus(
          "已等待较久机器人仍未开始清扫，已恢复操作；请检查设备状态后重试",
          true,
        );
        this._syncRunState();
      }, 90000);
    }
    this._syncRunState();
  }

  /** 清扫状态联动（与科沃斯 App 一致）：
   *
   * - 清扫中/暂停：锁定地图选房与启动按钮，主按钮区切换为
   *   「暂停/继续」+「结束并返回」两个按钮。
   * - 其他状态：显示启动按钮，允许地图点选。
   */
  _syncRunState() {
    const state = this._vacuumState();
    // 实体状态已确认清扫/暂停：解除乐观锁定，交给真实状态接管
    if (this._pendingClean && (state === "cleaning" || state === "paused")) {
      this._setPendingClean(false);
    }
    const active =
      state === "cleaning" || state === "paused" || this._pendingClean;
    this._selectionLocked = active;
    this._viewport?.classList.toggle("locked", active);
    if (active && this._selectedRooms.size) {
      this._selectedRooms.clear();
    }
    if (active && this._confirmResolve) {
      // 清扫态出现时，撤销未决的启动确认（避免两个按钮区同时可见）
      this._resolveConfirm(false);
    }
    // 主按钮区切换：启动 ↔ 暂停/结束并返回
    if (this._startButton && this._activeActions) {
      this._startButton.style.display = active || this._confirmResolve ? "none" : "";
      this._activeActions.classList.toggle("show", active);
    }
    // 暂停按钮：图标+文案随状态切换
    if (this._pauseButton) {
      const paused = state === "paused";
      const iconPause = this._pauseButton.querySelector(".pi-pause");
      const iconPlay = this._pauseButton.querySelector(".pi-play");
      if (iconPause) iconPause.style.display = paused ? "none" : "";
      if (iconPlay) iconPlay.style.display = paused ? "" : "none";
      if (this._pauseText) this._pauseText.textContent = paused ? "继续清扫" : "暂停";
    }
    this._syncButtons();
    this._applySelection();
  }

  /** 按钮可按性：回充按状态置灰，清扫动作进行中时暂停/结束短暂禁用。 */
  _syncButtons() {
    const state = this._vacuumState();
    const dockBtn = this.shadowRoot.querySelector(".dock");
    if (dockBtn) {
      dockBtn.disabled = ["docked", "returning", "unavailable", "unknown"].includes(state);
    }
    if (this._pauseButton) {
      // 乐观锁定且状态尚未确认为清扫/暂停时，暂停/结束暂不可按：
      // 机器人还没真正开始，此时下发暂停会失败
      const pendingWait = this._pendingClean && !["cleaning", "paused"].includes(state);
      this._pauseButton.disabled = this._stopping || this._cleaning || pendingWait;
    }
    if (this._endButton) {
      const pendingWait = this._pendingClean && !["cleaning", "paused"].includes(state);
      this._endButton.disabled = this._stopping || this._cleaning || pendingWait;
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
    description: "按科沃斯 App 风格设计：地图点选区域、启动按钮、模式/吸力/水量滑块/清洁效率/次数",
    preview: true,
  });
}
