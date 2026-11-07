#!/usr/bin/env node
/**
 * finalize.mjs — 交卷（把整套答案提交给站点批阅），并把批改结果打印出来。
 *
 * 用法：node finalize.mjs --tmid 547940
 *       node finalize.mjs --task 0        # 按任务列表序号（注意：交卷后列表会变化）
 *
 * 说明：交卷是页面上的一次 UI 操作（按钮 + 二次确认），这里用 Playwright 完成；
 * 批改结果随后通过站点接口读回。
 */

import { createRequire } from "node:module";
import { moduleDirs } from "./runtime.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBrowser, PROJECT_ROOT } from "./browser.mjs";

const CDP_ENDPOINT = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
const TASK_PAGE = "https://www.csgmooc.com/spoc/html/stud_task.html";
const API_BASE = "https://www.csgmooc.com/uni-gateway/jxapi2/";

function loadPlaywright() {
  for (const dir of [process.env.PLAYWRIGHT_MODULE_DIR,].filter(Boolean)) {
    try { return createRequire("file:///" + dir.replace(/\\/g, "/"))("playwright"); } catch { /* next */ }
  }
  return createRequire(import.meta.url)("playwright");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const wantTmid = arg("--tmid", null);
const taskIndex = Number(arg("--task", "0"));
// 交卷需要浏览器：没起就由程序自己拉起，并注入已保存的登录态（sessionStorage）
await ensureBrowser({ headless: !process.argv.includes("--headful") });
const { chromium } = loadPlaywright();
const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
const ctx = browser.contexts()[0];
const storageFile = path.join(PROJECT_ROOT, "work", "session_storage.json");
if (fs.existsSync(storageFile)) {
  const saved = JSON.parse(fs.readFileSync(storageFile, "utf8"));
  if (Object.keys(saved).length) {
    await ctx.addInitScript((data) => {
      try {
        for (const k of Object.keys(data)) {
          const v = data[k];
          if (v !== null && v !== undefined) sessionStorage.setItem(k, v);
        }
      } catch { /* ignore */ }
    }, saved);
  }
}
let page = ctx.pages().find((p) => p.url().startsWith("https://www.csgmooc.com")) || (await ctx.newPage());
page.on("dialog", (d) => d.accept().catch(() => {}));

await page.goto(TASK_PAGE, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector("li.contentLi", { timeout: 30000 });
await sleep(1500);
// 交卷后任务会从列表里消失，所以优先按 tmid 定位；找不到再退回序号
const cards = await page.evaluate(() => Array.from(document.querySelectorAll("li.contentLi")).map((li, i) => ({
  i, tmid: li.getAttribute("tmid"), sclassid: li.getAttribute("sclassid"), submitId: li.getAttribute("tm_subid"),
})));
const card = wantTmid ? cards.find((c) => c.tmid === String(wantTmid)) : cards[taskIndex];
if (!card) throw new Error(`任务列表里没有 tmid=${wantTmid}（可能已经交卷了）`);
const index = card.i;

await page.locator("li.contentLi").nth(index).click();
await page.waitForSelector("#single-choice, .question-content", { timeout: 60000 });
await sleep(3000);
const answered = await page.evaluate(() => (document.querySelector(".answer-title") || {}).innerText || "");
console.log("交卷前答题卡：" + answered.replace(/\n/g, " "));

await page.locator("button:has-text('交卷')").first().click();
await sleep(1500);
const confirm = page.locator(".ep-message-box__btns button:has-text('确认')").first();
if (await confirm.count()) {
  await confirm.click();
} else {
  console.log("没有出现二次确认框，直接提交");
}
await page.waitForURL(/stud_task\.html/, { timeout: 60000 }).catch(() => {});
await sleep(4000);

const sheet = await page.evaluate(async (c) => {
  const token = sessionStorage.getItem("reslibAuthtoken") || "";
  const r = await fetch(`https://www.csgmooc.com/uni-gateway/jxapi2/student/testvalidatedetail/getanswersheetofstudent?tmid=${c.tmid}&sclassid=${c.sclassid}`,
    { headers: { authtoken: token } });
  const j = await r.json();
  const rows = (j.data?.answerSheetOfCards || []).flatMap((x) => x.answerOfCards || []);
  return { score: j.data?.task_score, rows: rows.map((a, i) => ({ no: i + 1, mine: a.tq_answer, right: a.is_right })) };
}, card);

console.log(`批改结果：${sheet.score} 分`);
sheet.rows.forEach((r) => console.log(`  第${r.no}题 ${r.mine} ${r.right === 1 ? "✓" : "×"}`));
process.exit(0);
