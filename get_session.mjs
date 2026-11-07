#!/usr/bin/env node
/**
 * get_session.mjs —— 取/刷新 csgmooc 登录态，写进项目 work 目录。
 *
 *   node scripts/get_session.mjs              # 需要时自己拉起浏览器，再抓登录态
 *   node scripts/get_session.mjs --headful    # 带界面启动（登录过期时人工登录一次）
 *   node scripts/get_session.mjs --no-launch  # 只用已在运行的浏览器（9222）
 *
 * 产出：
 *   work\session_storage.json  完整 sessionStorage（25 个键）→ 可注入到任意新浏览器
 *   work\session.json          authtoken / stuId / gid 等（供 Python 流水线直接调接口）
 */

import { createRequire } from "node:module";
import { moduleDirs } from "./runtime.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBrowser, PROJECT_ROOT } from "./browser.mjs";

const CDP_ENDPOINT = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
const TASK_PAGE = "https://www.csgmooc.com/spoc/html/stud_task.html";
const WORK = path.join(PROJECT_ROOT, "work");
const OUT_SESSION = path.join(WORK, "session.json");
const OUT_STORAGE = path.join(WORK, "session_storage.json");
const headful = process.argv.includes("--headful");
const noLaunch = process.argv.includes("--no-launch");

function loadPlaywright() {
  for (const dir of [process.env.PLAYWRIGHT_MODULE_DIR,].filter(Boolean)) {
    try { return createRequire("file:///" + dir.replace(/\\/g, "/"))("playwright"); } catch { /* next */ }
  }
  return createRequire(import.meta.url)("playwright");
}

if (!noLaunch) {
  const r = await ensureBrowser({ headless: !headful });
  console.log(r.launched ? "已由程序启动浏览器" : "复用已在运行的浏览器");
}

const { chromium } = loadPlaywright();
const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
const ctx = browser.contexts()[0];

// 新拉起的浏览器是干净配置：把上次存下的 sessionStorage 注入进去，就能直接恢复登录态
const savedStorage = fs.existsSync(OUT_STORAGE) ? JSON.parse(fs.readFileSync(OUT_STORAGE, "utf8")) : null;
if (savedStorage && Object.keys(savedStorage).length) {
  await ctx.addInitScript((data) => {
    try {
      for (const k of Object.keys(data)) {
        const v = data[k];
        if (v !== null && v !== undefined) sessionStorage.setItem(k, v);
      }
    } catch { /* 某些页面没有 sessionStorage 时忽略 */ }
  }, savedStorage);
  console.log(`已注入上次保存的 sessionStorage（${Object.keys(savedStorage).length} 项）`);
}

let page = ctx.pages().find((p) => p.url().startsWith("https://www.csgmooc.com")) || (await ctx.newPage());
await page.goto(TASK_PAGE, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);

const storage = await page.evaluate(() => {
  const out = {};
  for (let i = 0; i < sessionStorage.length; i += 1) {
    const k = sessionStorage.key(i);
    out[k] = sessionStorage.getItem(k);
  }
  return out;
});

const summary = {
  authtoken: storage.reslibAuthtoken || "",
  stuId: storage.stuId || "",
  gid: storage["indexpage:gid"] || "",
  loginName: storage.login_name || "",
  schoolNum: storage.schoolNum || "",
  apiBase: "https://www.csgmooc.com/uni-gateway/jxapi2/",
  loggedIn: Boolean(storage.reslibAuthtoken),
  refreshedAt: new Date().toISOString(),
};

fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(OUT_STORAGE, JSON.stringify(storage, null, 1));
fs.writeFileSync(OUT_SESSION, JSON.stringify(summary, null, 1));
console.log(`loggedIn=${summary.loggedIn} stuId=${summary.stuId} gid=${summary.gid} name=${summary.loginName}`);
console.log(`sessionStorage(${Object.keys(storage).length} 项) -> ${OUT_STORAGE}`);
console.log(`会话摘要 -> ${OUT_SESSION}`);
if (!summary.loggedIn) {
  console.log("登录态失效：用 --headful 启动后在该窗口里登录一次，再重跑本脚本。");
  process.exit(2);
}
process.exit(0);
