/**
 * 从卡片源码里抽取 startDrag 真实实现，用 mock DOM 跑拖拽排序仿真。
 * 目的：验证 insertBefore/矩形命中/落点计算是否真能把行排到预期位置。
 */
import { readFileSync } from "node:fs";

const FILE =
  "/Users/summer/WorkBuddy/2026-09-12-12-40-20/ecovacs-deebot-ha/custom_components/ecovacs_deebot/frontend/t90-modern-map-card.js";
const src = readFileSync(FILE, "utf8");

const startIdx = src.indexOf("const liveList = () =>");
const endMarker = "// 触屏/手写笔：只能从手柄起拖";
const endIdx = src.indexOf(endMarker);
if (startIdx < 0 || endIdx < 0) throw new Error("抽取失败");
let snippet = src.slice(startIdx, endIdx);
// 把 this. 换成 host.（new Function 里没有实例 this）
snippet = snippet.replace(/\bthis\./g, "host.");

const rects = new WeakMap();

class El {
  constructor(id) {
    this.id = String(id);
    this.children = [];
    this.parent = null;
    this.dataset = { roomId: String(id) };
    this.classList = {
      _s: new Set(),
      add: (c) => this.classList._s.add(c),
      remove: (c) => this.classList._s.delete(c),
    };
  }
  append(child) {
    if (child.parent) child.parent._remove(child);
    child.parent = this;
    this.children.push(child);
    return child;
  }
  _remove(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parent = null;
  }
  insertBefore(node, ref) {
    if (ref === null || ref === undefined) return this.append(node);
    if (node === ref) return node;
    if (node.parent) node.parent._remove(node);
    const i = this.children.indexOf(ref);
    node.parent = this;
    this.children.splice(i, 0, node);
    return node;
  }
  get nextElementSibling() {
    if (!this.parent) return null;
    const i = this.parent.children.indexOf(this);
    return this.parent.children[i + 1] || null;
  }
  querySelectorAll() {
    return [...this.children];
  }
  getBoundingClientRect() {
    return rects.get(this) || { top: 0, bottom: 0, height: 0 };
  }
}

function layout(list, rowHeight = 26, gap = 6, originTop = 100) {
  list.children.forEach((row, i) => {
    const top = originTop + i * (rowHeight + gap);
    rects.set(row, { top, bottom: top + rowHeight, height: rowHeight });
  });
}

const created = () => [];
const windowMock = {
  addEventListener: (t, fn) => created().push([t, fn]),
  removeEventListener: () => {},
};

// 收集 window 上的监听器
const listeners = [];
windowMock.addEventListener = (type, fn) => listeners.push([type, fn]);
windowMock.removeEventListener = (type, fn) => {
  const i = listeners.findIndex(([t, f]) => t === type && f === fn);
  if (i >= 0) listeners.splice(i, 1);
};

function makeEditor(orderIds) {
  const list = new El("list");
  const rows = orderIds.map((id) => new El(id));
  rows.forEach((r) => list.append(r));
  layout(list);
  const host = {
    _config: { room_order: [] },
    _dragActive: false,
    _renderPending: false,
    _rendered: true,
    shadowRoot: { querySelector: (sel) => (sel === ".order-list" ? list : new El("x")) },
    _updateConfig: (key, value) => {
      host._config[key] = value;
    },
    _renderOrderList: () => {
      layout(list);
    },
  };
  return { list, rows, host };
}

function drag(host, row, fromY, toY) {
  listeners.length = 0;
  const build = new Function(
    "row",
    "list",
    "host",
    "window",
    `${snippet}\nreturn startDrag;`,
  );
  const list = host.shadowRoot.querySelector(".order-list");
  const startDrag = build(row, list, host, windowMock);
  startDrag({ pointerType: "mouse", button: 0, preventDefault() {}, stopPropagation() {} });
  const fire = (type, y) => {
    const hit = listeners.filter(([t]) => t === type);
    hit.forEach(([, fn]) => fn({ clientY: y }));
  };
  fire("pointermove", toY);
  fire("pointerup", 0);
  return host._config.room_order;
}

function assert(name, got, want) {
  const ok = got.join(",") === want.join(",");
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      got  = [${got}]\n      want = [${want}]`);
  if (!ok) process.exitCode = 1;
}

const IDS = [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

// 1) 把第 1 行拖到最下面
{
  const { list, rows, host } = makeEditor(IDS);
  layout(list);
  const lastBottom = list.children[list.children.length - 1].getBoundingClientRect().bottom;
  assert("首行拖到末尾", drag(host, rows[0], 0, lastBottom + 20), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0]);
}
// 2) 把最后一行拖到最上面
{
  const { list, rows, host } = makeEditor(IDS);
  layout(list);
  const firstTop = list.children[0].getBoundingClientRect().top;
  assert("末行拖到开头", drag(host, rows[10], 0, firstTop - 30), [11, 0, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
}
// 3) 拖到行间缝隙（6px gap）也应生效 —— 这条以前会毫无反应
{
  const { list, rows, host } = makeEditor(IDS);
  layout(list);
  const r2 = list.children[2].getBoundingClientRect();
  assert("拖到行间缝隙（命中第 3 行上半）", drag(host, rows[0], 0, r2.top - 3), [2, 0, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
}
// 4) 拖到第 4 行下半 → 应插到第 4 行之后
{
  const { list, rows, host } = makeEditor(IDS);
  layout(list);
  const r4 = list.children[4].getBoundingClientRect();
  assert("命中第 5 行下半（插入其下）", drag(host, rows[0], 0, r4.bottom - 2), [2, 3, 4, 5, 0, 6, 7, 8, 9, 10, 11]);
}
// 5) 原地不动 → 不应写入配置
{
  const { list, rows, host } = makeEditor(IDS);
  layout(list);
  const r0 = list.children[0].getBoundingClientRect();
  const got = drag(host, rows[0], 0, r0.top + 2);
  assert("原地不动不写配置", got, []);
}
