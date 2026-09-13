class EcovacsT90MapCardEditor extends HTMLElement {
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
      </style>
      <div class="form">
        <ha-textfield class="title" label="卡片标题"></ha-textfield>
        <ha-entity-picker class="image" label="地图图像实体（必选）"></ha-entity-picker>
        <ha-entity-picker class="vacuum" label="扫地机器人实体（必选）"></ha-entity-picker>
        <ha-textfield class="interval" type="number" min="5" max="300"
          label="刷新间隔（秒）"></ha-textfield>
        <div class="hint">
          选择官方 Ecovacs 集成生成的地图图像实体和扫地机器人实体。
          工作期间会按间隔刷新，空闲时最多每分钟刷新一次。
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

class EcovacsT90MapCard extends HTMLElement {
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
  }

  setConfig(config) {
    if (!config.image_entity || !config.vacuum_entity) {
      throw new Error("image_entity and vacuum_entity are required");
    }
    this._config = {
      title: "T90 地图",
      refresh_interval: 10,
      ...config,
    };
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
    return document.createElement("ecovacs-t90-map-card-editor");
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
          border-radius: var(--ha-card-border-radius, 16px);
          border: none;
          box-shadow: var(--ha-card-box-shadow, 0 2px 12px rgb(0 0 0 / .1));
        }
        .header { display: flex; align-items: center; gap: 12px; padding: 13px 12px 11px 16px; }
        .avatar {
          width: 38px; height: 38px; border-radius: 12px; flex: 0 0 auto;
          display: flex; align-items: center; justify-content: center; color: #fff;
          background: linear-gradient(135deg,
            var(--primary-color, #03a9f4),
            color-mix(in srgb, var(--primary-color, #03a9f4) 55%, #7c4dff));
          box-shadow: 0 2px 8px rgb(0 0 0 / .18);
        }
        .title { min-width: 0; flex: 1; font-size: 17px; font-weight: 700; letter-spacing: .2px; }
        .state-pill {
          --tone: var(--secondary-text-color);
          display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto;
          height: 26px; padding: 0 11px; border-radius: 13px;
          color: var(--tone); font-size: 12.5px; font-weight: 600; white-space: nowrap;
          background: color-mix(in srgb, var(--tone) 14%, transparent);
          transition: background .25s, color .25s;
        }
        .state-pill .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--tone); }
        .state-pill.cleaning { --tone: var(--primary-color); background: color-mix(in srgb, var(--tone) 22%, transparent); }
        .state-pill.cleaning .dot { animation: t90-pulse 1.4s ease-in-out infinite; }
        .state-pill.docked { --tone: #4caf50; }
        .state-pill.returning { --tone: #03a9f4; }
        .state-pill.paused { --tone: #ff9800; }
        .state-pill.idle { --tone: #9e9e9e; }
        .state-pill.error { --tone: var(--error-color, #f44336); }
        @keyframes t90-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: .35; transform: scale(.7); }
        }
        .viewport {
          height: min(62vh, 640px); min-height: 300px; overflow: auto;
          background: radial-gradient(circle at 50% 0%,
            color-mix(in srgb, var(--primary-color, #03a9f4) 7%, transparent), transparent 65%),
            var(--secondary-background-color);
          overscroll-behavior: contain;
          transition: height .3s ease;
        }
        .map {
          display: flex; min-width: 100%; min-height: 100%; align-items: center;
          justify-content: center; padding: 12px; box-sizing: border-box;
        }
        .map svg {
          display: block; flex: 0 0 auto; height: auto; max-width: none;
          touch-action: pan-x pan-y; border-radius: 10px;
          box-shadow: 0 2px 14px rgb(0 0 0 / .12);
        }
        .loading, .error { margin: auto; padding: 32px; color: var(--secondary-text-color); }
        .loading { display: flex; align-items: center; gap: 10px; font-size: 14px; }
        .loading::before {
          content: ""; width: 18px; height: 18px; border-radius: 50%;
          border: 2.5px solid var(--divider-color); border-top-color: var(--primary-color);
          animation: t90-spin 1s linear infinite;
        }
        @keyframes t90-spin { to { transform: rotate(360deg); } }
        .error { color: var(--error-color); }
        .controls {
          display: grid; grid-template-columns: auto auto minmax(120px, 1fr) auto auto auto;
          align-items: center; gap: 7px; padding: 10px 12px;
          border-top: 1px solid var(--divider-color);
        }
        .command-status {
          min-height: 18px; padding: 0 16px 9px; color: var(--secondary-text-color);
          font-size: 13px; text-align: center;
        }
        .command-status:empty { display: none; }
        .command-status.error { color: var(--error-color); }
        .command-status.success { color: var(--success-color, #2e7d32); }
        button {
          height: 38px; min-width: 38px; border: 0; border-radius: 50%;
          color: var(--primary-text-color); background: var(--secondary-background-color);
          cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
          gap: 7px; transition: background .15s, transform .1s, box-shadow .15s, opacity .15s;
        }
        button:hover { background: color-mix(in srgb, var(--primary-color) 12%, var(--secondary-background-color)); }
        button:active { transform: scale(.93); }
        button:disabled { opacity: .4; cursor: default; transform: none; }
        button.primary, button.stop {
          height: 38px; padding: 0 16px; border-radius: 19px;
          color: var(--text-primary-color, #fff); font-weight: 600; letter-spacing: .3px;
          box-shadow: 0 2px 8px rgb(0 0 0 / .22);
        }
        button.primary { background: var(--primary-color); }
        button.stop { background: var(--error-color, #db4437); }
        button.primary:hover { background: var(--primary-color); filter: brightness(1.06); }
        button.stop:hover { background: var(--error-color, #db4437); filter: brightness(1.06); }
        input[type="range"] { width: 100%; accent-color: var(--primary-color); }
        .selection {
          min-height: 44px; padding: 8px 14px; display: flex; align-items: center;
          gap: 7px; flex-wrap: wrap; border-top: 1px solid var(--divider-color);
        }
        .selection-label { color: var(--secondary-text-color); font-size: 13px; margin-right: 2px; }
        .chip {
          height: 32px; min-width: auto; padding: 4px 14px; border-radius: 16px;
          border: 1.5px solid var(--divider-color);
          background: var(--card-background-color, #fff); font-size: 13px; font-weight: 500;
          display: inline-flex; align-items: center; gap: 4px; cursor: pointer;
          transition: border-color .15s, background .15s, color .15s, box-shadow .15s, transform .1s;
        }
        .chip ha-icon { --mdc-icon-size: 14px; }
        .chip:hover { border-color: var(--primary-color); color: var(--primary-color); }
        .chip:active { transform: scale(.95); }
        .chip.selected {
          color: var(--text-primary-color, #fff); border-color: transparent;
          background: var(--primary-color); font-weight: 600;
          box-shadow: 0 2px 8px color-mix(in srgb, var(--primary-color) 40%, transparent);
        }
        .chip.clear {
          color: var(--error-color, #f44336);
          border-color: color-mix(in srgb, var(--error-color, #f44336) 40%, transparent);
        }
        dialog.map-dialog {
          width: min(96vw, 1440px); height: 92vh; max-width: none; max-height: none;
          margin: auto; padding: 0; border: 0; border-radius: 16px;
          color: var(--primary-text-color); background: var(--card-background-color, #fff);
          box-shadow: 0 8px 40px rgb(0 0 0 / .35); overflow: hidden;
        }
        dialog.map-dialog::backdrop { background: rgb(0 0 0 / .58); }
        .dialog-layout { height: 100%; display: flex; flex-direction: column; }
        .dialog-header {
          display: flex; align-items: center; gap: 10px; flex: 0 0 auto;
          padding: 8px 10px 8px 16px; border-bottom: 1px solid var(--divider-color);
        }
        .dialog-title { min-width: 0; flex: 1; font-size: 17px; font-weight: 700; }
        .dialog-scale { min-width: 46px; color: var(--secondary-text-color); text-align: right; font-size: 13px; }
        .dialog-viewport {
          min-height: 0; flex: 1 1 auto; overflow: auto; overscroll-behavior: contain;
          background: var(--secondary-background-color);
        }
        .dialog-map {
          display: flex; min-width: 100%; min-height: 100%; align-items: center;
          justify-content: center; padding: 12px; box-sizing: border-box;
        }
        .dialog-map svg {
          display: block; flex: 0 0 auto; height: auto; max-width: none;
          touch-action: pan-x pan-y; border-radius: 10px;
          box-shadow: 0 2px 14px rgb(0 0 0 / .12);
        }
        .dialog-controls {
          display: grid; grid-template-columns: auto auto auto minmax(120px, 1fr);
          align-items: center; gap: 7px; flex: 0 0 auto; padding: 9px 12px;
          border-top: 1px solid var(--divider-color);
        }
        @media (max-width: 600px) {
          .header { padding: 11px 10px 9px 14px; }
          .avatar { width: 34px; height: 34px; border-radius: 10px; }
          .viewport { height: 54vh; min-height: 300px; }
          .controls { grid-template-columns: auto auto minmax(80px, 1fr) auto; }
          button.primary, button.stop { grid-column: 1 / -1; width: 100%; border-radius: 12px; }
          dialog.map-dialog { width: 100vw; height: 100dvh; border-radius: 0; }
          .dialog-controls { grid-template-columns: auto auto auto minmax(80px, 1fr); }
        }
      </style>
      <ha-card>
        <div class="header">
          <div class="avatar"><ha-icon icon="mdi:robot-vacuum"></ha-icon></div>
          <div class="title"></div>
          <div class="state-pill"><span class="dot"></span><span class="state-text"></span></div>
          <button class="expand" title="弹窗查看地图" aria-label="弹窗查看地图"><ha-icon icon="mdi:arrow-expand-all"></ha-icon></button>
        </div>
        <div class="viewport"><div class="map"><div class="loading">正在加载地图</div></div></div>
        <div class="selection"><span class="selection-label">未选择区域</span></div>
        <div class="controls">
          <button class="zoom-out" title="缩小" aria-label="缩小"><ha-icon icon="mdi:magnify-minus-outline"></ha-icon></button>
          <button class="zoom-in" title="放大" aria-label="放大"><ha-icon icon="mdi:magnify-plus-outline"></ha-icon></button>
          <input class="zoom" type="range" min="0.5" max="3" step="0.1" value="1" aria-label="地图缩放">
          <button class="refresh" title="刷新地图和位置" aria-label="刷新地图和位置"><ha-icon icon="mdi:refresh"></ha-icon></button>
          <button class="primary clean" disabled><ha-icon icon="mdi:robot-vacuum"></ha-icon><span>清扫所选区域</span></button>
          <button class="stop" disabled><ha-icon icon="mdi:stop-circle-outline"></ha-icon><span>停止清扫</span></button>
        </div>
        <div class="command-status" aria-live="polite"></div>
      </ha-card>
      <dialog class="map-dialog" aria-label="T90 地图缩放窗口">
        <div class="dialog-layout">
          <div class="dialog-header">
            <div class="dialog-title"></div>
            <div class="dialog-scale">100%</div>
            <button class="dialog-close" title="关闭" aria-label="关闭"><ha-icon icon="mdi:close"></ha-icon></button>
          </div>
          <div class="dialog-viewport"><div class="dialog-map"></div></div>
          <div class="dialog-controls">
            <button class="dialog-zoom-out" title="缩小" aria-label="缩小"><ha-icon icon="mdi:magnify-minus-outline"></ha-icon></button>
            <button class="dialog-reset" title="恢复 100%" aria-label="恢复 100%"><ha-icon icon="mdi:restore"></ha-icon></button>
            <button class="dialog-zoom-in" title="放大" aria-label="放大"><ha-icon icon="mdi:magnify-plus-outline"></ha-icon></button>
            <input class="dialog-zoom" type="range" min="0.4" max="4" step="0.1" value="1" aria-label="弹窗地图缩放">
          </div>
        </div>
      </dialog>`;

    this.shadowRoot.querySelector(".title").textContent = this._config.title;
    this._mapElement = this.shadowRoot.querySelector(".map");
    this._selectionElement = this.shadowRoot.querySelector(".selection");
    this._cleanButton = this.shadowRoot.querySelector(".clean");
    this._stopButton = this.shadowRoot.querySelector(".stop");
    this._dialog = this.shadowRoot.querySelector(".map-dialog");
    this._dialogMapElement = this.shadowRoot.querySelector(".dialog-map");
    this.shadowRoot.querySelector(".dialog-title").textContent = this._config.title;
    this.shadowRoot.querySelector(".expand").addEventListener("click", () => this._openMapDialog());
    this.shadowRoot.querySelector(".zoom-out").addEventListener("click", () => this._setZoom(this._zoom - 0.1));
    this.shadowRoot.querySelector(".zoom-in").addEventListener("click", () => this._setZoom(this._zoom + 0.1));
    this.shadowRoot.querySelector(".zoom").addEventListener("input", (event) => this._setZoom(Number(event.target.value)));
    this.shadowRoot.querySelector(".refresh").addEventListener("click", () => this._refreshMap(true));
    this.shadowRoot.querySelector(".dialog-close").addEventListener("click", () => this._dialog.close());
    this.shadowRoot.querySelector(".dialog-zoom-out").addEventListener("click", () => this._setDialogZoom(this._dialogZoom - 0.1));
    this.shadowRoot.querySelector(".dialog-zoom-in").addEventListener("click", () => this._setDialogZoom(this._dialogZoom + 0.1));
    this.shadowRoot.querySelector(".dialog-reset").addEventListener("click", () => this._setDialogZoom(1));
    this.shadowRoot.querySelector(".dialog-zoom").addEventListener("input", (event) => this._setDialogZoom(Number(event.target.value)));
    this.shadowRoot.querySelector(".dialog-viewport").addEventListener("wheel", (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      this._setDialogZoom(this._dialogZoom + (event.deltaY < 0 ? 0.1 : -0.1));
    }, { passive: false });
    this._dialog.addEventListener("click", (event) => {
      if (event.target === this._dialog) this._dialog.close();
    });
    this._cleanButton.addEventListener("click", () => this._cleanSelectedRooms());
    this._stopButton.addEventListener("click", () => this._stopCleaning());
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
      this._applyZoom();
      if (this._dialog?.open) this._syncDialogMap();
      this._applySelection();
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
    const slider = this.shadowRoot.querySelector(".zoom");
    if (slider) slider.value = String(this._zoom);
    this._applyZoom();
  }

  _applyZoom() {
    const svg = this._mapElement?.querySelector("svg");
    if (!svg) return;
    svg.style.width = `${this._zoom * 100}%`;
    const viewport = this.shadowRoot.querySelector(".viewport");
    const view = svg.viewBox?.baseVal;
    if (viewport && view?.width && view?.height && this._zoom === 1) {
      const padding = 24;
      const fit =
        Math.round(((viewport.clientWidth - padding) * view.height) / view.width) + padding;
      const max = Math.max(300, Math.round(window.innerHeight * 0.62));
      viewport.style.height = `${Math.min(Math.max(fit, 300), max)}px`;
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
    this._dialogMapElement.replaceChildren(svg.cloneNode(true));
    this._bindRoomEvents(this._dialogMapElement, false);
    this._applyDialogZoom();
    this._applySelection();
  }

  _setDialogZoom(value) {
    this._dialogZoom = Math.min(4, Math.max(0.4, Math.round(value * 10) / 10));
    const slider = this.shadowRoot.querySelector(".dialog-zoom");
    const scale = this.shadowRoot.querySelector(".dialog-scale");
    if (slider) slider.value = String(this._dialogZoom);
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

  _applySelection() {
    this._mapElement?.querySelectorAll("[data-room-id]").forEach((room) => {
      room.classList.toggle("t90-selected", this._selectedRooms.has(Number(room.dataset.roomId)));
    });
    this._dialogMapElement?.querySelectorAll("[data-room-id]").forEach((room) => {
      room.classList.toggle("t90-selected", this._selectedRooms.has(Number(room.dataset.roomId)));
    });
    if (!this._selectionElement) return;
    this._selectionElement.replaceChildren();
    const label = document.createElement("span");
    label.className = "selection-label";
    label.textContent = this._selectedRooms.size ? `已选择 ${this._selectedRooms.size} 个区域` : "未选择区域";
    this._selectionElement.append(label);
    for (const [id, name] of this._availableRooms) {
      const chip = document.createElement("button");
      chip.className = "chip";
      chip.classList.toggle("selected", this._selectedRooms.has(id));
      chip.textContent = name;
      chip.addEventListener("click", () => this._toggleRoom(id, name));
      this._selectionElement.append(chip);
    }
    if (this._selectedRooms.size) {
      const clear = document.createElement("button");
      clear.className = "chip clear";
      const icon = document.createElement("ha-icon");
      icon.icon = "mdi:close";
      clear.append(icon, "清除");
      clear.addEventListener("click", () => {
        this._selectedRooms.clear();
        this._applySelection();
      });
      this._selectionElement.append(clear);
    }
    this._cleanButton.disabled =
      this._cleaning || this._stopping || this._selectedRooms.size === 0;
  }

  async _cleanSelectedRooms() {
    if (!this._hass || !this._selectedRooms.size || this._cleaning) return;
    const names = [...this._selectedRooms.values()].join("、");
    if (!window.confirm(`确认清扫以下区域？\n${names}`)) return;
    this._cleaning = true;
    this._cleanButton.disabled = true;
    const buttonText = this._cleanButton.querySelector("span");
    if (buttonText) buttonText.textContent = "正在发送";
    this._setCommandStatus("正在发送区域清扫命令…");
    try {
      await this._hass.callService("vacuum", "send_command", {
        entity_id: this._config.vacuum_entity,
        command: "spot_area",
        params: {
          rooms: [...this._selectedRooms.keys()],
          cleanings: 1,
        },
      });
      this._setCommandStatus(`已发送清扫命令：${names}`, false, true);
      this._selectedRooms.clear();
    } catch (error) {
      const message = error?.message || String(error);
      this._setCommandStatus(`清扫命令发送失败：${message}`, true);
    } finally {
      this._cleaning = false;
      if (buttonText) buttonText.textContent = "清扫所选区域";
      this._applySelection();
      this._updateVacuumState();
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
      if (buttonText) buttonText.textContent = "停止清扫";
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
    const toneMap = {
      cleaning: "cleaning",
      docked: "docked",
      returning: "returning",
      paused: "paused",
      idle: "idle",
      unavailable: "error",
    };
    const element = this.shadowRoot.querySelector(".state-pill");
    if (element) {
      element.className = `state-pill ${toneMap[state] || "idle"}`;
      const text = element.querySelector(".state-text");
      if (text) text.textContent = stateNames[state] || state;
    }
    if (this._stopButton) {
      this._stopButton.disabled = this._stopping || this._cleaning;
    }
  }
}

if (!customElements.get("ecovacs-t90-map-card-editor")) {
  customElements.define("ecovacs-t90-map-card-editor", EcovacsT90MapCardEditor);
}

if (!customElements.get("ecovacs-t90-map-card")) {
  customElements.define("ecovacs-t90-map-card", EcovacsT90MapCard);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === "ecovacs-t90-map-card")) {
  window.customCards.push({
    type: "ecovacs-t90-map-card",
    name: "科沃斯 T90 地图",
    description: "可缩放、选择房间并分区清扫的 T90 地图卡片",
    preview: true,
    documentationURL: "https://github.com/lifujie25/ha-ecovacs-t90-pro",
  });
}
