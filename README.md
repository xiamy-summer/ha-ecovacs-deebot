# Ecovacs Deebot (T90 PRO and more)

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://github.com/hacs/integration)
![HA Version](https://img.shields.io/badge/Home%20Assistant-2024.7%2B-blue)
![License](https://img.shields.io/badge/License-GPL--3.0-green)

非官方的**科沃斯（Ecovacs）扫地机器人 Home Assistant 集成**，专为官方集成不支持的新机型而生——内置机型定义，登录即用，无需修改容器内任何文件。

> 🇬🇧 English users: see [English](#english) section below.

## ✨ 为什么做这个项目

HA 内置的 Ecovacs 集成依赖 [deebot_client](https://github.com/DeebotUniverse/client.py) 库的机型库，**国行新机型收录严重滞后**。如果你的机器人登录后没有设备、或提示 `Device not supported`（比如 T50 PRO、T90 PRO、X5 PRO 等国行新机型），这个项目就是解决方案：

| 对比 | 官方集成 | 本集成 |
|---|---|---|
| 新机型支持 | 等官方库收录 | **内置定义，开箱即用** |
| 机型定义方式 | 修改容器内文件 / 软链接（升级即失效） | 集成自带，**升级不失效** |
| 未收录机型 | 直接报 not supported | 自动用内置定义"救回" |
| 中文界面 | 部分机器翻译 | 完整简体中文 |

## 📦 已内置机型

| 机型 | 内部 class | 支持内容 |
|---|---|---|
| **DEEBOT T90 PRO 上下水款**（SHAKESPEARE_WH_AUTO） | `jkzzec` | 清扫/拖地/断点续扫/风扇档位/水量调节/地图（主图+子图）/基站集尘洗布烘干/耗材寿命/清扫统计/童锁/音量/OTA 等 |

> 基于 T90 PRO OMNI（`twunby`）能力定义适配。上下水专属功能（自动上下水开关）暂未收录，可在机器端或科沃斯 App 操作。

## 🔧 安装

### 方式一：HACS（推荐）

1. 确保 已安装 [HACS](https://hacs.xyz/)
2. HACS → 右上角 ⋮ → **自定义存储库**
3. 仓库地址填入本仓库地址，类别选 **集成（Integration）**
4. 点击添加，然后在本项目中点击 **下载**
5. 重启 Home Assistant

### 方式二：手动安装

1. 下载本仓库最新 Release 的 zip 并解压
2. 将 `custom_components/ecovacs_deebot` 整个目录复制到 HA 配置目录：

```
config/
└── custom_components/
    └── ecovacs_deebot/     ← 整个目录放这里
        ├── manifest.json
        ├── __init__.py
        ├── hardware/
        └── ...
```

> ⚠️ 注意：目录名必须是 `ecovacs_deebot`（与集成 domain 一致），manifest.json 必须直接位于该目录下。

3. 重启 Home Assistant

## ⚙️ 配置

1. **设置 → 设备与服务 → 添加集成**，搜索 **Ecovacs Deebot**
2. 输入科沃斯 App 的**账号密码**，国家选择 `cn`（中国大陆）
3. 如科沃斯下发验证码，按提示输入完成设备验证
4. 完成！设备与实体会自动出现

> 💡 建议先停用/删除官方 Ecovacs 集成，避免同一账号多条 MQTT 连接互相踢会话。

## 🗺️ 实体一览

- **vacuum**：吸尘器主体（启动/暂停/回充/区域清扫/扇区清扫）
- **image.地图**：实时地图（SVG，需机器人在线且保存过地图）
- **传感器**：电量、错误码、本次/累计清扫面积与时长、基站状态、Wi-Fi 信息、各类耗材寿命
- **按钮**：重新定位、集尘、烘干拖布、清洗基站、各类耗材重置（默认禁用，按需启用）
- **开关**：断点续扫、童锁、智能探测等
- **选择/数字**：工作模式、水量、自动集尘频率、清扫次数、音量

部分实体默认禁用，到 **设备页面 → 实体 → 筛选器** 中按需启用。

## ❓ 常见问题

<details>
<summary><b>登录成功但没有设备</b></summary>

看日志（设置 → 系统 → 日志）里是否有 `supported via bundled hardware definition`。如果没有，说明你的机型还没被收录——[提个 Issue](../../issues/new) 并附上日志中的 `class` 值，参考下方"新增机型"指南。
</details>

<details>
<summary><b>地图实体不可用</b></summary>

1. 确认机器人在充电座上、连着 Wi-Fi 且在线
2. 让机器人跑一次清扫，或按"重新定位"按钮触发地图上报
3. 检查网络中是否有 AdGuard Home / Pi-hole 等去广告服务拦截了科沃斯域名，如有请放行：

```
*.ecouser.net
*.ecovacs.cn
dc-cn.cn.ecouser.net
```
</details>

<details>
<summary><b>日志出现 Unexpected message ID in on_subscribe</b></summary>

这是 MQTT 订阅确认超时，通常是网络到科沃斯中国区服务器不稳定，或同一账号有第二个连接在抢会话（重复的集成条目）。确保本账号只配置了一个集成。
</details>

<details>
<summary><b>个别实体不可用</b></summary>

刚启动时实体需要等机器人第一次响应数据，稍等几分钟或让机器人动一动即可。长期不可用的实体说明该机型不支持对应命令，可在设备页面停用。
</details>

## 🧩 新增机型定义

如果你的科沃斯机型未收录（日志中 `Device "xxx" not supported` 里有 `class` 值）：

1. 到 [DeebotUniverse/client.py 机型目录](https://github.com/DeebotUniverse/client.py/tree/dev/deebot_client/hardware) 找一个**同系列、功能相近**的机型文件
2. 复制到 `custom_components/ecovacs_deebot/hardware/<你的class>.py`
3. 在 `hardware/__init__.py` 的 `_BUNDLED` 表里注册：

```python
_BUNDLED: dict[str, str] = {
    "jkzzec": "jkzzec",
    "你的class": "你的class",   # 新增这一行
}
```

4. 重启 HA，日志出现 `Using bundled hardware definition` 即生效
5. 欢迎提 PR 把新机型贡献回来！

## 🛠️ 开发工具

`tools/probe.py`：独立的协议探测脚本，可直接登录科沃斯账号逐条测试命令支持情况（排查地图等问题时很有用）：

```bash
pip install -r tools/requirements.txt
python tools/probe.py --account 手机号 --password 密码
```

## <a id="english"></a>English

Unofficial Home Assistant integration for Ecovacs DEEBOT robots, focused on **new China-market models not yet supported by the built-in integration** (e.g. DEEBOT T90 PRO, class `jkzzec`).

- Bundled hardware definitions — no container symlinks, survives HA upgrades
- Auto-rescues devices reported as "not supported" by the upstream library
- Full Simplified Chinese translations
- Install via HACS (add this repo as a custom repository, category *Integration*) or manually copy `custom_components/ecovacs_deebot` into your `config/custom_components/` folder
- Based on [DeebotUniverse/client.py](https://github.com/DeebotUniverse/client.py)

## 🙏 致谢

- [DeebotUniverse/client.py](https://github.com/DeebotUniverse/client.py) — 核心协议库
- [Home Assistant Core](https://github.com/home-assistant/core) — 官方 ecovacs 集成模板
- [lifujie25/ha-ecovacs-t90-pro](https://github.com/lifujie25/ha-ecovacs-t90-pro) — v0.2.0 的中国区 T90 地图协议兼容实现（`t90_map.py`、地图卡片）移植自该项目
- [HACS](https://hacs.xyz/)

## 📄 许可证

[GPL-3.0](LICENSE)（自 v0.2.0 起；v0.1.0 为 MIT）——因引入 GPL-3.0 许可的移植代码，本项目整体采用 GPL-3.0。本项目与科沃斯（Ecovacs）官方无关，仅供学习交流使用。
