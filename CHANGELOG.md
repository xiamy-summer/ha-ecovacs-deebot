# 更新日志

## v0.3.0 — AI 智能托管 + 全新现代化地图卡片

> 面向 DEEBOT T90 PRO（`jkzzec`）等中国区机型，本版围绕「App 化体验」重构了地图卡片与清扫交互。

### ✨ 新功能

- **AI 智能托管（智能体模式）**：卡片内一键开启，吸力/水量/清洁模式/清洁效率全部交由机器人按房间类型与地面材质自主决定
  - 对齐科沃斯 App 智能体模式：托管是独立模式入口，开启后**仍可点选房间再启动**，也可直接启动全屋
  - 真实命令为 `iot/p2p/setSwitchState`（`agentClean: 1/0`），非 `clean.preference`
  - **开关状态与设备双向同步**：注册 `onSwitchState` 消息，App 里切换托管后卡片自动跟随；实体新增 `agent_clean` 属性（on/off/null）
- **全新现代化简约地图卡片 `t90-modern-map-card`**：地图自适应、点击地图直接选房、房间胶囊拖拽排序、附加状态显示
- **App 风格清扫参数区**：清洁模式 / 吸力 / 水量（1-50 刻度滑块）/ 清洁效率 / 清扫次数，逐项可调
- **每房间独立吸力与清洁模式**，编辑器内支持区域排序
- **清洁场景（App 快捷指令）**：`select.清洁场景` 自动列出 App 保存的快捷指令，选择即重放；新增 `ecovacs_deebot.run_scenario` / `get_clean_scenarios` 服务
- **定时清扫蓝图**：`科沃斯 T90 - 定时区域清扫`（指定时间 + 星期 + 房间 + 吸力，支持"扫后拖"执行日）
- 集成 [Osezno-byte/ecovacs-omni-ha](https://github.com/Osezno-byte/ecovacs-omni-ha) 的协议资产：freeClean 9 字段扩展编码器、`getQuickCommand` 场景发现、zstd subsets 解析（MIT）

### 🐛 修复

- 卡片「启动」按钮无反应 / 启动后可重复点击：加入乐观锁定 `_pendingClean`，避免状态上报延迟期重复下发清扫命令
- 刷新页面时参数区反复闪烁：`classList.toggle(name, undefined)` 导致 `agent-on` 类被每次状态推送翻转
- 点开 AI 托管即自动全屋清扫：切开关与「启动清扫」语义分离（只有显式 `start` 才下发启动命令）
- 开启托管后手动参数区未隐藏（CSS 未落盘）
- 拖拽排序真根因修复：指针捕获在 DOM 移动时被释放；顺序改用设备房间表
- `T90FreeCleanV2` 属性赋值顺序导致的启动报错
- 集成导入崩溃两连修：`MessageBodyDataDict` 子类必须自带 `NAME`；`OnSwitchState` 写 `(Message, MessageBodyDataDict)` 引发 MRO 冲突
- 地图卡片缓存：资源 URL 按文件内容哈希自动破缓存，避免更新后浏览器仍加载旧 JS
- `run_scenario` 服务 schema 修正（`entity_id` 必填、普通 dict 由 HA 自动包装）

### 🛠️ 开发工具（tools/）

- `ai_pref_probe.py`：**只读**探测 App「AI 智能托管」真实命令（`get*` 查询 + MQTT 全量报文监听），不会启动清扫
- `agent_clean_class_check.py`：本地起桩复刻 deebot_client 类层次，提前暴露 `NAME` 缺失 / MRO 冲突两类导入期错误
- 无头 UI 复现脚本：`flash_repro.html`（刷新闪烁）、`agent_sync_repro.html`（托管状态同步）、`start_flow_test.mjs`（36 项交互回归）

### 📄 文档

- README 新增「效果预览」：地图卡片与 AI 智能托管实机截图
- 致谢区突出两位开源项目作者 [@lifujie25](https://github.com/lifujie25)、[@Osezno-byte](https://github.com/Osezno-byte)

### ⚠️ 已知问题

- 用 HA 智能体模式启动后，科沃斯 App 仍显示「按我的设置清扫」——托管 + 选区的启动命令格式待进一步抓包确认。

## v0.2.0 — 中国区 T90 地图协议兼容

- 移植 [lifujie25/ha-ecovacs-t90-pro](https://github.com/lifujie25/ha-ecovacs-t90-pro) 的中国区 T90 地图协议实现（`t90_map.py`、地图卡片）
- 机型定义内置（`hardware/`），登录即用，升级不失效
- 完整简体中文翻译；许可证切换为 GPL-3.0

## v0.1.0 — 首个版本

- 非官方科沃斯（Ecovacs）Home Assistant 集成雏形（MIT）
