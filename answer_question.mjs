#!/usr/bin/env node
/**
 * answer_question.mjs
 *
 * 在已登录的「易智教云课堂」(csgmooc) 上回答指定题目。
 * 全程走站点自己的接口（saveQuestionRecord），不用鼠标点选项，也不用交卷。
 *
 * 前置条件：Chrome 以 --remote-debugging-port=9222 启动，且某个标签页已登录 csgmooc。
 *
 * 用法：
 *   node answer_question.mjs --list
 *   node answer_question.mjs --task 0 --question 1 --answer A
 *   node answer_question.mjs --task 0 --question 1 --answer A --dry-run
 *   node answer_question.mjs --task 0 --question 1 --answer A --shot out.png
 */

import { createRequire } from "node:module";
import { moduleDirs } from "./runtime.mjs";

const CDP_ENDPOINT = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
const TASK_PAGE = "https://www.csgmooc.com/spoc/html/stud_task.html";
const SITE_ORIGIN = "https://www.csgmooc.com";
// 任务页(stud_task.html)没有 window.CONFIG，答题页(spoc4)才有；两者指向同一个网关
const API_BASE = "https://www.csgmooc.com/uni-gateway/jxapi2/";

function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE_DIR,
    ...moduleDirs(),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      return createRequire("file:///" + dir.replace(/\\/g, "/"))("playwright");
    } catch {
      /* 试下一个位置 */
    }
  }
  return createRequire(import.meta.url)("playwright");
}

function parseArgs(argv) {
  const out = { task: 0, question: 1, answer: null, dryRun: false, list: false, shot: null };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--task": out.task = Number(argv[++i]); break;
      case "--question": out.question = Number(argv[++i]); break;
      case "--answer": out.answer = String(argv[++i]).toUpperCase(); break;
      case "--dry-run": out.dryRun = true; break;
      case "--list": out.list = true; break;
      case "--shot": out.shot = argv[++i]; break;
      default: throw new Error("未知参数：" + argv[i]);
    }
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 任务列表：直接读任务卡上的属性，和站点自己用的数据同源。 */
async function readTaskCards(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("li.contentLi")).map((li, i) => ({
      index: i,
      tmid: li.getAttribute("tmid"),
      tcid: li.getAttribute("tcid"),
      sclassid: li.getAttribute("sclassid"),
      submitId: li.getAttribute("tm_subid"),
      tm_name: (li.querySelector(".tm_name") || {}).textContent ? li.querySelector(".tm_name").textContent.trim() : "",
      title: li.querySelector(".title2") ? li.querySelector(".title2").getAttribute("title") : "",
    })),
  );
}

/** 已作答状态：questionId 顺序即题号顺序。 */
async function readAnswers(page, arg) {
  return page.evaluate(async (a) => {
    const base = (window.CONFIG && window.CONFIG.apiCourseUrl) || "https://www.csgmooc.com/uni-gateway/jxapi2/";
    const token = sessionStorage.getItem("reslibAuthtoken") || "";
    const res = await fetch(base + "student/testquiz/v1/getStuTestQuizAnswer", {
      method: "POST",
      headers: { authtoken: token, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ stuClassId: a.stuClassId, submitId: a.submitId, tmid: a.tmid }).toString(),
    });
    const body = await res.json();
    return body.data || [];
  }, arg);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { chromium } = loadPlaywright();
  const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  const ctx = browser.contexts()[0];
  let page = ctx.pages().find((p) => p.url().startsWith(SITE_ORIGIN));
  if (!page) page = await ctx.newPage();

  await page.goto(TASK_PAGE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("li.contentLi", { timeout: 30000 });
  await sleep(1500);

  if (page.url().includes("login-error")) {
    throw new Error("登录态已失效：请先在浏览器里重新登录 csgmooc。");
  }

  const cards = await readTaskCards(page);
  console.log("共 " + cards.length + " 个任务：");
  cards.forEach((c) => console.log("  [" + c.index + "] " + c.tm_name + "  " + c.title + "  tmid=" + c.tmid + " sclassid=" + c.sclassid + " submitId=" + c.submitId));
  if (args.list) return;

  const target = cards[args.task];
  if (!target) throw new Error("--task " + args.task + " 不存在（共 " + cards.length + " 个）");

  const before = await readAnswers(page, { tmid: target.tmid, stuClassId: target.sclassid, submitId: target.submitId });
  const q = before[args.question - 1];
  if (!q) throw new Error("--question " + args.question + " 超出范围（共 " + before.length + " 题）");
  console.log("");
  console.log("目标：任务[" + target.index + "] " + target.tm_name + "｜第 " + args.question + " 题 questionId=" + q.questionId);
  console.log("作答前：" + before.map((a, i) => (i + 1) + ":" + (a.answerStr || "-")).join(" "));

  if (!args.answer) {
    console.log("");
    console.log("未指定 --answer，仅查询。");
    return;
  }
  if (args.dryRun) {
    console.log("");
    console.log("dry-run：本应写入第 " + args.question + " 题 = " + args.answer);
    return;
  }

  const result = await page.evaluate(async (a) => {
    const base = (window.CONFIG && window.CONFIG.apiCourseUrl) || "https://www.csgmooc.com/uni-gateway/jxapi2/";
    const token = sessionStorage.getItem("reslibAuthtoken") || "";
    const saved = await fetch(base + "student/testquiz/v1/saveQuestionRecord", {
      method: "POST",
      headers: { authtoken: token, "Content-Type": "application/json" },
      body: JSON.stringify({
        answerStr: a.answer,
        needAnalysis: 0,
        questionId: a.questionId,
        stuClassId: a.stuClassId,
        submitId: a.submitId,
        tmid: a.tmid,
        files: null,
        gradeId: null,
        isActiveRepulse: 0,
      }),
    }).then((r) => r.json());
    const after = await fetch(base + "student/testquiz/v1/getStuTestQuizAnswer", {
      method: "POST",
      headers: { authtoken: token, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ stuClassId: a.stuClassId, submitId: a.submitId, tmid: a.tmid }).toString(),
    }).then((r) => r.json());
    return { saved: saved, after: after.data || [] };
  }, { tmid: target.tmid, stuClassId: target.sclassid, submitId: target.submitId, questionId: q.questionId, answer: args.answer });

  const flag = result.saved && result.saved.data ? result.saved.data.flag : undefined;
  console.log("");
  console.log("保存结果：flag=" + flag + (flag === 1 ? "（成功）" : "（失败：" + (result.saved && result.saved.message) + "）"));
  console.log("作答后：" + result.after.map((a, i) => (i + 1) + ":" + (a.answerStr || "-")).join(" "));

  // 打开答题页，让界面与服务器状态同步，并留下可核对的截图
  await page.goto(TASK_PAGE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("li.contentLi", { timeout: 30000 });
  await page.locator("li.contentLi").nth(target.index).click();
  await page.waitForSelector("#single-choice, .question-content", { timeout: 60000 });
  await sleep(3000);
  if (args.shot) {
    await page.screenshot({ path: args.shot });
    console.log("截图已保存：" + args.shot);
  }

}

// 结束时只断开 CDP 连接、不关闭 Chrome
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("失败：" + (e && e.message ? e.message : e));
    process.exit(1);
  });
