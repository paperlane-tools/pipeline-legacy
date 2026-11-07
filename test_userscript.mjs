#!/usr/bin/env node
/**
 * test_userscript.mjs —— 在真实浏览器里验证油猴脚本（用 GM_* 的 shim 代替 Tampermonkey）
 *
 *   node scripts/test_userscript.mjs --task 0 --write     # 真写入答案（不交卷）
 *   node scripts/test_userscript.mjs --task 0            # 只看到 AI 判题预览
 *
 * 注意：跑之前请确保 9222 上有已登录的浏览器（node scripts/get_session.mjs 会拉起并恢复登录态）。
 */

import { createRequire } from "node:module";
import { moduleDirs } from "./runtime.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBrowser, PROJECT_ROOT } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);
const taskIndex = Number(arg("--task", "0"));
const doWrite = has("--write");

function loadPlaywright() {
  for (const dir of [process.env.PLAYWRIGHT_MODULE_DIR,].filter(Boolean)) {
    try { return createRequire("file:///" + dir.replace(/\\/g, "/"))("playwright"); } catch { /* next */ }
  }
  return createRequire(import.meta.url)("playwright");
}

const SHIM = `
(function () {
  const PREFIX = "yzj_";
  window.GM_getValue = (k, d) => { const v = localStorage.getItem(PREFIX + k); return v === null ? d : JSON.parse(v); };
  window.GM_setValue = (k, v) => { localStorage.setItem(PREFIX + k, JSON.stringify(v)); };
  window.GM_xmlhttpRequest = (o) => {
    fetch(o.url, { method: o.method || "GET", headers: o.headers || {}, body: o.data })
      .then(async (r) => { const t = await r.text(); o.onload && o.onload({ status: r.status, responseText: t }); })
      .catch((e) => o.onerror && o.onerror({ error: String(e) }));
  };
})();
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await ensureBrowser({ headless: true });
const { chromium } = loadPlaywright();
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const ctx = browser.contexts()[0];

// 注入登录态（等价于"用户本来就登录着"）
const ss = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "work", "session_storage.json"), "utf8"));
await ctx.addInitScript((data) => {
  try { for (const k of Object.keys(data)) { const v = data[k]; if (v != null) sessionStorage.setItem(k, v); } } catch { /* ignore */ }
}, ss);

const cfg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "config.json"), "utf8")).ai || {};

// 关键：像 Tampermonkey 一样，在「每个页面」都注入脚本（任务页 + 答题页都要生效）
const code = fs.readFileSync(path.join(PROJECT_ROOT, "quiz", "csgmooc-helper.user.js"), "utf8");
await ctx.addInitScript(SHIM + "\n" + code);

const page = await ctx.newPage();
page.on("console", (m) => { const t = m.text(); if (t.startsWith("[yzj]")) console.log("  " + t); });
page.on("dialog", (d) => { console.log("  [dialog] " + d.message()); d.accept().catch(() => {}); });

await page.goto("https://www.csgmooc.com/spoc/html/stud_task.html", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector("li.contentLi", { timeout: 30000 });
await sleep(1500);

// 把 API key / 模型塞进 GM 存储（模拟用户在设置面板里填过）
await page.evaluate(({ key, model }) => {
  localStorage.setItem("yzj_apiKey", JSON.stringify(key));
  localStorage.setItem("yzj_model", JSON.stringify(model || "deepseek-flash"));
}, { key: cfg.api_key || "", model: cfg.model });

await sleep(2500);

const cards = await page.evaluate(() => Array.from(document.querySelectorAll("li.contentLi")).map((li) => ({
  tmid: li.getAttribute("tmid"),
  name: li.querySelector(".tm_name")?.textContent?.trim(),
  hasButton: !!li.querySelector(".yzj-card"),
})));
console.log("任务卡片：" + JSON.stringify(cards));

const target = cards[taskIndex];
if (!target) throw new Error("没有这个任务序号");
console.log(`\n点击第 ${taskIndex} 个任务（${target.name} tmid=${target.tmid}）的「自动作答」…`);
await page.waitForSelector("li.contentLi .yzj-card", { timeout: 30000 });
await page.locator("li.contentLi .yzj-card").nth(taskIndex).click();

// 等预览弹窗
let preview = null;
for (let i = 0; i < 90; i += 1) {
  await sleep(1000);
  preview = await page.evaluate(() => {
    const box = document.querySelector(".yzj-mask .yzj-dialog");
    return box ? box.innerText : null;
  });
  if (preview) break;
}
console.log("\n=== AI 判题预览 ===\n" + (preview || "(没有出现预览，见上面的日志)"));

if (preview && doWrite) {
  const finalToo = has("--final");
  console.log(`\n点击「${finalToo ? "写入并交卷" : "写入答案"}」…`);
  await page.locator(`.yzj-mask [data-a="${finalToo ? "writeFinal" : "write"}"]`).click();
  await sleep(6000);
  const logs = await page.evaluate(() => document.querySelector(".yzj-log")?.innerText || "");
  console.log(logs);
}
process.exit(0);
