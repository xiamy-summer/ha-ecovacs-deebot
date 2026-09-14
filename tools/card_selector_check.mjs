#!/usr/bin/env node
/**
 * 静态检查：卡片 JS 里 querySelector/querySelectorAll 用到的类名，
 * 是否真的出现在 HTML 模板（class="..."）或被 classList 动态添加。
 *
 * 为什么需要它：卡片的事件绑定是 `element.addEventListener(...)` 串行执行的，
 * 只要某个选择器失配（比如改了 HTML 类名却没改 JS），那一行就会抛异常，
 * 后面所有绑定（包括"启动"按钮）全部失效 —— 现象是"点了按钮毫无反应"，
 * 而 HA 日志里什么都不会出现。改完卡片跑一遍这个脚本，几秒钟就能排掉这类坑。
 *
 * 用法：node tools/card_selector_check.mjs [卡片文件路径]
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FILE =
  process.argv[2] ||
  resolve(here, "../custom_components/ecovacs_deebot/frontend/t90-modern-map-card.js");

const source = readFileSync(FILE, "utf8");

// 1) HTML 模板里静态出现的类名
const defined = new Set();
for (const match of source.matchAll(/class="([^"$]*?)"/g)) {
  for (const token of match[1].trim().split(/\s+/)) {
    if (token && !token.includes("$")) defined.add(token);
  }
}
// 2) classList 动态添加/切换的类名
for (const match of source.matchAll(
  /classList\.(?:add|remove|toggle|contains)\(([^)]*)\)/g,
)) {
  for (const token of match[1].matchAll(/["'`]([^"'`]+)["'`]/g)) {
    for (const cls of token[1].split(/\s+/)) if (cls) defined.add(cls);
  }
}
// 3) 模板里 classList 之外的动态类名（如 `class="seg ${x ? "active" : ""}"`）
for (const match of source.matchAll(/class="[^"]*\$\{([^}]*)\}[^"]*"/g)) {
  for (const token of match[1].matchAll(/["']([a-zA-Z][\w-]*)["']/g)) {
    defined.add(token[1]);
  }
}
// 3b) 命令式创建的节点：el.className = "order-row"
for (const match of source.matchAll(/\.className\s*=\s*["'`]([^"'`]+)["'`]/g)) {
  for (const token of match[1].trim().split(/\s+/)) if (token) defined.add(token);
}

// 4) 收集所有 querySelector 的简单类选择器
const used = new Map(); // class -> [lineNo]
const lines = source.split("\n");
lines.forEach((line, index) => {
  for (const match of line.matchAll(
    /querySelector(?:All)?\(\s*["'`]([^"'`]+)["'`]/g,
  )) {
    const selector = match[1];
    if (!selector.startsWith(".")) continue; // 只看类选择器
    if (/[\s>+~[\]()]/.test(selector.slice(1))) continue; // 复杂选择器跳过
    const cls = selector.slice(1);
    if (!cls) continue;
    if (!used.has(cls)) used.set(cls, []);
    used.get(cls).push(index + 1);
  }
});

const missing = [...used.entries()].filter(([cls]) => !defined.has(cls));

console.log(`检查文件: ${FILE}`);
console.log(`模板/动态定义类名: ${defined.size} 个，querySelector 引用: ${used.size} 个`);
if (missing.length === 0) {
  console.log("OK：所有选择器都能在模板中找到对应类名");
  process.exit(0);
}
console.error(`\n发现 ${missing.length} 个可能在模板中不存在的类名（会让该行之后的绑定全部失效）：`);
for (const [cls, lineNos] of missing) {
  console.error(`  .${cls}  ← 第 ${lineNos.join(", ")} 行`);
}
process.exit(1);
