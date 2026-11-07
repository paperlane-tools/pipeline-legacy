#!/usr/bin/env node
/**
 * test_unattended.mjs —— 在真实浏览器里跑"无人值守"（用项目自己的 browser-profile + 注入登录态）
 *
 *   node scripts/test_unattended.mjs --max 1 --finalize     # 处理 1 套并交卷
 *   node scripts/test_unattended.mjs --max 2               # 只写答案，不交卷
 *
 * 会把 API Key 从 config.json 写进脚本的存储，模拟用户已配置好。
 */

import { createRequire } from "node:module";
import { moduleDirs } from "./runtime.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const maxTasks = Number(arg("--max", "1"));
const doFinalize = process.argv.includes("--finalize");
const totalTimeoutMs = Number(arg("--timeout", "360")) * 1000;

function loadPlaywright() {
  for (const dir of [process.env.PLAYWRIGHT_MODULE_DIR,].filter(Boolean)) {
    try { return createRequire("file:///" + dir.replace(/\\/g, "/"))("playwright"); } catch { /* next */ }
  }
  return createRequire(import.meta.url)("playwright");
}

const SHIM = `(function(){const P="yzj_";
window.GM_getValue=(k,d)=>{const v=localStorage.getItem(P+k);return v===null?d:JSON.parse(v);};
window.GM_setValue=(k,v)=>{localStorage.setItem(P+k,JSON.stringify(v));};
window.GM_xmlhttpRequest=(o)=>{
  const ctrl=new AbortController();
  const timer=setTimeout(()=>{ctrl.abort();o.ontimeout&&o.ontimeout();},(o.timeout||90000));
  fetch(o.url,{method:o.method||"GET",headers:o.headers||{},body:o.data,signal:ctrl.signal})
    .then(async r=>{clearTimeout(timer);const t=await r.text();o.onload&&o.onload({status:r.status,responseText:t});})
    .catch(e=>{clearTimeout(timer);o.onerror&&o.onerror({error:String(e)});});
  return {abort:()=>ctrl.abort()};
};})();`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { chromium } = loadPlaywright();
const profile = process.env.YZJ_BROWSER_PROFILE || path.join(ROOT, "browser-profile");
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true,
  executablePath: process.env.YZJ_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe",
  args: ["--no-first-run", "--no-default-browser-check"],
});
const ss = JSON.parse(fs.readFileSync(path.join(ROOT, "work", "session_storage.json"), "utf8"));
await ctx.addInitScript((d) => { try { for (const k of Object.keys(d)) sessionStorage.setItem(k, d[k]); } catch { /* ignore */ } }, ss);
const code = fs.readFileSync(path.join(ROOT, "quiz", "csgmooc-helper.user.js"), "utf8");
await ctx.addInitScript(SHIM + "\n" + code);

const page = ctx.pages()[0] ?? await ctx.newPage();
page.on("console", (m) => { const t = m.text(); if (t.startsWith("[yzj]")) console.log("  " + t); });
page.on("dialog", (d) => { console.log("  [dialog] " + d.message()); d.accept().catch(() => {}); });

await page.goto("https://www.csgmooc.com/spoc/html/stud_task.html", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector("li.contentLi", { timeout: 30000 });

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8")).ai || {};
await page.evaluate(({ key, model, max, fin }) => {
  localStorage.setItem("yzj_apiKey", JSON.stringify(key));
  localStorage.setItem("yzj_model", JSON.stringify(model));
  localStorage.setItem("yzj_unattended", "true");
  localStorage.setItem("yzj_uaFinalize", JSON.stringify(fin));
  localStorage.setItem("yzj_uaMaxTasks", JSON.stringify(max));
  localStorage.setItem("yzj_uaRetry", "2");
  localStorage.setItem("yzj_confirmBeforeFinalize", "true");   // 无人值守时应被忽略
  localStorage.removeItem("yzj_uaState");
}, { key: cfg.api_key || "", model: cfg.model || "deepseek-flash", max: maxTasks, fin: doFinalize });

console.log(`无人值守参数：最多 ${maxTasks} 套，自动交卷 = ${doFinalize}`);
// 触发脚本重新读取设置：刷新一次（脚本会在 boot() 里自动开始）
await page.reload({ waitUntil: "domcontentloaded" });

const deadline = Date.now() + totalTimeoutMs;
let last = null;
while (Date.now() < deadline) {
  await sleep(3000);
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem("yzj_uaState") || "null"));
  if (st && JSON.stringify(st) !== JSON.stringify(last)) {
    last = st;
    console.log(`  [状态] 完成 ${st.done.length}｜失败 ${st.failed.length}｜当前 ${st.current || "-"}｜active=${st.active}`
      + (Object.keys(st.scores || {}).length ? "｜成绩 " + JSON.stringify(st.scores) : ""));
  }
  if (st && !st.active) { console.log("无人值守已结束：" + (st.reason || "")); break; }
}
const finalState = await page.evaluate(() => JSON.parse(localStorage.getItem("yzj_uaState") || "null"));
console.log("\n最终状态：" + JSON.stringify(finalState, null, 1));
await ctx.close();
process.exit(0);
