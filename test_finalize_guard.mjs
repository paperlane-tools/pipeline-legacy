#!/usr/bin/env node
/**
 * test_finalize_guard.mjs —— 用真实浏览器验证「交卷安全闸」：对一套没作答的卷子调用交卷，必须被拦下。
 *
 *   node scripts/test_finalize_guard.mjs --tmid 547945
 *
 * 只会"尝试"交卷，不会真的提交（安全闸会拦住）；同时也验证自检输出。
 */

import { createRequire } from "node:module";
import { moduleDirs } from "./runtime.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const tmid = String(arg("--tmid", "547945"));

function loadPlaywright() {
  for (const dir of [process.env.PLAYWRIGHT_MODULE_DIR,].filter(Boolean)) {
    try { return createRequire("file:///" + dir.replace(/\\/g, "/"))("playwright"); } catch { /* next */ }
  }
  return createRequire(import.meta.url)("playwright");
}

// 注意：这里必须真的发请求，不能是空实现——否则 await 永远不返回（上次脚本卡死就是踩了这个坑）
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
await sleep(2500);
await page.evaluate(() => {
  localStorage.setItem("yzj_apiKey", JSON.stringify("sk-test"));
  localStorage.setItem("yzj_confirmBeforeFinalize", "true");
});

const cards = await page.evaluate(() => Array.from(document.querySelectorAll("li.contentLi")).map((li, i) => ({
  i, tmid: li.getAttribute("tmid"), sclassid: li.getAttribute("sclassid"), submitId: li.getAttribute("tm_subid"),
  title: li.querySelector(".title2") ? li.querySelector(".title2").getAttribute("title") : "",
  name: li.querySelector(".tm_name") ? li.querySelector(".tm_name").textContent.trim() : "",
})));
console.log("当前任务：" + cards.map((c) => `${c.tmid}(${c.name})`).join(", "));
const info = cards.find((c) => c.tmid === tmid);
if (!info) throw new Error(`列表里没有 ${tmid}（可能已经交卷）`);

await page.locator("li.contentLi").nth(info.i).click();
await sleep(8000);
console.log(`\n--- 自检（${tmid}）---`);
await page.evaluate((inf) => window.__yzj.selfCheck(inf, 10), info);
await sleep(1500);
console.log("\n--- 尝试交卷（应被安全闸拦下）---");
const res = await page.evaluate(async (inf) => await window.__yzj.finalizeNow(inf, 10), info);
console.log("返回值：" + JSON.stringify(res));
console.log("当前 URL：" + page.url().slice(0, 90));

if (process.argv.includes("--write")) {
  console.log("\n--- 先让 AI 写答案，再验证「交卷前确认」弹窗 ---");
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8")).ai || {};
  await page.evaluate((k) => localStorage.setItem("yzj_apiKey", JSON.stringify(k)), cfg.api_key || "");
  const wrote = await page.evaluate(async (inf) => await window.__yzj.answerOne(inf), info);
  console.log("写入结果：" + JSON.stringify(wrote));
  const res2P = page.evaluate((inf) => window.__yzj.finalizeNow(inf, wrote.count), info);
  await sleep(6000);
  const hasDialog = await page.evaluate(() => !!document.querySelector(".yzj-mask .yzj-dialog"));
  console.log("出现确认弹窗：" + hasDialog);
  if (hasDialog) await page.locator('.yzj-mask [data-a="no"]').click();
  const res2 = await res2P;
  console.log("点「取消」后返回值：" + JSON.stringify(res2));
}
await ctx.close();
process.exit(0);
