#!/usr/bin/env node
/**
 * verify_live_readonly.mjs —— 真机「只读」验证 v1.4.0 的任务判定，绝不写账号。
 *
 * 做法：
 *   - 用真实登录态（work/chrome_session_storage.json）打开真实的任务列表页；
 *   - 注入真实插件脚本，但把「写答案 / 交卷 / 上传」这些接口在路由层全部 abort；
 *   - 调 askOnce 的 AI 通道换成计数器（本轮不该有任何调用，真调用会直接看出来）；
 *   - 对每张卡片跑 inspectTask，打印判定结果（ok / 跳过原因）。
 *
 *   node scripts/verify_live_readonly.mjs
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { moduleDirs } from "./runtime.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

function loadPlaywright() {
  for (const dir of [process.env.PLAYWRIGHT_MODULE_DIR, ...moduleDirs()].filter(Boolean)) {
    try { return createRequire("file:///" + dir.replace(/\\/g, "/"))("playwright"); } catch { /* next */ }
  }
  return createRequire(import.meta.url)("playwright");
}

const code = fs.readFileSync(path.join(ROOT, "quiz", "csgmooc-helper.user.js"), "utf8");
const storageFile = path.join(ROOT, "work", "chrome_session_storage.json");
const storage = JSON.parse(fs.readFileSync(storageFile, "utf8"));

const SHIM = `
(function () {
  const P = "yzl_";
  window.__live = { aiCalls: 0 };
  window.GM_getValue = (k, d) => { const v = localStorage.getItem(P + k); return v === null ? d : JSON.parse(v); };
  window.GM_setValue = (k, v) => { localStorage.setItem(P + k, JSON.stringify(v)); };
  window.GM_setClipboard = () => {};
  window.GM_xmlhttpRequest = (o) => {
    window.__live.aiCalls += 1;
    console.log("[live] 不该发生的 AI 调用:", String(o.url || "").slice(0, 60));
    setTimeout(() => o.onerror && o.onerror({ error: "blocked-in-readonly-verify" }), 5);
    return { abort() {} };
  };
})();
`;

const { chromium } = loadPlaywright();
const ctx = await chromium.launchPersistentContext(
  path.join(ROOT, "work", "profiles", "livetest"),
  {
    headless: true,
    executablePath: process.env.YZJ_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe",
    args: ["--no-first-run", "--no-default-browser-check"],
  });

// 登录态：站点把 authtoken 放在 sessionStorage 里
await ctx.addInitScript((data) => {
  try { for (const k of Object.keys(data)) if (data[k] != null) sessionStorage.setItem(k, data[k]); } catch { /* ignore */ }
}, storage);
await ctx.addInitScript(SHIM + "\n" + code);

const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("  [pageerror] " + String(e && e.message).slice(0, 120)));

// 只读保险：任何写账号的接口一律掐断
const WRITE_PAT = /(saveQuestionRecord|submitTestQuiz|sumbitTestPaper|subResult|submitTestQuestionFile|submithomeworkfile|updatePromptOrAnswer)/;
let blocked = 0;
await page.route("**/jxapi2/**", (route) => {
  const u = route.request().url();
  if (WRITE_PAT.test(u)) { blocked += 1; return route.abort(); }
  return route.continue();
});

await page.goto("https://www.csgmooc.com/spoc/html/stud_task.html", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__yzj && window.__live, null, { timeout: 30000 });
await page.waitForTimeout(1500);
await page.evaluate(() => {
  localStorage.setItem("yzl_apiKey", JSON.stringify("sk-readonly-verify"));
  localStorage.setItem("yzl_useBank", "false");
  localStorage.setItem("yzl_delayEnabled", "false");
  localStorage.setItem("yzl_unattended", "false");
});

let cards = [];
for (let i = 0; i < 30; i += 1) {
  cards = await page.evaluate(() => [...document.querySelectorAll("li.contentLi")].map((c) => window.__yzj.infoFromCard(c)));
  if (cards.length) break;
  await page.waitForTimeout(1000);
}
console.log(`任务卡片 ${cards.length} 张`);
if (!cards.length) {
  console.log("没读到卡片（登录态可能过期，或页面结构变了）");
  await ctx.close();
  process.exit(2);
}

const rows = [];
for (const info of cards) {
  const r = await page.evaluate(async (task) => {
    try {
      const insp = await window.__yzj.inspectTask(task);
      return { verdict: insp.verdict, kind: insp.kind, reason: insp.reason,
               types: (insp.questions || []).map((q) => q.type).join(","), n: (insp.ids || []).length };
    } catch (e) {
      return { verdict: "error", reason: e.message, name: e.name };
    }
  }, info);
  rows.push({ ...info, ...r });
}

console.log("\ntmid      题型          题数  判定 / 原因");
for (const r of rows) {
  const kind = r.verdict === "skip" ? `跳过(${r.kind || "skip"})`
    : (r.verdict === "ok" ? `可作答[${r.types || "-"}]` : "出错");
  console.log(`${String(r.tmid).padEnd(9)} ${kind.padEnd(14)} ${String(r.n || 0).padEnd(4)} ${r.reason || r.title || ""}`);
}

const ai = await page.evaluate(() => window.__live.aiCalls);
const tally = rows.reduce((m, r) => { const k = r.verdict === "skip" ? r.kind : r.verdict; m[k] = (m[k] || 0) + 1; return m; }, {});
console.log("\n汇总:", JSON.stringify(tally), " AI 调用:", ai, " 被掐断的写请求:", blocked);

// 看一套连线题的判定 + 实际发给 AI 的提示词（只读，不会调用 AI）
const lineInfo = cards.find((c) => String(c.tmid) === process.env.YZJ_LINE_TMID)
  || (await page.evaluate(async (list) => {
    for (const t of list) {
      const insp = await window.__yzj.inspectTask(t).catch(() => null);
      if (insp && insp.questions && insp.questions.some((q) => Number(q.type) === 6)) return t;
    }
    return null;
  }, cards));
if (lineInfo) {
  const prompt = await page.evaluate(async (task) => {
    const insp = await window.__yzj.inspectTask(task);
    return window.__yzj.buildTextPrompt(insp.questions, `${task.name} ${task.title}`, { offset: 0 });
  }, lineInfo);
  console.log(`\n===== 连线题 ${lineInfo.tmid} 的提示词（截前 1600 字）=====`);
  console.log(prompt.slice(0, 1600));
}
await ctx.close();
