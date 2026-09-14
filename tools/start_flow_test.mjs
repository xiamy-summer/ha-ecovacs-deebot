#!/usr/bin/env node
/**
 * 启动流程无头仿真：从卡片源码里抽出真实的 _cleanSelectedRooms / _askConfirm /
 * _resolveConfirm 方法，配上 mock 的 this，验证"点启动"这条链路的每种分支。
 *
 * 为什么需要它：这条链路以前有多个静默 return（锁定/无房间/原生 confirm 被
 * WebView 拦截），用户只能看到"点了没反应"，HA 日志里也没有任何痕迹。
 * 现在改成"任何一次点击都必须有 toast 反馈 + 卡片内确认框"，用这个脚本保证
 * 这些分支不会再退化。
 *
 * 用法：node tools/start_flow_test.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(
  here,
  "../custom_components/ecovacs_deebot/frontend/t90-modern-map-card.js",
);
const source = readFileSync(FILE, "utf8");

/** 从源码里按名字抽出类方法，转成可直接 new Function 的函数表达式源码。 */
function extractMethod(name) {
  const asyncAt = source.indexOf(`  async ${name}(`);
  const plainAt = source.indexOf(`  ${name}(`);
  const at = asyncAt !== -1 && (plainAt === -1 || asyncAt < plainAt) ? asyncAt : plainAt;
  if (at === -1) throw new Error(`方法 ${name} 未找到`);
  const isAsync = at === asyncAt;
  const open = source.indexOf("{", at);
  let depth = 0;
  let i = open;
  let quote = null;
  while (i < source.length) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        // 方法简写 -> 函数表达式：`async foo(a) {` => `async function foo(a) {`
        const head = `${isAsync ? "async function" : "function"} ${name}`;
        const body = source.slice(open, i + 1);
        return `${head}${source.slice(at + (isAsync ? `  async ${name}` : `  ${name}`).length, open)}${body}`;
      }
    }
    i += 1;
  }
  throw new Error(`方法 ${name} 花括号不配对`);
}

const methodNames = ["_cleanSelectedRooms", "_askConfirm", "_resolveConfirm", "_setPendingClean", "_setAgentMode"];
const methods = Object.fromEntries(
  methodNames.map((name) => [name, extractMethod(name)]),
);

// 定时器 mock：既能断言"超时兜底"存在，也能手动触发它
const timers = [];
const cleared = [];
globalThis.window = {
  setTimeout: (fn, ms) => {
    timers.push({ fn, ms });
    return timers.length;
  },
  clearTimeout: (id) => cleared.push(id),
};

function makeContext({
  state = "docked",
  rooms = [9, 11],
  selected = [],
  fail = false,
  hang = false,
  agent = false,
} = {}) {
  const toasts = [];
  const calls = [];
  let release;
  let currentState = state; // 可变：模拟实体状态上报延迟/更新
  const ctx = {
    _hass: {
      states: {
        get "vacuum.t90"() {
          return { state: currentState };
        },
        "image.t90_map": { attributes: { rooms } },
      },
      callService: async (domain, service, data) => {
        calls.push({ domain, service, data });
        if (fail) throw new Error("boom");
        if (hang) await new Promise((r) => (release = r));
      },
    },
    _config: { vacuum_entity: "vacuum.t90", image_entity: "image.t90_map" },
    _selectedRooms: new Map(selected.map((id) => [id, `房间${id}`])),
    _params: { agent, mode: "", suction: "", water: null, efficiency: "", passes: 1 },
    _cleaning: false,
    _stopping: false,
    _pendingClean: false,
    _pendingGuard: null,
    _selectionLocked: state === "cleaning" || state === "paused",
    _cleanGuard: null,
    _confirmResolve: null,
    _refreshed: 0,
    _startButton: {
      _scope: { textContent: "" },
      style: { display: "" },
      disabled: false,
      querySelector: (sel) => (sel === ".start-scope" ? ctx._startButton._scope : null),
    },
    _confirmBox: {
      style: { display: "none" },
      querySelector: () => ({ textContent: "" }),
    },
    _vacuumState: () => currentState,
    _setState: (s) => {
      currentState = s;
    },
    _orderedRoomIds: () => [...rooms],
    _cleanParams: () => ({ suction: "max" }),
    _describeParams: (p) => `吸力=${p.suction}`,
    _setCommandStatus: (msg, isError = false, isSuccess = false) =>
      toasts.push({ msg, isError, isSuccess }),
    _applySelection: () => {},
    _syncParamUI: () => {},
    _updateVacuumState: () => {},
    _syncRunState: () => {
      const s = ctx._vacuumState();
      // 与真实实现一致：状态确认清扫/暂停时解除乐观锁定
      if (ctx._pendingClean && (s === "cleaning" || s === "paused")) {
        ctx._setPendingClean(false);
      }
      ctx._selectionLocked = s === "cleaning" || s === "paused" || ctx._pendingClean;
    },
    _refreshMap: () => {
      ctx._refreshed += 1;
    },
  };
  for (const [name, body] of Object.entries(methods)) {
    // eslint-disable-next-line no-new-func
    ctx[name] = new Function(`return (${body});`)();
  }
  return { ctx, toasts, calls, release: () => release?.() };
}

/** 触发一次点击，并自动回应卡片内确认框。 */
async function click(ctx, answer) {
  const promise = ctx._cleanSelectedRooms();
  await new Promise((r) => setImmediate(r));
  if (ctx._confirmResolve) ctx._resolveConfirm(answer);
  await promise;
}

let failed = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
  if (!cond) failed += 1;
};

// 1) 全屋 + 确认
{
  const { ctx, toasts, calls } = makeContext();
  await click(ctx, true);
  const sent = calls[0];
  check("全屋清扫：确认后下发命令", calls.length === 1);
  check("使用 vacuum.send_command + spot_area",
    sent?.domain === "vacuum" && sent?.service === "send_command" && sent?.data.command === "spot_area");
  check("全屋房间列表来自设备房间表", JSON.stringify(sent?.data.params.rooms) === "[9,11]");
  check("参数透传", sent?.data.params.suction === "max");
  check("成功后给出提示", toasts.at(-1)?.isSuccess === true);
  check("结束后解除 _cleaning", ctx._cleaning === false);
}

// 2) 确认框取消：不下发
{
  const { ctx, toasts, calls } = makeContext();
  await click(ctx, false);
  check("取消确认：不下发命令", calls.length === 0);
  check("取消确认：提示已取消", toasts.at(-1)?.msg === "已取消启动");
}

// 3) 清扫中：明确提示而不是静默
{
  const { ctx, toasts, calls } = makeContext({ state: "cleaning" });
  await click(ctx, true);
  check("清扫中：不下发命令", calls.length === 0);
  check("清扫中：给出可见提示", Boolean(toasts.at(-1)?.isError));
}

// 4) 上一条命令未结束
{
  const { ctx, toasts } = makeContext();
  ctx._cleaning = true;
  await click(ctx, true);
  check("发送中再次点击：给出可见提示", toasts.at(-1)?.isError === true);
}

// 5) 无房间：提示 + 触发刷新地图
{
  const { ctx, toasts } = makeContext({ rooms: [], selected: [] });
  await click(ctx, true);
  check("无房间：给出可见提示", toasts.at(-1)?.isError === true);
  check("无房间：自动刷新地图", ctx._refreshed === 1);
}

// 6) 服务调用失败：错误提示 + 解锁
{
  const { ctx, toasts } = makeContext({ fail: true });
  await click(ctx, true);
  check("调用失败：错误提示", toasts.at(-1)?.msg.includes("清扫命令发送失败"));
  check("调用失败：解除 _cleaning", ctx._cleaning === false);
}

// 7) 兜底超时解锁：命令卡住时 20 秒后自动解锁
{
  timers.length = 0;
  const { ctx, toasts, release: releaseHang } = makeContext({ hang: true });
  const promise = ctx._cleanSelectedRooms();
  await new Promise((r) => setImmediate(r));
  ctx._resolveConfirm(true);
  await new Promise((r) => setImmediate(r));
  check("命令卡住时设置了 20s 兜底计时器", timers.length === 1 && timers[0].ms === 20000);
  check("此时仍处于发送中（按钮未解锁）", ctx._cleaning === true);
  timers[0].fn();
  check("兜底触发：解锁并提示超时", ctx._cleaning === false && toasts.at(-1)?.msg.includes("超时"));
  releaseHang();
  await promise;
}

// 8) 发送成功后的乐观锁定：状态上报延迟期间不可重复启动
{
  timers.length = 0;
  const { ctx, calls } = makeContext();
  await click(ctx, true);
  check("发送成功后进入乐观锁定", ctx._pendingClean === true);
  check("乐观锁定期间选区已锁定", ctx._selectionLocked === true);
  const first = calls.length;
  await click(ctx, true);
  check("锁定期间再次点击：不下发第二条命令", calls.length === first);
}

// 9) 实体状态确认为清扫：乐观锁定自动解除，交给真实状态接管
{
  timers.length = 0;
  const { ctx } = makeContext();
  await click(ctx, true);
  check("前置：处于乐观锁定", ctx._pendingClean === true);
  ctx._setState("cleaning");
  ctx._syncRunState();
  check("状态变为清扫中：乐观锁定解除", ctx._pendingClean === false);
  check("状态变为清扫中：选区仍锁定", ctx._selectionLocked === true);
}

// 10) 乐观锁定 90 秒兜底：机器人始终未开始时自动解锁并提示
{
  timers.length = 0;
  const { ctx, toasts } = makeContext();
  await click(ctx, true);
  const guard = timers.find((t) => t.ms === 90000);
  check("设置了 90s 乐观锁定兜底计时器", Boolean(guard));
  guard.fn();
  check("兜底触发：乐观锁定解除", ctx._pendingClean === false);
  check("兜底触发：给出超时提示", toasts.at(-1)?.msg.includes("仍未开始清扫"));
}

// 11) AI 智能托管全屋：走 agent_clean 通道，不下发手动参数
{
  const { ctx, toasts, calls } = makeContext({ agent: true });
  await click(ctx, true);
  const sent = calls[0];
  check("AI 托管全屋：使用 agent_clean 命令",
    sent?.data.command === "agent_clean" && sent?.data.params.enable === true);
  check("AI 托管全屋：start:true（真正触发启动）", sent?.data.params.start === true);
  check("AI 托管全屋：rooms 为空（走 Clean START）",
    Array.isArray(sent?.data.params.rooms) && sent.data.params.rooms.length === 0);
  check("AI 托管全屋：成功提示 + 单次下发", toasts.at(-1)?.isSuccess === true && calls.length === 1);
  check("AI 托管全屋：成功后乐观锁定", ctx._pendingClean === true);
}

// 12) AI 智能托管 + 选区（与 App 智能体模式一致）：仍走 agent_clean，仅带房间 ID
{
  const { ctx, calls } = makeContext({ agent: true, selected: [9] });
  await click(ctx, true);
  const sent = calls[0];
  check("AI 托管选区：走 agent_clean 且带所选房间",
    sent?.data.command === "agent_clean"
    && JSON.stringify(sent?.data.params.rooms) === "[9]"
    && sent?.data.params.enable === true);
  check("AI 托管选区：不下发手动参数", sent?.data.params.suction === undefined);
}

// 13) 切换托管开关：仅切开关（agent_clean 不带 start），绝不启动清扫
{
  const { ctx, calls } = makeContext();
  await ctx._setAgentMode(true);
  const sent = calls[0];
  check("切换开关：下发 agent_clean enable:true", sent?.data.command === "agent_clean" && sent?.data.params.enable === true);
  check("切换开关：不带 start（后端不会启动清扫）", sent?.data.params.start === undefined);
  check("切换开关：本地状态已更新", ctx._params.agent === true);
  const { ctx: ctx2, calls: calls2 } = makeContext();
  await ctx2._setAgentMode(false);
  check("关闭开关：enable:false", calls2[0]?.data.params.enable === false);
}

console.log(failed === 0 ? "\n全部用例通过" : `\n${failed} 个用例失败`);
process.exit(failed === 0 ? 0 : 1);
