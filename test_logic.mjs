#!/usr/bin/env node
/**
 * test_logic.mjs —— 离线逻辑测试（不访问 csgmooc 的真实接口，不写任何答案）
 *
 * 做法：在真实浏览器里注入脚本，但
 *   1) 文档本身用 route.fulfill 换成一个"同源但没有任何站点脚本"的页面 → 不会被站点脚本跳转打断；
 *   2) 站点接口（jxapi2）与 AI 接口（GM_xmlhttpRequest）全部换成桩；
 * 于是可以安全验证：分批判题、截断降级、选项范围校验、单实例锁、取消语义、延迟提交队列、日志攒批、XSS 转义。
 *
 *   node scripts/test_logic.mjs
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
const KEY = "sk-test-key-0000000000000000000000";

const SHIM = `
(function () {
  const P = "yzj_";
  const stats = { setCalls: 0, logWrites: 0, aiCalls: [], submitted: false, aiMode: "ok", aborted: 0,
                  paperMode: "ok", aiAnswerMode: "ok", qCount: 49,
                  homeworkDesc: "请把你的作业拍照上传", homeworkType: 4, subResult: null,
                  courseName: "光伏电池制造技术", className: "25级05班" };   // v1.4.7 来源标注用
  window.__stub = stats;
  window.GM_getValue = (k, d) => { const v = localStorage.getItem(P + k); return v === null ? d : JSON.parse(v); };
  window.GM_setValue = (k, v) => { stats.setCalls += 1; if (k === "logBuf") stats.logWrites += 1;
    localStorage.setItem(P + k, JSON.stringify(v)); };
  window.GM_setClipboard = (t) => { localStorage.setItem(P + "__clip", String(t)); };

  window.GM_xmlhttpRequest = (o) => {
    // v1.6.0：GET /models（检测模型）单独走一条，别混进 aiCalls 里
    if (String(o.method || "GET").toUpperCase() === "GET" && String(o.url || "").endsWith("/models")) {
      stats.modelCalls = (stats.modelCalls || 0) + 1;
      stats.lastModelUrl = o.url;
      stats.lastModelHeaders = o.headers || {};
      const payload = stats.modelList || { data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }] };
      setTimeout(() => o.onload && o.onload({ status: 200, responseText: JSON.stringify(payload) }), 5);
      return { abort() {} };
    }
    const body = JSON.parse(o.data || "{}");
    const prompt = (body.messages || []).map((m) => Array.isArray(m.content)
      ? m.content.filter((c) => c && c.type === "text").map((c) => c.text).join("\\n")
      : String(m.content)).join("\\n");
    // 真实 prompt 里的说法是「第 X 到第 Y 个空」/「本次从 X 到 Y」，这里统一抓数字区间
    const mm = prompt.match(/(\\d+)\\s*(?:到|–|-|~)\\s*(\\d+)/);
    const from = mm ? Number(mm[1]) : 1;
    const to = mm ? Number(mm[2]) : 0;
    const noReason = /不要写 why/.test(prompt);
    stats.aiCalls.push({ from, to, noReason, maxTokens: body.max_tokens, effort: body.reasoning_effort,
                         model: body.model });
    const ansOf = (i) => {
      if (stats.aiAnswerMode === "multi-messy") return "a,b,d";
      if (stats.aiAnswerMode === "blank") return "one#CSG#two#CSG#three";
      if (stats.aiAnswerMode === "blank-bad") return "one#CSG#two";
      if (stats.aiAnswerMode === "subject") return "LISTEN：监听中\\nESTABLISHED：已建立连接\\nTIME_WAIT：等待关闭";
      if (stats.aiAnswerMode === "line") return "1c#2a#3b";
      if (stats.aiAnswerMode === "line2") return "1b#2a";
      if (stats.aiAnswerMode === "line-bad") return "1C#2A";
      if (stats.aiAnswerMode === "line-wrong") return "1C#2A#3Q";
      if (stats.aiMode === "badletter" && i === 3) return "F";
      return "A";
    };

    if (stats.aiMode === "cancel") { setTimeout(() => o.onerror && o.onerror({ error: "已取消" }), 5); return { abort() {} }; }
    if (stats.aiMode === "429") {                 // v1.5.0：模拟撞限流
      setTimeout(() => o.onload && o.onload({ status: 429, responseText:
        JSON.stringify({ error: { message: "Rate limit reached for requests", type: "rate_limit" } }) }), 5);
      return { abort() {} };
    }
    if (stats.aiMode === "503") {                 // v1.5.0：模拟服务器繁忙
      setTimeout(() => o.onload && o.onload({ status: 503, responseText:
        JSON.stringify({ error: { message: "Server is overloaded", type: "server_error" } }) }), 5);
      return { abort() {} };
    }
    if (stats.aiMode === "401") {                 // v1.4.9：模拟 API Key 无效
      setTimeout(() => o.onload && o.onload({ status: 401, responseText: JSON.stringify({
        error: { message: "Authentication Fails, Your api key: ****0610 is invalid" } }) }), 5);
      return { abort() {} };
    }
    if (stats.aiMode === "slow") {                    // 模拟"请求还在飞"（用于测停止/中止）
      const t = setTimeout(() => o.onload && o.onload({ status: 200, responseText: "{}" }), 30000);
      return { abort() { clearTimeout(t); stats.aborted += 1; } };
    }
    let finish = "stop";
    if (stats.aiMode === "truncate-once" && stats.aiCalls.length === 1) finish = "length";
    if (stats.aiMode === "truncate-all") finish = "length";
    if (stats.aiMode === "truncate-first-batch" && from <= 10) finish = "length";
    const answers = [];
    for (let i = from; i <= to; i += 1) {
      const answer = ansOf(i);
      answers.push(noReason ? { no: i, answer } : { no: i, answer, confidence: 0.9, why: "<img src=x onerror=alert(1)>" });
    }
    const payload = { choices: [{ message: { content: JSON.stringify({ answers }) }, finish_reason: finish }],
                      usage: { total_tokens: 100 } };
    setTimeout(() => o.onload && o.onload({ status: 200, responseText: JSON.stringify(payload) }), 5);
    return { abort() {} };
  };

  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, init) => {
    const u = String(url);
    const j = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } });
    if (!u.includes("/jxapi2/")) return realFetch(url, init);   // 图片等真实请求照常走网络
    const single = () => (["ok", "rule", "line-nodesc", "line-nodesc-empty"].includes(stats.paperMode)
      ? stats.qCount : 1);
    const mkQ = (type, letters, desc) => ({
      sqid: 1000, q_type: type, q_desc: "<p>" + desc + "</p>",
      optionJsons: letters.map((L) => ({ number: L, option: "<p>opt " + L + "</p>" })),
    });
    if (u.includes("getStuTestQuizAnswer")) {
      if (stats.paperMode === "homework") return j({ code: 200, data: [] });
      return j({ code: 200, data: Array.from({ length: single() }, (_, i) => ({ questionId: 1000 + i })) });
    }
    if (u.includes("getHomeWork")) {
      return j({ errcode: 200, data: { q_type: stats.homeworkType, h_title: "课后任务", tqid: 83915,
        h_desc: "<p>" + stats.homeworkDesc + "</p>", h_prompt: "", optionList: stats.homeworkOptions || [] } });
    }
    if (u.includes("subResult")) {
      const h = (init && init.headers) || {};
      stats.subResult = { ctype: h["Content-Type"] || h["content-type"] || "", body: String((init && init.body) || "") };
      return j({ errcode: 200, errmsg: "SUCCESS", data: 1 });
    }
    if (u.includes("getResultOfStudent")) {
      return j({ errcode: 200, data: { memberAnswer: { sub_time: stats.subResult ? 1790000000000 : null } } });
    }
    if (u.includes("gettestpaperofimage")) return j({ errcode: 200, data: { attrlist: [] } });
    if (u.includes("getquestionsum")) {
      if (stats.paperMode === "multi") {
        return j({ errcode: 200, data: { questionList: [{ questions: [mkQ(1, ["A", "B", "C", "D"], "多选：以下哪些正确")] }] } });
      }
      if (stats.paperMode === "blank") {
        return j({ errcode: 200, data: { questionList: [{ questions: [mkQ(3, ["", "", ""], "填空：三个空")] }] } });
      }
      if (stats.paperMode === "judge") {
        return j({ errcode: 200, data: { questionList: [{ questions: [mkQ(2, ["A", "B"], "判断：这个说法对吗")] }] } });
      }
      if (stats.paperMode === "unsupported") {
        return j({ errcode: 200, data: { questionList: [{ questions: [mkQ(7, ["A", "B", "C"], "排序：请把顺序排好")] }] } });
      }
      if (stats.paperMode === "line") {
        return j({ errcode: 200, data: { questionList: [{ questions: [{ sqid: 1000, q_type: 6, q_desc: "<p>请把成语和含义连起来</p>",
          optionJsons: [
            { number: "1", option: "<p>拔苗助长</p>" }, { number: "2", option: "<p>塞翁失马</p>" }, { number: "3", option: "<p>野火烧不尽</p>" },
            { number: "A", option: "<p>实践的重要性</p>" }, { number: "B", option: "<p>事物是变化发展的</p>" }, { number: "C", option: "<p>做事要尊重客观规律</p>" },
          ] }] }] } });
      }
      // v1.6.2：连线题但题干为空（真实场景：内容全在左右两侧选项里）
      if (stats.paperMode === "line-nodesc") {
        return j({ errcode: 200, data: { questionList: [{ questions: Array.from({ length: single() }, (_, i) => ({
          sqid: 1000 + i, q_type: 6, q_desc: "",
          optionJsons: [
            { number: "1", option: "<p>拔苗助长</p>" }, { number: "2", option: "<p>塞翁失马</p>" }, { number: "3", option: "<p>野火烧不尽</p>" },
            { number: "A", option: "<p>实践的重要性</p>" }, { number: "B", option: "<p>事物是变化发展的</p>" }, { number: "C", option: "<p>做事要尊重客观规律</p>" },
          ] })) }] } });
      }
      // 真·空题：题干和选项都没有（应该继续跳过）
      if (stats.paperMode === "line-nodesc-empty") {
        return j({ errcode: 200, data: { questionList: [{ questions: Array.from({ length: single() }, (_, i) => ({
          sqid: 1000 + i, q_type: 6, q_desc: "", optionJsons: [] })) }] } });
      }
      return j({ errcode: 200, data: { questionList: [{ questions: Array.from({ length: single() }, (_, i) => ({
        sqid: 1000 + i, q_type: 0,
        q_desc: "<p>" + (stats.paperMode === "rule" ? "本节课你学会了什么" : "question " + (i + 1)) + "</p>",
        optionJsons: ["A", "B", "C", "D"].map((L) => ({ number: L, option: "<p>opt " + L + "</p>" })),
      })) }] } });
    }
    if (u.includes("saveQuestionRecord")) return j({ code: 200, data: { flag: 1 } });
    if (u.includes("gettaskmodule")) {                     // v1.4.7：课程/班级名从这里来
      return j({ errcode: 200, data: [{ taskModuleInfos: [
        { tmid: 999, tc_name: stats.courseName, tt_name: stats.className },
        { tmid: 901, tc_name: "另一个课程", tt_name: "25级06班" },
      ] }] });
    }
    if (u.includes("submitTestQuiz")) { stats.submitted = true; return j({ code: 200, data: 1 }); }
    if (u.includes("getanswersheetofstudent")) {
      const g = !!stats.submitted;
      return j({ errcode: 200, data: { task_score: g ? 100 : 0, correct_status: g ? 2 : 0,
        sub_time: g ? 1790000000000 : null,
        answerSheetOfCards: [{ answerOfCards: Array.from({ length: 49 }, () => ({
          tq_answer: "A", is_right: g ? 1 : null, tq_score: g ? 2 : 0 })) }] } });
    }
    return j({ errcode: 200, data: [] });
  };
})();
`;

const { chromium } = loadPlaywright();
setTimeout(() => { console.log("⏱ 超时退出（有步骤卡住）"); process.exit(2); }, 150000).unref?.();

const ctx = await chromium.launchPersistentContext(
  path.join(ROOT, "work", "logictest"),
  { headless: true, executablePath: process.env.YZJ_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe",
    args: ["--no-first-run", "--no-default-browser-check"] });
await ctx.addInitScript(SHIM + "\n" + code);

const page = await ctx.newPage();
// 用一个「同源但没有站点脚本」的页面跑全部测试：localStorage 可用，且不会被站点脚本跳转打断
await page.route("**/stud_task.html*", (route) => route.fulfill({
  status: 200,
  contentType: "text/html; charset=utf-8",
  body: "<!doctype html><html><head><meta charset='utf-8'><title>stub</title></head>"
      + "<body><ul id='teachtaskInfo'></ul></body></html>",
}));
await page.route("**/*.js", (route) => route.abort());
page.on("pageerror", (e) => console.log("  [pageerror] " + String(e && e.message).slice(0, 140)));

await page.goto("https://www.csgmooc.com/spoc/html/stud_task.html", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__yzj && window.__stub, null, { timeout: 30000 });
await page.waitForTimeout(500);
await page.evaluate(() => {
  localStorage.setItem("yzj_apiKey", JSON.stringify("sk-test-key-0000000000000000000000"));
  localStorage.setItem("yzj_model", JSON.stringify("deepseek-flash"));
  localStorage.removeItem("yzj_history");
  localStorage.removeItem("yzj_submitQueue");
  localStorage.removeItem("yzj_runLock");
  localStorage.removeItem("yzj_answerBank");   // 题库跨轮次持久，测试前先清空
  localStorage.setItem("yzj_useBank", "true");
  localStorage.setItem("yzj_bankLearn", "true");
});

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`);
};
const reset = (mode) => page.evaluate((m) => {
  const s = window.__stub;
  s.aiMode = m; s.aiCalls = []; s.submitted = false;
  s.paperMode = "ok"; s.aiAnswerMode = "ok"; s.qCount = 49;
  s.homeworkDesc = "请把你的作业拍照上传"; s.homeworkType = 4; s.subResult = null;
  s.homeworkOptions = [];
  localStorage.setItem("yzj_delayEnabled", "false");     // 默认不延迟；第 5 条用例会自己打开
}, mode);
const TASK = { tmid: "999", sclassid: "468270", tcid: "167189", ttid: "11341", submitId: "298275", name: "测试", title: "测试卷" };

// 1) S1 分批 + 全局题号对齐
await reset("ok");
let r1 = await page.evaluate(async (task) => {
  try {
    const j = await window.__yzj.judgeTask(task);
    return { count: j.count, keys: Object.keys(j.byNo).length, first: j.byNo[1], last: j.byNo[49],
             calls: window.__stub.aiCalls.map((c) => c.from + "-" + c.to) };
  } catch (e) { return { error: e.message, calls: window.__stub.aiCalls, tail: window.__yzj.logText().split("\n").slice(-6) }; }
}, TASK);
check("S1 49 题按 10 题分批", r1.calls && r1.calls.length === 5 && r1.calls[0] === "1-10" && r1.calls[4] === "41-49", JSON.stringify(r1.calls));
check("S1 结果按全局题号对齐", r1.count === 49 && r1.keys === 49 && r1.first === "A" && r1.last === "A", `count=${r1.count} err=${r1.error || ""}`);

// 2) v1.4.0 截断 → 阶梯加大预算（不再降级成「只要字母」，那条对推理模型无效）
await reset("truncate-once");
let r2 = await page.evaluate(async (task) => {
  try { await window.__yzj.judgeTask(task); } catch (e) { /* 若失败也把调用记录带回来 */ }
  return window.__stub.aiCalls.slice(0, 2)
    .map((c) => ({ r: c.from + "-" + c.to, noReason: c.noReason, mt: c.maxTokens, eff: c.effort }));
}, TASK);
check("S1 被截断后加大预算重试（effort 降为 low、格式不变）",
  r2.length >= 2 && r2[1].mt > r2[0].mt && r2[1].noReason === false && r2[1].eff === "low", JSON.stringify(r2));

// 3) S6 选项范围校验
await reset("badletter");
let r3 = await page.evaluate(async (task) => {
  try { await window.__yzj.judgeTask(task); return { threw: false }; } catch (e) { return { threw: true, msg: e.message }; }
}, TASK);
check("S6 越界字母被拦下（不写入）", r3.threw && /不在选项/.test(r3.msg || ""), (r3.msg || "").slice(0, 50));

// 4) S2 单实例锁
let r4 = await page.evaluate(() => {
  const y = window.__yzj;
  GM_setValue("runLock", { id: "someone-else", kind: "unattended", at: Date.now() });
  const blocked = y.acquireLock("batch");
  GM_setValue("runLock", null);
  const free = y.acquireLock("batch");
  y.releaseLock();
  return { blocked, free };
});
check("S2 已有流程在跑时拿不到锁", r4.blocked === false && r4.free === true, JSON.stringify(r4));

// 5) 延迟提交：只入队、不立刻交
let r5 = await page.evaluate(async (task) => {
  const y = window.__yzj;
  localStorage.setItem("yzj_delayEnabled", "true");
  localStorage.setItem("yzj_delaySubmitMin", "1");
  localStorage.setItem("yzj_delaySubmitMax", "1");
  const res = await y.deliverSubmit(task, 49);
  const q = y.submitQueueAll();
  return { res, queued: q.length, dueInMin: q[0] ? Math.round((q[0].dueAt - Date.now()) / 60000) : null };
}, TASK);
check("延迟提交：写完先进队列", r5.res.queued === true && r5.queued === 1, JSON.stringify({ dueInMin: r5.dueInMin }));

// 6) 到点自动交卷 + 出队 + 回填成绩
let r6 = await page.evaluate(async (task) => {
  const y = window.__yzj;
  y.histAdd({ at: Date.now(), tmid: "999", name: "测试", title: "测试卷", count: 49, answers: { 1: "A" }, tokens: 100, source: "测试", score: null });
  const before = y.histAll().length;
  const q = y.submitQueueAll();
  q[0].dueAt = Date.now() - 1000;
  GM_setValue("submitQueue", q);
  const done = await y.processSubmitQueue(true);
  return { before, done, left: y.submitQueueAll().length, hist: y.histAll().filter((h) => h.tmid === "999").map((h) => h.score) };
}, TASK);
check("到点自动交卷并出队、成绩写回历史", r6.done === 1 && r6.left === 0 && r6.hist.includes(100), JSON.stringify(r6));

// 7) S9 XSS 转义
let r7 = await page.evaluate(() => window.__yzj.esc('<img src=x onerror=alert(1)>'));
check("S9 模型文本进入页面前被转义", /&lt;img/.test(r7), r7.slice(0, 30));

// 8) S10 日志攒批
let r8 = await page.evaluate(async () => {
  window.__stub.logWrites = 0;
  for (let i = 0; i < 30; i += 1) window.__yzj.logLine("info", "压力测试 " + i);
  const before = window.__stub.logWrites;
  await new Promise((r) => setTimeout(r, 2500));
  return { before, after: window.__stub.logWrites };
});
check("S10 30 条日志只写 1 次存储", r8.after - r8.before <= 2, JSON.stringify(r8));

// 9) S4 取消 → CancelledError（区分"中断"和"失败"）
await reset("cancel");
let r9 = await page.evaluate(async (task) => {
  try { await window.__yzj.judgeTask(task); return { name: "(没抛错)" }; }
  catch (e) { return { name: e.name, msg: e.message }; }
}, TASK);
check("S4 取消被识别为「中断」而非失败", r9.name === "CancelledError", JSON.stringify(r9));

// 10) S4 无人值守收到取消 → 停止（不计失败）
await page.evaluate((task) => {
  GM_setValue("runLock", null);
  GM_setValue("uaState", { active: true, startedAt: Date.now(), done: [], failed: [], attempts: {}, scores: {}, log: [], current: null });
  document.querySelector("#teachtaskInfo").innerHTML =
    '<li class="contentLi" tmid="999" sclassid="468270" tcid="167189" ttid="11341" tm_subid="298275">'
    + '<div class="tm_name">测试</div><div class="title2" title="测试卷"></div></li>';
}, TASK);
let r10 = await page.evaluate(async () => {
  try {
    await window.__yzj.uaTick();
    const st = JSON.parse(localStorage.getItem("yzj_uaState") || "null");
    return { active: st && st.active, reason: st && st.reason, failed: st && st.failed.length };
  } catch (e) { return { err: String(e).slice(0, 80) }; }
});
check("S4 无人值守被取消后停止、失败数不增加",
  r10.active === false && /取消/.test(r10.reason || "") && r10.failed === 0, JSON.stringify(r10));

// 11) 锁：同一 owner + 同模式 → 可续租（页面刷新后不被自己拦）
let r11 = await page.evaluate(() => {
  const y = window.__yzj;
  GM_setValue("runLock", null);
  const first = y.acquireLock("unattended");            // 页面 A 拿到锁
  const renew = y.acquireLock("unattended");            // 页面 B（同一 owner）续租
  return { first, renew, owner: y.lockInfo() && y.lockInfo().kind };
});
check("锁：同模式续租成功（刷新后不拦自己）", r11.first === true && r11.renew === true && r11.owner === "unattended", JSON.stringify(r11));

// 12) 锁：同一 owner + 不同模式 → 拒绝（无人值守 vs 一键批量 防冲突）
let r12 = await page.evaluate(() => {
  const y = window.__yzj;
  GM_setValue("runLock", null);
  y.acquireLock("unattended");
  const batchBlocked = y.acquireLock("batch");
  const msg = y.lockBusyMessage();
  y.releaseLock();
  return { batchBlocked, msg };
});
check("锁：两个模式互斥（批量的被拦下）", r12.batchBlocked === false && /无人值守/.test(r12.msg), JSON.stringify(r12));

// 13) 锁：别的 owner（另一台机器/另一个浏览器）→ 拒绝
let r13 = await page.evaluate(() => {
  const y = window.__yzj;
  GM_setValue("runLock", { ownerId: "someone-else", kind: "unattended", at: Date.now() });
  const blocked = y.acquireLock("batch");
  GM_setValue("runLock", null);
  return { blocked };
});
check("锁：别的 owner 持锁时拒进", r13.blocked === false, JSON.stringify(r13));

// 14) 停止：在飞的请求被中止；旧的一轮不会"复活"继续写
let r14 = await page.evaluate(async (task) => {
  const y = window.__yzj;
  GM_setValue("runLock", null);
  GM_setValue("uaState", null);
  window.__stub.aborted = 0;
  window.__stub.aiMode = "slow";
  document.querySelector("#teachtaskInfo").innerHTML =
    '<li class="contentLi" tmid="999" sclassid="468270" tcid="167189" ttid="11341" tm_subid="298275">'
    + '<div class="tm_name">测试</div><div class="title2" title="测试卷"></div></li>';
  y.uaStart(false);
  await new Promise((r) => setTimeout(r, 1200));      // 让它发出请求（进入"飞着"的状态）
  const runId1 = JSON.parse(localStorage.getItem("yzj_uaState") || "{}").runId;
  y.uaStop("测试停止");                                // 等价于点"停止（全部）"
  await new Promise((r) => setTimeout(r, 800));
  const st = JSON.parse(localStorage.getItem("yzj_uaState") || "{}");
  return { runId1, aborted: window.__stub.aborted, active: st.active, runId: st.runId, lock: y.lockInfo() };
}, TASK);
check("停止：中止在飞请求 + 清掉本轮标识 + 释放锁",
  r14.aborted >= 1 && r14.active === false && r14.runId === null && r14.lock === null, JSON.stringify(r14));

// 15) 重新启动后，旧的一轮不会继续（runId 生效）
let r15 = await page.evaluate(async () => {
  const y = window.__yzj;
  window.__stub.aiMode = "slow";
  GM_setValue("runLock", null);
  y.uaStart(false);
  await new Promise((r) => setTimeout(r, 300));
  const id1 = JSON.parse(localStorage.getItem("yzj_uaState") || "{}").runId;
  y.uaStart(false);                                   // 立刻又启动一轮（模拟"停止→马上再启动"）
  await new Promise((r) => setTimeout(r, 300));
  const id2 = JSON.parse(localStorage.getItem("yzj_uaState") || "{}").runId;
  y.uaStop("测试结束");
  return { id1, id2, different: id1 !== id2 };
});
check("重启后 runId 变化（旧协程会自行退出）", r15.different === true, JSON.stringify(r15));

// 16) 题库命中 → 该题不再调用 AI（省 token）
await reset("ok");
let r16 = await page.evaluate(async (task) => {
  const y = window.__yzj;
  GM_setValue("answerBank", {});
  const q1 = { id: 1000, type: 0, desc: "question 1",
               options: ["A", "B", "C", "D"].map((L) => ({ letter: L, text: "opt " + L })) };
  const keys = y.bankKeys(task, q1, 1, null);
  keys.forEach((k) => y.bankPut(k, "D", "test"));
  window.__stub.aiCalls = [];
  const j = await y.judgeTask(task);
  return {
    q1: j.byNo[1], q1src: j.sourceByNo[1], q2src: j.sourceByNo[2], total: j.count,
    calls: window.__stub.aiCalls.length,
    firstFrom: window.__stub.aiCalls.length ? window.__stub.aiCalls[0].from : null,
    stats: y.bankStats(),
  };
}, TASK);
check("题库：命中的题直接作答、不再问 AI",
  r16.q1 === "D" && r16.q1src === "bank" && r16.q2src === "ai" && r16.calls === 5 && r16.firstFrom === 2,
  JSON.stringify(r16));

// 17) 图片哈希：同一张图两次一致；重压缩后 SHA 变、dHash 不变（兜底有效）
let r17 = await page.evaluate(async () => {
  const y = window.__yzj;
  const url = "https://www.csgmooc.com/NEW_RES/V3/20001/167189/78b6fc1f-8746-4259-9b1e-5de237898653.png";
  const blob = await (await fetch(url, { credentials: "include" })).blob();
  const a1 = await y.imageFingerprints(blob);
  const a2 = await y.imageFingerprints(blob);
  const bmpUrl = URL.createObjectURL(blob);
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = bmpUrl;
  });
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * 0.8);
  c.height = Math.round(img.height * 0.8);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  const blob2 = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.7));
  const b1 = await y.imageFingerprints(blob2);
  const dist = y.hammingHex(a1.dh, b1.dh);
  return { size: blob.size, a1, b1, dist, sameTwice: a1.sha === a2.sha, shaDiff: a1.sha !== b1.sha, dhClose: dist <= 8 };
});
check("图片哈希：同一文件两次一致", r17.sameTwice && !!r17.a1.sha, JSON.stringify(r17.a1));
check("图片哈希：重压缩后 SHA 变了、感知哈希仍在容差内（兜底有效）",
  r17.shaDiff && r17.dhClose,
  JSON.stringify({ sha1: r17.a1.sha, sha2: r17.b1.sha, dh1: r17.a1.dh, dh2: r17.b1.dh, dist: r17.dist }));

// 18) 题库导出 → 导入：文件带来源信息，导入报告显示新增/覆盖/跳过
await page.evaluate(() => {
  const y = window.__yzj;
  GM_setValue("answerBank", {});
  y.bankPut("qAAA", "B", "test");
  y.bankPut("qBBB", "C", "test");
  y.bankPut("qCCC", "D", "test");
  document.querySelectorAll(".yzj-mask").forEach((m) => m.remove());
  y.openBank();
});
const bankFile = path.join(ROOT, "work", "test-bank-export.json");
const dl2 = page.waitForEvent("download", { timeout: 20000 });
await page.locator('.yzj-dialog [data-a="exp"]').click();
await (await dl2).saveAs(bankFile);
const exported = JSON.parse(fs.readFileSync(bankFile, "utf8"));
check("题库导出：文件带上来源元信息（条数/账号/导出时间）",
  !!exported.__meta__ && exported.__meta__.count === 3 && "exportedAt" in exported.__meta__,
  JSON.stringify(exported.__meta__).slice(0, 120));

// 本机保留 1 条已有 + 1 条同 key（用于看"新增/覆盖"）
await page.evaluate(() => {
  const y = window.__yzj;
  GM_setValue("answerBank", { qLOCAL: { a: "A", at: Date.now(), src: "keep" }, qAAA: { a: "X", at: Date.now(), src: "old" } });
  document.querySelectorAll(".yzj-mask").forEach((m) => m.remove());
  y.openBank();
});
const fc3 = page.waitForEvent("filechooser", { timeout: 20000 });
await page.locator('.yzj-dialog [data-a="imp"]').click();
await (await fc3).setFiles(bankFile);
await page.waitForTimeout(1200);
// v1.3.2：导入前必须先确认（二次校验），确认后才出报告
const pre = await page.evaluate(() => {
  const d = [...document.querySelectorAll(".yzj-dialog")].pop();
  return { text: d ? d.innerText.replace(/\n+/g, " | ") : "", hasYes: !!(d && d.querySelector('[data-a="yes"]')) };
});
check("危险操作：导入前先给预览并要求确认",
  /确认导入题库/.test(pre.text) && /新增 2/.test(pre.text) && pre.hasYes,
  pre.text.slice(0, 100));
await page.locator('.yzj-dialog [data-a="yes"]').click();
await page.waitForTimeout(800);
const rep = await page.evaluate(() => {
  const y = window.__yzj;
  const boxes = [...document.querySelectorAll(".yzj-dialog")];
  const b = boxes[boxes.length - 1];
  return { text: b ? b.innerText.replace(/\n+/g, " | ") : "", bank: y.bankAll(), stats: y.bankStats() };
});
check("题库导入：报告显示来源条数/最后更新/账号",
  /来源题库/.test(rep.text) && /最后更新/.test(rep.text) && /3 条/.test(rep.text),
  rep.text.slice(0, 110));
check("题库导入：新增 2、覆盖 1、本机原有条目保留",
  /新增 2/.test(rep.text) && /覆盖同名 1/.test(rep.text)
    && rep.bank.qLOCAL && rep.bank.qLOCAL.a === "A" && rep.bank.qAAA.a === "B" && rep.stats.total === 4,
  JSON.stringify({ total: rep.stats.total, qAAA: rep.bank.qAAA && rep.bank.qAAA.a }));

// 19) 危险操作"输入文字才能确认"：清空题库
await page.evaluate(() => {
  const y = window.__yzj;
  GM_setValue("answerBank", { qX1: { a: "A", at: Date.now(), src: "t" }, qX2: { a: "B", at: Date.now(), src: "t" } });
  document.querySelectorAll(".yzj-mask").forEach((m) => m.remove());
  y.openBank();
});
await page.locator('.yzj-dialog [data-a="clear"]').click();
await page.waitForTimeout(400);
const c1 = await page.evaluate(() => {
  const d = [...document.querySelectorAll(".yzj-dialog")].pop();
  return { hasInput: !!d.querySelector("#yzj-typectx"), op: d.querySelector('[data-a="yes"]').style.opacity,
           text: d.innerText.replace(/\n+/g, " | ").slice(0, 90) };
});
await page.fill('.yzj-dialog #yzj-typectx', "清");
const c2 = await page.evaluate(() => [...document.querySelectorAll(".yzj-dialog")].pop().querySelector('[data-a="yes"]').style.opacity);
await page.fill('.yzj-dialog #yzj-typectx', "清空");
const c3 = await page.evaluate(() => [...document.querySelectorAll(".yzj-dialog")].pop().querySelector('[data-a="yes"]').style.opacity);
await page.locator('.yzj-dialog [data-a="yes"]').click();
await page.waitForTimeout(500);
const c4 = await page.evaluate(() => window.__yzj.bankStats().total);
check("危险操作：清空题库必须输入「清空」才可点（少了就点不动）",
  c1.hasInput && c1.op !== "1" && c2 !== "1" && c3 === "1" && c4 === 0,
  JSON.stringify({ op0: c1.op, afterWrong: c2, afterRight: c3, total: c4 }));

// ===================== v1.4.0：题型扩档 + 跳过规则 + 截断阶梯 =====================

// 20) 多选题：带分隔符/小写的回答归一化成站点口径（ABD）
await reset("ok");
let r20 = await page.evaluate(async (task) => {
  window.__stub.paperMode = "multi"; window.__stub.aiAnswerMode = "multi-messy"; window.__stub.aiCalls = [];
  try {
    const j = await window.__yzj.judgeTask({ ...task, homeworkid: "" });
    return { byNo: j.byNo, calls: window.__stub.aiCalls.length, incomplete: j.incomplete };
  } catch (e) { return { error: e.message }; }
}, TASK);
check("v1.4.0 多选：a,b,d 归一化为 ABD（不分隔、按选项顺序）",
  r20.byNo && r20.byNo[1] === "ABD" && r20.calls === 1, JSON.stringify(r20));

// 21) 填空题：各空按 #CSG# 拼接
let r21 = await page.evaluate(async (task) => {
  window.__stub.paperMode = "blank"; window.__stub.aiAnswerMode = "blank"; window.__stub.aiCalls = [];
  try { const j = await window.__yzj.judgeTask({ ...task, homeworkid: "" }); return { byNo: j.byNo }; }
  catch (e) { return { error: e.message }; }
}, TASK);
check("v1.4.0 填空：3 个空按 #CSG# 拼接",
  r21.byNo && r21.byNo[1] === "one#CSG#two#CSG#three", JSON.stringify(r21));

// 22) 填空题：段数与空数不符 → 拦下不写
let r22 = await page.evaluate(async (task) => {
  window.__stub.paperMode = "blank"; window.__stub.aiAnswerMode = "blank-bad";
  try { await window.__yzj.judgeTask({ ...task, homeworkid: "" }); return { threw: false }; }
  catch (e) { return { threw: true, msg: e.message }; }
}, TASK);
check("v1.4.0 填空：段数与空数不符被拦下", r22.threw && /3 个空/.test(r22.msg || ""), (r22.msg || "").slice(0, 60));

// 23) 判断题：按单字母处理
let r23 = await page.evaluate(async (task) => {
  window.__stub.paperMode = "judge"; window.__stub.aiAnswerMode = "ok"; window.__stub.aiCalls = [];
  try { const j = await window.__yzj.judgeTask({ ...task, homeworkid: "" }); return { byNo: j.byNo, calls: window.__stub.aiCalls.length }; }
  catch (e) { return { error: e.message }; }
}, TASK);
check("v1.4.0 判断：写入单个字母", r23.byNo && r23.byNo[1] === "A" && r23.calls === 1, JSON.stringify(r23));

// 24) 命中跳过规则 → 整套跳过、一次 AI 都不调
let r24 = await page.evaluate(async (task) => {
  window.__stub.paperMode = "rule"; window.__stub.aiCalls = [];
  try { await window.__yzj.judgeTask({ ...task, homeworkid: "" }); return { skipped: false, calls: window.__stub.aiCalls.length }; }
  catch (e) { return { skipped: e.name === "SkipError", reason: e.reason || e.message, calls: window.__stub.aiCalls.length }; }
}, TASK);
check("v1.4.0 命中跳过规则：整套跳过、不调 AI、不算失败",
  r24.skipped === true && r24.calls === 0 && /跳过规则/.test(r24.reason || ""), JSON.stringify(r24));

// 25) 作业简答题（v1.4.1）：能作答，正文转成富文本 HTML
await reset("ok");
let r25 = await page.evaluate(async (task) => {
  window.__stub.paperMode = "homework"; window.__stub.homeworkType = 4;
  window.__stub.homeworkDesc = "使用netstat侦测到的端口有哪几种常见状态，简要解释";
  window.__stub.aiAnswerMode = "subject"; window.__stub.aiCalls = [];
  try {
    const j = await window.__yzj.judgeTask({ ...task, homeworkid: "259985" });
    return { homework: j.homework, ans: j.byNo[1], calls: window.__stub.aiCalls.length,
             mt: window.__stub.aiCalls[0] && window.__stub.aiCalls[0].maxTokens };
  } catch (e) { return { error: e.message, name: e.name, calls: window.__stub.aiCalls.length }; }
}, TASK);
check("v1.4.1 作业简答题：作答并把正文转成富文本 HTML",
  r25.homework === true && /<p>LISTEN：监听中<\/p>/.test(r25.ans || "")
    && /<p>TIME_WAIT：等待关闭<\/p>/.test(r25.ans || "") && r25.calls === 1 && r25.mt >= 4000,
  JSON.stringify({ calls: r25.calls, mt: r25.mt, ans: String(r25.ans || "").slice(0, 50) }));

// 25c) 作业提交：走 subResult（form 编码 + 参数齐全），并回读确认
let r25c = await page.evaluate(async (task) => {
  const y = window.__yzj;
  window.__stub.subResult = null;
  const j = await y.judgeTask({ ...task, homeworkid: "259985" });
  const w = await y.writeTask({ ...task, homeworkid: "259985" }, j.questions, j.byNo);
  const sr = window.__stub.subResult || {};
  const params = new URLSearchParams(sr.body || "");
  return { ok: w.ok, confirmed: w.confirmed, ctype: sr.ctype,
           mId: params.get("mId"), refId: params.get("refId"), submitId: params.get("submitId"),
           scid: params.get("scid"), ttid: params.get("ttid"), fileIdJson: params.get("fileIdJson"),
           enc: params.get("subResult") || "" };
}, TASK);
check("v1.4.1 作业提交：form 编码 + 参数齐全 + 服务器已确认",
  r25c.ok === 1 && r25c.confirmed === true && /x-www-form-urlencoded/.test(r25c.ctype)
    && r25c.mId === "999" && r25c.refId === "468270" && r25c.submitId === "298275"
    && r25c.scid === "167189" && r25c.ttid === "11341" && r25c.fileIdJson === "[]"
    && !!r25c.enc && r25c.enc.length % 4 === 0,
  JSON.stringify({ ok: r25c.ok, confirmed: r25c.confirmed, ctype: r25c.ctype, len: (r25c.enc || "").length }));

// 25d) 加密口径：和站点 CryptoJS 的已知密文对拍
const desCheck = await page.evaluate(() => ({
  a: window.__yzj.DES.encryptBase64("a"),
  cn: window.__yzj.DES.encryptBase64("使用netstat侦测到的端口有哪几种常见状态，简要解释"),
}));
check("v1.4.1 DES 口径与站点 CryptoJS 逐字节一致",
  desCheck.a === "uxllTOG9Lhs="
    && desCheck.cn === "CeTPJk4D8UWjyGm94ynx1+zZ74kZWulIcumRL20PBu8xBb/t98bYYUZg6P8Lqp1bQEkb2TfI97MS9PWMQps02hhmRL2OpriK",
  JSON.stringify({ a: desCheck.a, cnLen: (desCheck.cn || "").length }));

// 25e) 作业里的连线题若读不到选项 → 整套跳过、不调 AI
let r25e = await page.evaluate(async (task) => {
  window.__stub.paperMode = "homework"; window.__stub.homeworkType = 6;
  window.__stub.homeworkDesc = "请把左右两边连起来"; window.__stub.homeworkOptions = []; window.__stub.aiCalls = [];
  try { await window.__yzj.judgeTask({ ...task, homeworkid: "1" }); return { skipped: false }; }
  catch (e) { return { skipped: e.name === "SkipError", reason: e.reason || e.message, calls: window.__stub.aiCalls.length }; }
}, TASK);
check("v1.4.3 作业连线题读不到选项时：整套跳过、不调 AI",
  r25e.skipped === true && r25e.calls === 0 && /读不到选项/.test(r25e.reason || ""), JSON.stringify(r25e));

// 25h) v1.4.3 作业连线题（有选项）→ 作答并提交
let r25h = await page.evaluate(async (task) => {
  const y = window.__yzj;
  window.__stub.paperMode = "homework"; window.__stub.homeworkType = 6;
  window.__stub.homeworkDesc = "请把成语和含义连起来";
  window.__stub.homeworkOptions = [
    { opNumber: "1", option: "<p>拔苗助长</p>" }, { opNumber: "2", option: "<p>塞翁失马</p>" },
    { opNumber: "A", option: "<p>实践的重要性</p>" }, { opNumber: "B", option: "<p>事物是变化发展的</p>" },
  ];
  window.__stub.aiAnswerMode = "line2"; window.__stub.aiCalls = []; window.__stub.subResult = null;
  const info = { ...task, homeworkid: "259985" };
  const j = await y.judgeTask(info);
  const w = await y.writeTask(info, j.questions, j.byNo);
  return { byNo: j.byNo, ok: w.ok, confirmed: w.confirmed, calls: window.__stub.aiCalls.length };
}, TASK);
check("v1.4.3 作业连线题：按 1A#2B 口径作答并提交",
  String(r25h.byNo && r25h.byNo[1] || "") === "1B#2A" && r25h.ok === 1 && r25h.confirmed === true,
  JSON.stringify(r25h));

// 25b) 作业且题干命中规则 → 优先报「命中跳过规则」（规则优先于作答）
let r25b = await page.evaluate(async (task) => {
  window.__stub.paperMode = "homework"; window.__stub.homeworkType = 4;
  window.__stub.homeworkDesc = "请将你的练习作业拍照上传"; window.__stub.aiCalls = [];
  try { await window.__yzj.judgeTask({ ...task, homeworkid: "259985" }); return { calls: window.__stub.aiCalls.length }; }
  catch (e) { return { reason: e.reason || e.message, calls: window.__stub.aiCalls.length }; }
}, TASK);
check("v1.4.1 作业命中规则：仍然整套跳过、不调 AI",
  /跳过规则/.test(r25b.reason || "") && r25b.calls === 0, JSON.stringify(r25b));

// 25f) v1.4.2：作业也遵守「延迟提交」——先排队不提交，到点再交
await reset("ok");
let r25f = await page.evaluate(async (task) => {
  const y = window.__yzj;
  localStorage.setItem("yzj_delayEnabled", "true");
  localStorage.setItem("yzj_delaySubmitMin", "1");
  localStorage.setItem("yzj_delaySubmitMax", "1");
  GM_setValue("submitQueue", []);
  window.__stub.paperMode = "homework"; window.__stub.homeworkType = 4;
  window.__stub.homeworkDesc = "什么是端口"; window.__stub.aiAnswerMode = "subject";
  window.__stub.subResult = null;
  const info = { ...task, homeworkid: "259985" };
  const j = await y.judgeTask(info);
  const w = await y.writeTask(info, j.questions, j.byNo);
  const queued = y.submitQueueAll();
  const early = window.__stub.subResult;                 // 应该还没提交
  queued[0].dueAt = Date.now() - 1000;                   // 手动到点
  GM_setValue("submitQueue", queued);
  const done = await y.processSubmitQueue(true);
  const sr = window.__stub.subResult || {};
  return { queued: w.queued, dueInMin: w.dueInMin, qLen: queued.length, early: !!early,
           done, left: y.submitQueueAll().length, submitted: !!sr.body, home: queued[0].homework };
}, TASK);
check("v1.4.2 作业延迟提交：写完先排队、到点才提交",
  r25f.queued === true && r25f.qLen === 1 && r25f.home === true && r25f.early === false
    && r25f.done === 1 && r25f.left === 0 && r25f.submitted === true,
  JSON.stringify({ ...r25f }));
await page.evaluate(() => localStorage.setItem("yzj_delayEnabled", "false"));

// 25g) v1.4.2：无人值守遇到"已提交过的作业"直接跳过、不重复交
await reset("ok");
let r25g = await page.evaluate(async (task) => {
  const y = window.__yzj;
  window.__stub.paperMode = "homework"; window.__stub.homeworkType = 4;
  window.__stub.subResult = { ctype: "x", body: "already" };   // 让 getResultOfStudent 认为已提交
  window.__stub.aiCalls = [];
  GM_setValue("runLock", null);
  GM_setValue("uaState", { active: true, runId: "t", startedAt: Date.now(), done: [], failed: [],
                           attempts: {}, scores: {}, log: [], current: null, skipped: {} });
  document.querySelector("#teachtaskInfo").innerHTML =
    '<li class="contentLi" tmid="999" sclassid="468270" tcid="167189" ttid="11341" tm_subid="298275" homeworkid="259985">'
    + '<div class="tm_name">已交过的作业</div><div class="title2" title="作业"></div></li>';
  try { await y.uaTick(); } catch (e) { /* 循环结束会走 uaStop */ }
  const st = JSON.parse(localStorage.getItem("yzj_uaState") || "{}");
  return { done: (st.done || []).length, failed: (st.failed || []).length,
           ai: window.__stub.aiCalls.length, reason: st.reason };
}, TASK);
check("v1.4.2 已提交过的作业：直接跳过、不调 AI、不重复交",
  r25g.done === 1 && r25g.failed === 0 && r25g.ai === 0, JSON.stringify(r25g));

// 26) 不支持的题型（排序 q_type=7）→ 判定后整套跳过、不调 AI
let r26 = await page.evaluate(async (task) => {
  window.__stub.paperMode = "unsupported"; window.__stub.aiCalls = [];
  try { await window.__yzj.judgeTask({ ...task, homeworkid: "" }); return { skipped: false, calls: window.__stub.aiCalls.length }; }
  catch (e) { return { skipped: e.name === "SkipError", reason: e.reason || e.message, calls: window.__stub.aiCalls.length }; }
}, TASK);
check("v1.4.0 排序题：判定后整套跳过、不调 AI",
  r26.skipped === true && r26.calls === 0 && /暂不支持/.test(r26.reason || ""), JSON.stringify(r26));

// 26b) v1.4.3 连线题：能作答，答案归一化成站点口径 1C#2A#3G
await reset("ok");
let r26b = await page.evaluate(async (task) => {
  window.__stub.paperMode = "line"; window.__stub.aiAnswerMode = "line"; window.__stub.aiCalls = [];
  try {
    const j = await window.__yzj.judgeTask({ ...task, homeworkid: "" });
    return { byNo: j.byNo, text: j.answerText[1], calls: window.__stub.aiCalls.length, prompt: "" };
  } catch (e) { return { error: e.message, name: e.name }; }
}, TASK);
check("v1.4.3 连线题：1c#2a#3b 归一化为 1C#2A#3B，并给出可读预览",
  r26b.byNo && r26b.byNo[1] === "1C#2A#3B" && r26b.calls === 1 && /拔苗助长/.test(r26b.text || ""),
  JSON.stringify({ ans: r26b.byNo && r26b.byNo[1], err: r26b.error,
                   text: String(r26b.text || "").slice(0, 40) }));

// 26c) 连线题：配对数不够 → 拦下不写
let r26c = await page.evaluate(async (task) => {
  window.__stub.paperMode = "line"; window.__stub.aiAnswerMode = "line-bad";
  try { await window.__yzj.judgeTask({ ...task, homeworkid: "" }); return { threw: false }; }
  catch (e) { return { threw: true, msg: e.message }; }
}, TASK);
check("v1.4.3 连线题：少配一项被拦下", r26c.threw && /应配 3 对/.test(r26c.msg || ""), (r26c.msg || "").slice(0, 60));

// 26d) 连线题：右选项不存在 → 拦下不写
let r26d = await page.evaluate(async (task) => {
  window.__stub.paperMode = "line"; window.__stub.aiAnswerMode = "line-wrong";
  try { await window.__yzj.judgeTask({ ...task, homeworkid: "" }); return { threw: false }; }
  catch (e) { return { threw: true, msg: e.message }; }
}, TASK);
check("v1.4.3 连线题：不存在的右选项被拦下", r26d.threw && /不存在的右选项 Q/.test(r26d.msg || ""), (r26d.msg || "").slice(0, 60));

// 26e) 多选(1) 与 连线(6) 是两种题：答案格式互不通用，不能混着喂
const cross = await page.evaluate(() => {
  const y = window.__yzj;
  const multiQ = { type: 1, options: [{ letter: "A" }, { letter: "B" }, { letter: "C" }, { letter: "D" }] };
  const lineQ = { type: 6, left: [{ no: "1" }, { no: "2" }], right: [{ key: "A" }, { key: "B" }] };
  const out = {};
  try { out.multiFromLine = y.normalizeAnswer(multiQ, "1C#2A", 1); } catch (e) { out.multiFromLine = "拒绝:" + e.message; }
  try { out.lineFromMulti = y.normalizeAnswer(lineQ, "ABD", 1); } catch (e) { out.lineFromMulti = "拒绝:" + e.message; }
  out.multiOk = y.normalizeAnswer(multiQ, "a,b,d", 1);
  out.lineOk = y.normalizeAnswer(lineQ, "1b#2a", 1);
  return out;
});
check("v1.4.3 多选与连线是两种题：答案格式互不通用（喂错了会被拒）",
  /拒绝/.test(cross.multiFromLine || "") && /拒绝/.test(cross.lineFromMulti || "")
    && cross.multiOk === "ABD" && cross.lineOk === "1B#2A",
  JSON.stringify(cross));

// 27) 某一批三轮都截断 → 只留空那批，其余照常判题（不拖垮整套）
let r27 = await page.evaluate(async (task) => {
  window.__stub.paperMode = "ok"; window.__stub.qCount = 49; window.__stub.aiAnswerMode = "ok";
  window.__stub.aiMode = "truncate-first-batch";
  try {
    const j = await window.__yzj.judgeTask({ ...task, homeworkid: "" });
    return { incomplete: j.incomplete, missing: j.missing.length, first: j.byNo[1], eleventh: j.byNo[11] };
  } catch (e) { return { error: e.message, name: e.name }; }
}, TASK);
check("v1.4.0 一批全截断：只留空那批（10 题）、其余照常判题",
  r27.incomplete === true && r27.missing === 10 && !r27.first && r27.eleventh === "A", JSON.stringify(r27));

// 28) 整套都判不了 → 主动跳过而不是失败
let r28 = await page.evaluate(async (task) => {
  window.__stub.paperMode = "ok"; window.__stub.qCount = 3; window.__stub.aiMode = "truncate-all";
  try { await window.__yzj.judgeTask({ ...task, homeworkid: "" }); return { skipped: false }; }
  catch (e) { return { skipped: e.name === "SkipError", reason: e.reason || e.message }; }
}, TASK);
check("v1.4.0 整套判不了：主动跳过而不是失败", r28.skipped === true && /判不了/.test(r28.reason || ""), JSON.stringify(r28));

// 29) 规则合并：保留用户自己的规则，只追加新增的默认规则
let r29 = await page.evaluate(() => {
  const y = window.__yzj;
  y.saveSkipRules(["我自己的规则"]);
  y.saveSkipRulesVersion(0);
  const added = y.mergeDefaultSkipRules();
  const list = y.ensureSkipRules();
  return { added, total: y.DEFAULT_SKIP_RULES.length, keep: list.includes("我自己的规则"),
           hasDefault: list.includes("你学会了"), version: y.CFG.skipRulesVersion };
});
check("v1.4.0 追加新默认规则：保留用户规则、只补新增条目",
  r29.keep === true && r29.hasDefault === true && r29.added === r29.total && r29.version === 1, JSON.stringify(r29));

// 30) 设置面板：跳过规则可编辑 / 可恢复默认 / 可追加新默认
await page.evaluate(() => {
  document.querySelectorAll(".yzj-mask").forEach((m) => m.remove());
  window.__yzj.saveSkipRules(["只留我这条"]);
  window.__yzj.openSettings();
});
await page.waitForTimeout(400);
const set1 = await page.evaluate(() => {
  const d = [...document.querySelectorAll(".yzj-dialog")].pop();
  const ta = d.querySelector("#yzj-skiprules");
  return { exists: !!ta, value: ta ? ta.value : "",
           hasReset: !!d.querySelector('[data-a="skipreset"]'), hasMerge: !!d.querySelector('[data-a="skipmerge"]'),
           hasEffort: !!d.querySelector("#yzj-effort"), hasCap: !!d.querySelector("#yzj-maxtok") };
});
check("v1.4.0 设置面板：规则文本域 + 恢复默认/追加按钮 + 预算项都在",
  set1.exists && set1.value === "只留我这条" && set1.hasReset && set1.hasMerge && set1.hasEffort && set1.hasCap,
  JSON.stringify(set1));
await page.locator('.yzj-dialog [data-a="skipmerge"]').click();
await page.waitForTimeout(300);
const set2 = await page.evaluate(() => {
  const ta = [...document.querySelectorAll(".yzj-dialog")].pop().querySelector("#yzj-skiprules");
  return { lines: ta.value.split("\n").length, keep: ta.value.includes("只留我这条"),
           saved: window.__yzj.ensureSkipRules().length };
});
check("v1.4.0 设置面板：追加新默认规则时保留自定义条目",
  set2.keep === true && set2.lines === set2.saved && set2.lines > 1, JSON.stringify(set2));
await page.locator('.yzj-dialog [data-a="skipreset"]').click();
await page.waitForTimeout(300);
const set3 = await page.evaluate(() => {
  const ta = [...document.querySelectorAll(".yzj-dialog")].pop().querySelector("#yzj-skiprules");
  return { lines: ta.value.split("\n").length, defs: window.__yzj.DEFAULT_SKIP_RULES.length };
});
check("v1.4.0 设置面板：恢复默认写回内置规则", set3.lines === set3.defs, JSON.stringify(set3));
// 30b) v1.4.6 设置面板：字段归位（低置信度/超时不再被三个区块隔开）+ 底部按钮沾底 + 标题带版本号
const set4 = await page.evaluate(() => {
  const d = [...document.querySelectorAll(".yzj-dialog")].pop();
  const conf = d.querySelector("#yzj-conf");
  const secs = [...d.querySelectorAll(".yzj-sec")];
  const sec = secs.find((s) => s.textContent.includes("低置信度"));
  const skip = secs.find((s) => s.textContent.includes("跳过规则"));
  const foot = d.querySelector("#yzj-foot");
  const AFTER = Node.DOCUMENT_POSITION_FOLLOWING;
  return {
    hasConfSec: !!sec, hasSkipSec: !!skip,
    confBeforeSkip: !!(conf && skip) && (conf.compareDocumentPosition(skip) & AFTER) !== 0,
    secsBetween: sec && skip ? secs.filter((s) =>
      (sec.compareDocumentPosition(s) & AFTER) !== 0 &&
      (s.compareDocumentPosition(skip) & AFTER) !== 0).length : -1,
    footSticky: foot ? getComputedStyle(foot).position : "",
    footHasSave: !!(foot && foot.querySelector('[data-a="save"]')),
    ver: ((d.querySelector("#yzj-ver") || {}).textContent || "").trim(),
  };
});
check("v1.4.6 设置面板：低置信度/超时自己一个区块、底部按钮沾底、标题带版本号",
  set4.hasConfSec && set4.hasSkipSec && set4.confBeforeSkip && set4.secsBetween === 0 &&
  set4.footSticky === "sticky" && set4.footHasSave && /^v\d+\.\d+\.\d+$/.test(set4.ver),
  JSON.stringify(set4));

// 顺手留个面板截图的口子：YZJ_SHOT=<目录> node scripts\test_logic.mjs（平时不跑，不影响测试结果）
if (process.env.YZJ_SHOT) {
  try {
    fs.mkdirSync(process.env.YZJ_SHOT, { recursive: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(200);
    const dlg = page.locator(".yzj-dialog").last();
    const shot = path.join(process.env.YZJ_SHOT, "settings-panel.png");
    await dlg.screenshot({ path: shot });
    // 再把「低置信度与超时」滚到中间来一张，方便看字段有没有跟标签贴在一起
    await page.evaluate(() => {
      const d = [...document.querySelectorAll(".yzj-dialog")].pop();
      const el = d.querySelector("#yzj-conf");
      if (el) el.scrollIntoView({ block: "center" });
    });
    await page.waitForTimeout(200);
    const shot2 = path.join(process.env.YZJ_SHOT, "settings-panel-conf.png");
    await dlg.screenshot({ path: shot2 });
    // 再滚回顶部来一张，方便看「显示/静默」「交卷行为」那几组
    await page.evaluate(() => {
      const d = [...document.querySelectorAll(".yzj-dialog")].pop();
      d.scrollTop = 0;
    });
    await page.waitForTimeout(200);
    await dlg.screenshot({ path: path.join(process.env.YZJ_SHOT, "settings-panel-top.png") });
    console.log("已截图设置面板 →", shot, "与", shot2);
  } catch (e) {
    console.log("截图失败：", e.message);
  }
}

await page.evaluate(() => document.querySelectorAll(".yzj-mask").forEach((m) => m.remove()));

// 30c) v1.4.6 面板：导航独立一行（题库/日志/历史/设置）、标题带版本号、收起留在标题条
const pan = await page.evaluate(() => {
  document.querySelectorAll(".yzj-panel").forEach((p) => p.remove());
  const p = window.__yzj.ensurePanel();
  const nav = p.querySelector(".yzj-nav");
  const h3 = p.querySelector("h3");
  return {
    hasNav: !!nav,
    acts: nav ? [...nav.querySelectorAll("[data-act]")].map((b) => b.dataset.act) : [],
    h3Acts: h3 ? [...h3.querySelectorAll("[data-act]")].map((b) => b.dataset.act) : [],
    ver: ((p.querySelector(".yzj-ver") || {}).textContent || "").trim(),
    hasLog: !!p.querySelector(".yzj-log"), hasBody: !!p.querySelector(".yzj-body"),
  };
});
{
  const want = ["bank", "log", "history", "settings"];
  check("v1.4.6 面板：导航独立一行、标题带版本号、收起还留在标题条",
    pan.hasNav && want.every((a) => pan.acts.includes(a)) && pan.h3Acts.join() === "close" &&
    /^v\d+\.\d+\.\d+$/.test(pan.ver) && pan.hasLog && pan.hasBody, JSON.stringify(pan));
}
// 面板截图（跟设置面板共用一个开关：YZJ_SHOT=<目录>）
if (process.env.YZJ_SHOT) {
  try {
    await page.waitForTimeout(200);
    const shot = path.join(process.env.YZJ_SHOT, "panel.png");
    await page.locator(".yzj-panel").last().screenshot({ path: shot });
    console.log("已截图脚本面板 →", shot);
  } catch (e) {
    console.log("面板截图失败：", e.message);
  }
}

// 31) v1.4.4 题库条目带题干/题型 → 导出的 JSON 才看得懂、改得动
await reset("ok");
let r31 = await page.evaluate(async (task) => {
  const y = window.__yzj;
  GM_setValue("answerBank", {}); GM_setValue("bankNotes", {});
  await y.judgeTask({ ...task, homeworkid: "" });
  const notes = JSON.parse(localStorage.getItem("yzj_bankNotes") || "{}");
  const firstKey = Object.keys(notes)[0];
  y.bankPut(firstKey, "A", "learn");                       // 模拟"交卷后自学习"写入答案
  const bank = y.bankAll();
  return { notes: Object.keys(notes).length, key: firstKey,
           q: bank[firstKey] && bank[firstKey].q, t: bank[firstKey] && bank[firstKey].t,
           a: bank[firstKey] && bank[firstKey].a, stats: y.bankStats() };
}, TASK);
check("v1.4.4 题库条目带上题干与题型（导出后可读）",
  r31.notes > 0 && !!r31.q && r31.t === 0 && r31.a === "A" && r31.stats.withText === 1,
  JSON.stringify({ notes: r31.notes, q: String(r31.q || "").slice(0, 20), t: r31.t, withText: r31.stats.withText }));

// 32) v1.4.4 导出 CSV：表头 + 题干都在，Excel 能直接开
await page.evaluate(() => {
  document.querySelectorAll(".yzj-mask").forEach((m) => m.remove());
  window.__yzj.openBank();
});
const csvFile = path.join(ROOT, "work", "test-bank-export.csv");
const dlCsv = page.waitForEvent("download", { timeout: 20000 });
await page.locator('.yzj-dialog [data-a="expcsv"]').click();
await (await dlCsv).saveAs(csvFile);
const csvText = fs.readFileSync(csvFile, "utf8");
check("v1.4.4 导出 CSV：带 key/题型/题干/答案 表头与内容",
  csvText.includes('"key","题型","题干","答案"') && csvText.includes("question 1"),
  csvText.split("\n")[1] ? csvText.split("\n")[1].slice(0, 70) : "(空)");
await page.evaluate(() => document.querySelectorAll(".yzj-mask").forEach((m) => m.remove()));

// 33) v1.4.5 max_tokens 起跳值：不能再从 2000 起步（实测 27% token 白烧）
const r33 = await page.evaluate(() => {
  const b = window.__yzj.budgetFor;
  return { b1: b(1, false, 0), b4: b(4, false, 0), b20: b(20, false, 0), subj: b(1, false, 0, true),
           lvl1: b(4, false, 1), lvl2: b(4, false, 2) };
});
check("v1.4.5 max_tokens 起跳 ≥6000、题多时按 400/题 递增、简答更高",
  r33.b1 >= 6000 && r33.b4 >= 6000 && r33.b20 === 8000 && r33.subj >= 8000
    && r33.lvl1 > r33.b4 && r33.lvl2 >= r33.lvl1,
  JSON.stringify(r33));

// 34) v1.4.5 无人值守上限必须真的生效（实测：设 20 却跑了 58 套）
let r34 = await page.evaluate(async () => {
  const y = window.__yzj;
  localStorage.setItem("yzj_uaMaxTasks", "2");
  window.__stub.paperMode = "ok"; window.__stub.qCount = 1; window.__stub.aiCalls = [];
  window.__stub.submitted = false; window.__stub.subResult = null;
  GM_setValue("runLock", null);
  GM_setValue("answerBank", {}); GM_setValue("bankNotes", {});
  document.querySelector("#teachtaskInfo").innerHTML = [1, 2, 3, 4, 5].map((n) =>
    `<li class="contentLi" tmid="${900 + n}" sclassid="468270" tcid="167189" ttid="11341" tm_subid="29827${n}">`
    + `<div class="tm_name">测试${n}</div><div class="title2" title="卷${n}"></div></li>`).join("");
  GM_setValue("uaState", { active: true, runId: "limit", startedAt: Date.now(), done: [], failed: [],
                           attempts: {}, scores: {}, log: [], current: null, skipped: {} });
  try { await y.uaTick("limit"); } catch (e) { /* 到上限会自己结束 */ }
  const st = JSON.parse(localStorage.getItem("yzj_uaState") || "{}");
  localStorage.setItem("yzj_uaMaxTasks", "20");
  return { done: (st.done || []).length, failed: (st.failed || []).length, reason: st.reason,
           active: st.active, ai: window.__stub.aiCalls.length };
});
check("v1.4.5 无人值守「单次最多任务数」在循环内生效（设 2 就只跑 2 套）",
  r34.done === 2 && /上限 2 套/.test(r34.reason || "") && r34.active === false,
  JSON.stringify(r34));

// 34a) v1.5.0 报错文案按 DeepSeek 官方《错误码》原文输出（401/402/429/503）
let r34a = await page.evaluate(() => {
  const y = window.__yzj;
  const mk = (code, raw) => ({ message: `接口返回 ${code}：{"error":{"message":"${raw}"}}` });
  return {
    e401: y.explainError(mk(401, "Authentication Fails, Your api key: ****0610 is invalid")),
    e402: y.explainError(mk(402, "Insufficient Balance")),
    e429: y.explainError(mk(429, "Rate limit reached")),
    e503: y.explainError(mk(503, "Server is overloaded")),
    doc401: y.explainErrorDoc(mk(401, "Authentication Fails, Your api key: ****0610 is invalid")),
    doc429: y.explainErrorDoc(mk(429, "Rate limit reached")),
    d401: y.AI_HTTP_DOC[401].name, d429: y.AI_HTTP_DOC[429].cause, d503: y.AI_HTTP_DOC[503].fix,
  };
});
check("v1.5.1 提示语够短：一句「结论（码）→ 该干什么」",
  r34a.e401 === "API Key 无效（401）→ 去设置里重填 Key"
  && r34a.e402 === "DeepSeek 余额不足（402）→ 去官网充值"
  && r34a.e429 === "请求过快被限流（429）→ 已自动等一会儿再试"
  && r34a.e503 === "DeepSeek 服务器繁忙（503）→ 稍后自动重试"
  && r34a.e401.length < 30,
  JSON.stringify(r34a));
check("v1.5.1 官方原文仍保留（进日志/详情，便于对照 DeepSeek 文档）",
  /官方 401 认证失败/.test(r34a.doc401) && /API key 错误，认证失败/.test(r34a.doc401)
  && /Authentication Fails/.test(r34a.doc401) && /官方 429 请求速率达到上限/.test(r34a.doc429)
  && r34a.d401 === "认证失败" && r34a.d429 === "请求速率（TPM 或 RPM）达到上限",
  JSON.stringify({ doc401: r34a.doc401, doc429: r34a.doc429 }));

// 34a2) v1.5.0 429 撞限流：按官方"别高频重试"退避等待，最终停下整轮（不再一套套空转）
let r34a2 = await page.evaluate(async () => {
  const y = window.__yzj;
  const old429 = y.AI_BACKOFF[429];
  y.AI_BACKOFF[429] = [10, 10];                 // 测试里把退避压到 10ms，别真等 26 秒
  window.__stub.aiMode = "429"; window.__stub.aiCalls = [];
  let r;
  try {
    await y.judgeTask({ tmid: "999", sclassid: "468270", tcid: "167189", ttid: "11341",
                        submitId: "298275", name: "测试", title: "测", homeworkid: "" });
    r = { ok: true };
  } catch (e) {
    r = { skip: e.name === "SkipError", kind: e.kind, reason: e.reason || e.message,
          calls: window.__stub.aiCalls.length };
  }
  y.AI_BACKOFF[429] = old429;
  window.__stub.aiMode = "ok";
  return r;
});
check("v1.5.0 429：退避重试后停下整轮，理由按官方说清是限流",
  r34a2.skip === true && r34a2.kind === "config" && /请求过快被限流（429）/.test(r34a2.reason || "")
  && r34a2.calls === 3, JSON.stringify(r34a2));

// 34a3) v1.5.0 503 服务器繁忙：属于"稍后重试"，重试后仍失败就是普通判不了（不停整轮）
let r34a3 = await page.evaluate(async () => {
  const y = window.__yzj;
  const old = y.AI_BACKOFF[503];
  y.AI_BACKOFF[503] = [5, 5];
  window.__stub.aiMode = "503"; window.__stub.aiCalls = [];
  let r;
  try {
    await y.judgeTask({ tmid: "999", sclassid: "468270", tcid: "167189", ttid: "11341",
                        submitId: "298275", name: "测试", title: "测", homeworkid: "" });
    r = { ok: true };
  } catch (e) {
    r = { skip: e.name === "SkipError", kind: e.kind, reason: e.reason || e.message,
          calls: window.__stub.aiCalls.length };
  }
  y.AI_BACKOFF[503] = old;
  window.__stub.aiMode = "ok";
  return r;
});
check("v1.5.0 503：按官方重试 3 次，仍失败算「判不了」而不是整轮停（服务器问题会自愈）",
  r34a3.skip === true && r34a3.kind === "unjudgeable" && /DeepSeek 服务器繁忙（503）/.test(r34a3.reason || "")
  && r34a3.calls === 3, JSON.stringify(r34a3));

// 34b) v1.4.9 Key 无效：只试 1 次就停；跳过理由要说清是 Key 的问题（别再甩锅给"截断"）
await reset("ok");
await page.evaluate(() => { window.__stub.aiMode = "401"; window.__stub.aiCalls = []; });
let r34b = await page.evaluate(async (task) => {
  try {
    await window.__yzj.judgeTask({ ...task, homeworkid: "" });
    return { ok: true };
  } catch (e) {
    return { skip: e.name === "SkipError", kind: e.kind, reason: e.reason || e.message,
             calls: window.__stub.aiCalls.length };
  }
}, TASK);
check("v1.4.9 401：AI 只调 1 次（不再重试三轮），理由一眼看出是 Key 的问题",
  r34b.skip === true && r34b.kind === "config"
  && /API Key 无效（401）/.test(r34b.reason || "") && /去设置里重填 Key/.test(r34b.reason || "")
  && !/截断/.test(r34b.reason || "") && r34b.calls === 1, JSON.stringify(r34b));

// 34c) v1.4.9 无人值守遇到 Key 无效：整轮立刻停，不再一套一套重复同一个错
let r34c = await page.evaluate(async () => {
  const y = window.__yzj;
  window.__stub.aiMode = "401"; window.__stub.aiCalls = [];
  window.__stub.paperMode = "ok"; window.__stub.qCount = 1;
  GM_setValue("runLock", null);
  GM_setValue("answerBank", {}); GM_setValue("bankNotes", {});
  document.querySelector("#teachtaskInfo").innerHTML = [1, 2, 3].map((n) =>
    `<li class="contentLi" tmid="${1100 + n}" sclassid="468270" tcid="167189" ttid="11341" tm_subid="29828${n}">`
    + `<div class="tm_name">测试${n}</div><div class="title2" title="卷${n}"></div></li>`).join("");
  GM_setValue("uaState", { active: true, runId: "cfg", startedAt: Date.now(), done: [], failed: [],
                           attempts: {}, scores: {}, log: [], current: null, skipped: {} });
  try { await y.uaTick("cfg"); } catch (e) { /* 停轮时可能抛 */ }
  const st = JSON.parse(localStorage.getItem("yzj_uaState") || "{}");
  const r = { active: st.active, reason: st.reason, done: (st.done || []).length,
              failed: (st.failed || []).length, ai: window.__stub.aiCalls.length };
  window.__stub.aiMode = "ok";
  return r;
});
check("v1.4.9 无人值守遇到 401：整轮停掉（不继续下一套，也不计失败）",
  r34c.active === false && /API Key 无效（401）/.test(r34c.reason || "")
  && r34c.done === 0 && r34c.failed === 0 && r34c.ai === 1, JSON.stringify(r34c));

// 35) v1.4.7 来源标注：题库条目带上「哪门课 / 哪个班 / 哪个账号」
await page.evaluate(() => {
  GM_setValue("answerBank", {}); GM_setValue("bankNotes", {});   // 只存在于页面上下文
  sessionStorage.setItem("login_number", "2024130038");
  sessionStorage.setItem("login_name", "测试同学");
  sessionStorage.setItem("stuId", "12569");
  sessionStorage.setItem("indexpage:gid", "20");
});
await reset("ok");
let r35 = await page.evaluate(async (task) => {
  const y = window.__yzj;
  await y.loadTaskMeta();                       // 预热（真实场景里 judgeTask 开场就会触发）
  await y.judgeTask({ ...task, homeworkid: "" });
  const notes = JSON.parse(localStorage.getItem("yzj_bankNotes") || "{}");
  const k = Object.keys(notes)[0] || "";
  const n = notes[k] || {};
  y.bankPut(k, "A", "learn");                   // 模拟"交卷后自学习"写入题库
  const pKey = Object.keys(notes).find((x) => x[0] === "p") || "";
  const pn = notes[pKey] || {};
  const bank = y.bankAll();
  return { k, subj: n.subj, cls: n.cls, stu: n.stu, who: n.who,
           pKey, pSubj: pn.subj, pStu: pn.stu, pHasQ: !!pn.q,
           bankSubj: bank[k] && bank[k].subj, bankStu: bank[k] && bank[k].stu };
}, TASK);
check("v1.4.7 题库标注：条目带上课程 / 班级 / 学号",
  r35.subj === "光伏电池制造技术" && r35.cls === "25级05班"
  && r35.stu === "2024130038" && r35.who === "测试同学"
  && r35.bankSubj === "光伏电池制造技术" && r35.bankStu === "2024130038",
  JSON.stringify(r35));
check("v1.4.7 题库标注：图片/卷子键（i/d/p）也带来源，但不硬塞题干",
  r35.pKey.startsWith("p") && r35.pSubj === "光伏电池制造技术"
  && r35.pStu === "2024130038" && r35.pHasQ === false,
  JSON.stringify({ pKey: r35.pKey, pSubj: r35.pSubj, pStu: r35.pStu, pHasQ: r35.pHasQ }));

// 36) v1.4.8 总开关 → 子设置折叠（开关关了，下面那些设置本来就不生效）
await page.evaluate(() => {
  document.querySelectorAll(".yzj-mask").forEach((m) => m.remove());
  GM_setValue("unattended", false);
  GM_setValue("autoFinalize", true);
  GM_setValue("skipEnabled", true);
  GM_setValue("delayEnabled", false);
  GM_setValue("uaFinalize", false);   // 让"会不会自动交卷"只由 autoFinalize 决定
  window.__yzj.openSettings();
});
await page.waitForTimeout(400);
const fold1 = await page.evaluate(() => {
  const d = [...document.querySelectorAll(".yzj-dialog")].pop();
  const vis = (sel) => { const el = d.querySelector(sel); return el ? getComputedStyle(el).display !== "none" : null; };
  return { ua: vis("#yzj-uabox"), skip: vis("#yzj-skipbox"), fin: vis("#yzj-finbox"), delay: vis("#yzj-delaybox") };
});
check("v1.4.8 折叠初态：无人值守关→子项收起；跳过规则/自动交卷开→子项展开；延迟关→收起",
  fold1.ua === false && fold1.skip === true && fold1.fin === true && fold1.delay === false,
  JSON.stringify(fold1));

await page.locator(".yzj-dialog #yzj-ua").check();          // 打开总开关
await page.waitForTimeout(150);
const fold2 = await page.evaluate(() => {
  const d = [...document.querySelectorAll(".yzj-dialog")].pop();
  return { ua: getComputedStyle(d.querySelector("#yzj-uabox")).display !== "none" };
});
await page.locator(".yzj-dialog #yzj-auto").uncheck();        // 关掉自动交卷（无人值守的自动交卷没勾）
await page.waitForTimeout(150);
const fold3 = await page.evaluate(() => {
  const d = [...document.querySelectorAll(".yzj-dialog")].pop();
  return { fin: getComputedStyle(d.querySelector("#yzj-finbox")).display !== "none" };
});
await page.locator(".yzj-dialog #yzj-auto").check();          // 勾回来
await page.waitForTimeout(150);
const fold4 = await page.evaluate(() => {
  const d = [...document.querySelectorAll(".yzj-dialog")].pop();
  return { fin: getComputedStyle(d.querySelector("#yzj-finbox")).display !== "none" };
});
check("v1.4.8 折叠联动：开无人值守→展开；此时没有任何自动交卷→交卷子项收起；勾回自动交卷→又展开",
  fold2.ua === true && fold3.fin === false && fold4.fin === true,
  JSON.stringify({ ...fold2, ...fold3, ...fold4 }));

await page.evaluate(() => {
  const d = [...document.querySelectorAll(".yzj-dialog")].pop();
  const fire = (el) => el.dispatchEvent(new Event("change", { bubbles: true }));
  const ua = d.querySelector("#yzj-ua");
  ua.checked = false; fire(ua);                               // 关回无人值守（顺便验证隐藏值仍会保存）
  d.querySelector("#yzj-uaretry").value = "5";
  const sk = d.querySelector("#yzj-skipen");
  sk.checked = false; fire(sk);                               // 跳过规则也关一下
});
await page.waitForTimeout(150);
const fold5 = await page.evaluate(() => {
  const d = [...document.querySelectorAll(".yzj-dialog")].pop();
  return { ua: getComputedStyle(d.querySelector("#yzj-uabox")).display !== "none",
           skip: getComputedStyle(d.querySelector("#yzj-skipbox")).display !== "none" };
});
check("v1.4.8 折叠：手动改勾选后也随之收起", fold5.ua === false && fold5.skip === false, JSON.stringify(fold5));
await page.locator('.yzj-dialog [data-a="save"]').click();
await page.waitForTimeout(300);
const saved = await page.evaluate(() => ({
  uaRetry: GM_getValue("uaRetry", null),
  unattended: GM_getValue("unattended", null),
  skipEnabled: GM_getValue("skipEnabled", null),
}));
// 低置信度：阈值填 0 = 没设阈值，"暂停等我确认"就该收起来
await page.evaluate(() => {
  document.querySelectorAll(".yzj-mask").forEach((m) => m.remove());
  GM_setValue("lowConfidence", 0.7);
  window.__yzj.openSettings();
});
await page.waitForTimeout(350);
const conf1 = await page.evaluate(() => {
  const d = [...document.querySelectorAll(".yzj-dialog")].pop();
  const vis = () => getComputedStyle(d.querySelector("#yzj-confbox")).display !== "none";
  const before = vis();
  const el = d.querySelector("#yzj-conf");
  el.value = "0";
  el.dispatchEvent(new Event("input", { bubbles: true }));
  const after = vis();
  return { before, after };
});
check("v1.4.8 折叠：低置信度阈值 >0 才显示「暂停等我确认」，填 0 就收起",
  conf1.before === true && conf1.after === false, JSON.stringify(conf1));
await page.evaluate(() => document.querySelectorAll(".yzj-mask").forEach((m) => m.remove()));

check("v1.4.8 折叠不影响保存：藏起来的子设置照存（uaRetry=5），开关本身也照存",
  saved.uaRetry === 5 && saved.unattended === false && saved.skipEnabled === false, JSON.stringify(saved));
await page.evaluate(() => {
  document.querySelectorAll(".yzj-mask").forEach((m) => m.remove());
  GM_setValue("skipEnabled", true);
});

// ================= v1.6.0 多服务商 + 模型检测 =================
await page.evaluate(() => {
  document.querySelectorAll(".yzj-mask").forEach((m) => m.remove());
  GM_setValue("provider", "deepseek"); GM_setValue("proto", "openai"); GM_setValue("modelVision", "");
  // 各家单独存的配置会跨轮次留着，先清干净，这一组用例才是可重复的
  window.__yzj.AI_PROVIDERS.forEach((p) => GM_setValue("slot_" + p.id, null));
});

// 35) 服务商表 / 地址认领 / 三协议路径与鉴权头
const v16a = await page.evaluate(() => {
  const y = window.__yzj;
  return {
    ids: y.AI_PROVIDERS.map((p) => p.id),
    byId: (y.providerById("zhipu") || {}).name,
    guess: [y.guessProviderId("https://api.openai.com/v1"), y.guessProviderId("https://api.anthropic.com/v1"),
            y.guessProviderId("https://dashscope.aliyuncs.com/compatible-mode/v1"),
            y.guessProviderId("http://127.0.0.1:11434/v1"), y.guessProviderId("https://my-gw.internal/v1"),
            y.guessProviderId("")],
    urlOpenai: y.aiUrl("chat", { baseUrl: "https://api.deepseek.com", proto: "openai", model: "m" }),
    urlAnthropic: y.aiUrl("chat", { baseUrl: "https://api.anthropic.com/v1/", proto: "anthropic", model: "m" }),
    urlGemini: y.aiUrl("chat", { baseUrl: "https://generativelanguage.googleapis.com/v1beta",
                                 proto: "gemini", model: "models/gemini-3-pro" }),
    urlModels: y.aiUrl("models", { baseUrl: "https://api.openai.com/v1", proto: "openai" }),
    hdrAn: y.aiHeaders({ proto: "anthropic", apiKey: "sk-x" }),
    hdrGe: y.aiHeaders({ proto: "gemini", apiKey: "sk-x" }),
    hdrOa: y.aiHeaders({ proto: "openai", apiKey: "sk-x" }),
    noKeyReady: (() => {
      GM_setValue("apiKey", ""); GM_setValue("provider", "ollama");
      const v = y.aiReady();
      GM_setValue("apiKey", "sk-test-key-0000000000000000000000"); GM_setValue("provider", "deepseek");
      return v;
    })(),
  };
});
check("v1.6.0 内置多家服务商（OpenAI / Claude / Gemini / Kimi / 智谱 / 通义 / 火山 / 硅基流动 / OpenRouter / 本机）",
  ["deepseek", "openai", "anthropic", "gemini", "moonshot", "zhipu", "dashscope", "volcengine",
   "siliconflow", "openrouter", "ollama", "custom"].every((k) => v16a.ids.includes(k)) && v16a.byId === "智谱 GLM",
  JSON.stringify(v16a.ids));
check("v1.6.0 老用户升级：只凭 base_url 就能认领是哪一家",
  v16a.guess.join(",") === "openai,anthropic,dashscope,ollama,custom,deepseek", JSON.stringify(v16a.guess));
check("v1.6.0 三套协议各走各的路径（末尾多余的 / 会被吃掉）",
  v16a.urlOpenai === "https://api.deepseek.com/chat/completions"
  && v16a.urlAnthropic === "https://api.anthropic.com/v1/messages"
  && v16a.urlGemini === "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:generateContent"
  && v16a.urlModels === "https://api.openai.com/v1/models",
  JSON.stringify([v16a.urlOpenai, v16a.urlAnthropic, v16a.urlGemini, v16a.urlModels]));
check("v1.6.0 鉴权头按家走（Claude 用 x-api-key，Gemini 用 x-goog-api-key，Key 不进 URL）",
  v16a.hdrAn["x-api-key"] === "sk-x" && v16a.hdrAn["anthropic-version"] === "2023-06-01"
  && v16a.hdrAn["anthropic-dangerous-direct-browser-access"] === "true"
  && v16a.hdrGe["x-goog-api-key"] === "sk-x" && v16a.hdrOa.Authorization === "Bearer sk-x"
  && !/[?&]key=/.test(v16a.urlGemini),      // Gemini 的 key 走请求头，不进 URL（免得被日志带出去）
  JSON.stringify([v16a.hdrAn, v16a.hdrGe, v16a.hdrOa]));
check("v1.6.0 本机 Ollama 不用填 Key 也算「配置好了」", v16a.noKeyReady === true, String(v16a.noKeyReady));

// 35b) 三协议的请求体 / 取正文 / 截断判定 / token 统计
const v16b = await page.evaluate(() => {
  const y = window.__yzj;
  const parts = [{ text: "题干" }, { image: "data:image/png;base64,QUJD" }];
  const oa = y.aiBody({ proto: "openai", model: "m", systemText: "sys", parts, maxTokens: 100 });
  const an = y.aiBody({ proto: "anthropic", model: "m", systemText: "sys", parts, maxTokens: 100 });
  const ge = y.aiBody({ proto: "gemini", model: "m", systemText: "sys", parts, maxTokens: 100 });
  return {
    oaUrl: oa.messages[1].content[1].image_url.url, oaSysRole: oa.messages[0].role,
    oaImgType: oa.messages[1].content[1].type,
    anSys: an.system, anImg: an.messages[0].content[1].source,
    geSys: ge.systemInstruction.parts[0].text, geImg: ge.contents[0].parts[1].inline_data,
    geMax: ge.generationConfig.maxOutputTokens,
    split: y.splitDataUrl("data:image/jpeg;base64,QUJD"),
    t_oa: y.aiTextOf({ choices: [{ message: { content: "OA" } }] }, "openai"),
    t_an: y.aiTextOf({ content: [{ type: "text", text: "AN" }, { type: "tool_use" }] }, "anthropic"),
    t_ge: y.aiTextOf({ candidates: [{ content: { parts: [{ text: "GE" }] } }] }, "gemini"),
    f_oa: y.aiFinishOf({ choices: [{ finish_reason: "length" }] }, "openai"),
    f_an: y.aiFinishOf({ stop_reason: "max_tokens" }, "anthropic"),
    f_ge: y.aiFinishOf({ candidates: [{ finishReason: "MAX_TOKENS" }] }, "gemini"),
    f_stop: y.aiFinishOf({ choices: [{ finish_reason: "stop" }] }, "openai"),
    u1: y.aiUsageOf({ usage: { total_tokens: 12 } }),
    u2: y.aiUsageOf({ usageMetadata: { total_token_count: 34 } }),
    u3: y.aiUsageOf({ usage: { input_tokens: 3, output_tokens: 4 } }),
  };
});
check("v1.6.0 请求体按协议塑形（OpenAI image_url / Claude base64 source / Gemini inline_data）",
  v16b.oaImgType === "image_url" && /^data:image\/png;base64,QUJD$/.test(v16b.oaUrl) && v16b.oaSysRole === "system"
  && v16b.anSys === "sys" && v16b.anImg.type === "base64" && v16b.anImg.media_type === "image/png"
  && v16b.anImg.data === "QUJD" && v16b.geSys === "sys"
  && v16b.geImg.mime_type === "image/png" && v16b.geImg.data === "QUJD" && v16b.geMax === 100,
  JSON.stringify([v16b.oaImgType, v16b.anImg, v16b.geImg]));
check("v1.6.0 data URL 拆分正确",
  v16b.split.mime === "image/jpeg" && v16b.split.data === "QUJD", JSON.stringify(v16b.split));
check("v1.6.0 三家的正文都能读出来（Claude 只取 text 段）",
  v16b.t_oa === "OA" && v16b.t_an === "AN" && v16b.t_ge === "GE",
  JSON.stringify([v16b.t_oa, v16b.t_an, v16b.t_ge]));
check("v1.6.0 三家的「被截断」都归一成 length",
  v16b.f_oa === "length" && v16b.f_an === "length" && v16b.f_ge === "length" && v16b.f_stop === "stop",
  JSON.stringify([v16b.f_oa, v16b.f_an, v16b.f_ge, v16b.f_stop]));
check("v1.6.0 token 统计兼容 usage / usageMetadata / input+output",
  v16b.u1 === 12 && v16b.u2 === 34 && v16b.u3 === 7, JSON.stringify([v16b.u1, v16b.u2, v16b.u3]));

// 35c) 模型清单解析
const v16c = await page.evaluate(() => {
  const y = window.__yzj;
  return {
    or: y.parseModelList({ data: [
      { id: "aaa/text-only" },
      { id: "zzz/vision-one", architecture: { input_modalities: ["text", "image"] } },
      { id: "bbb/other", name: "B 模型" },
      { id: "aaa/text-only" },
    ] }, "openai"),
    ge: y.parseModelList({ models: [{ name: "models/gemini-3-pro", displayName: "G3",
                                      inputModalities: ["TEXT", "IMAGE"] }] }, "gemini"),
    an: y.parseModelList({ data: [{ id: "claude-sonnet-4-5", display_name: "Sonnet" }] }, "anthropic"),
  };
});
check("v1.6.0 模型清单：能看图的排前面并标记、去重、保留备注名",
  v16c.or.length === 3 && v16c.or[0].id === "zzz/vision-one" && v16c.or[0].vision === "yes"
  && v16c.or[2].id === "bbb/other" && v16c.or[2].note === "B 模型",
  JSON.stringify(v16c.or));
check("v1.6.0 模型清单：Gemini 的 models/ 前缀会去掉，Claude 按 id 认",
  v16c.ge[0].id === "gemini-3-pro" && v16c.ge[0].vision === "yes"
  && v16c.an[0].id === "claude-sonnet-4-5" && v16c.an[0].vision === "yes",
  JSON.stringify([v16c.ge, v16c.an]));

// 36) 「检测模型」真跑一遍（桩里的 GET /models）
const v16d = await page.evaluate(async () => {
  const y = window.__yzj;
  window.__stub.modelCalls = 0;
  window.__stub.modelList = { data: [{ id: "aaa" }, { id: "zzz-vl", architecture: { input_modalities: ["image"] } }] };
  let list = [];
  let err = "";
  try { list = await y.fetchModelList({ baseUrl: "https://api.deepseek.com", apiKey: "sk-t", proto: "openai" }); }
  catch (e) { err = String((e && e.message) || e); }
  const out = { ids: list.map((m) => m.id + (m.vision === "yes" ? "*" : "")),
                calls: window.__stub.modelCalls, url: window.__stub.lastModelUrl, err,
                auth: (window.__stub.lastModelHeaders || {}).Authorization || "" };
  window.__stub.modelList = null;
  return out;
});
check("v1.6.0 检测模型：GET /models + 带 Bearer，返回可点的清单",
  v16d.calls === 1 && v16d.url === "https://api.deepseek.com/models" && v16d.auth === "Bearer sk-t"
  && v16d.ids.join(",") === "zzz-vl*,aaa" && v16d.err === "",
  JSON.stringify(v16d));

// 36a) 图片模型：带图就用它，不带图还是主模型
const v16e = await page.evaluate(() => {
  const y = window.__yzj;
  GM_setValue("model", "text-model");
  GM_setValue("modelVision", "vision-model");
  const dual = [y.modelForRequest(false), y.modelForRequest(true)];
  GM_setValue("modelVision", "");
  const single = [y.modelForRequest(false), y.modelForRequest(true)];
  GM_setValue("model", "deepseek-flash");
  return { dual, single };
});
check("v1.6.0 图片模型：填了就图片走它、文字走主模型；留空就都用主模型",
  v16e.dual.join(",") === "text-model,vision-model" && v16e.single.join(",") === "text-model,text-model",
  JSON.stringify(v16e));

// 37) 报错文案跟着服务商走
const v16f = await page.evaluate(() => {
  const y = window.__yzj;
  const mk = (code, raw) => ({ message: `接口返回 ${code}：{"error":{"message":"${raw}"}}` });
  const out = {};
  GM_setValue("provider", "openai");
  out.oa402 = y.explainError(mk(402, "You exceeded your current quota"));
  out.oaModel = y.explainError(mk(400, "The model gpt-9 does not exist"));
  out.oa404 = y.explainError(mk(404, "model not found"));
  out.oaDoc = y.explainErrorDoc(mk(429, "Rate limit reached"));
  GM_setValue("provider", "anthropic");
  out.an529 = y.explainError(mk(529, "Overloaded"));
  GM_setValue("provider", "deepseek");
  out.ds402 = y.explainError(mk(402, "Insufficient Balance"));
  out.dsDoc = y.explainErrorDoc(mk(401, "Authentication Fails"));
  out.ds403 = y.explainError(mk(403, "Forbidden"));
  return out;
});
check("v1.6.0 同一个 402：OpenAI 说配额、DeepSeek 说余额；新码 403 / 529 也有人话",
  /OpenAI/.test(v16f.oa402) && /DeepSeek 余额不足/.test(v16f.ds402)
  && /没权限/.test(v16f.ds403) && /过载/.test(v16f.an529)
  && v16f.dsDoc.startsWith("官方 ") && v16f.oaDoc.startsWith("OpenAI 官方 "),
  JSON.stringify(v16f));
check("v1.6.0 模型名写错时，提示直接指向「检测模型」",
  /检测模型/.test(v16f.oaModel) && /检测模型/.test(v16f.oa404), JSON.stringify([v16f.oaModel, v16f.oa404]));

// 38) 设置面板：服务商 / 协议 / 检测模型 / 图片模型，以及切换服务商时的联动
const v16g = await page.evaluate(() => {
  document.querySelectorAll(".yzj-mask").forEach((m) => m.remove());
  GM_setValue("provider", "deepseek"); GM_setValue("proto", "openai");
  window.__yzj.openSettings();
  const d = [...document.querySelectorAll(".yzj-dialog")].pop();
  const prov = d.querySelector("#yzj-prov"), proto = d.querySelector("#yzj-proto");
  return { opts: prov ? [...prov.options].map((o) => o.value) : [], provVal: prov ? prov.value : "",
           protoOpts: proto ? [...proto.options].map((o) => o.value) : [],
           hasDetect: !!d.querySelector('[data-a="models"]'), hasTest: !!d.querySelector('[data-a="testconn"]'),
           hasVision: !!d.querySelector("#yzj-modelvision"), hasKeyLink: !!d.querySelector("#yzj-keylink").innerHTML };
});
check("v1.6.0 设置面板：服务商下拉（十几家）+ 协议下拉 + 检测模型 + 测连通 + 图片模型",
  v16g.opts.length >= 12 && v16g.provVal === "deepseek" && v16g.protoOpts.join(",") === "openai,anthropic,gemini"
  && v16g.hasDetect && v16g.hasTest && v16g.hasVision && v16g.hasKeyLink, JSON.stringify(v16g));

const v16h = await page.evaluate(() => {
  const d = [...document.querySelectorAll(".yzj-dialog")].pop();
  const prov = d.querySelector("#yzj-prov");
  prov.value = "gemini";
  prov.dispatchEvent(new Event("change", { bubbles: true }));
  return { base: d.querySelector("#yzj-base").value, proto: d.querySelector("#yzj-proto").value,
           model: d.querySelector("#yzj-model").value, key: d.querySelector("#yzj-key").value };
});
check("v1.6.0 换服务商：协议 / 地址 / 模型自动跟着换，Key 也切到这家自己的（不串家）",
  /generativelanguage/.test(v16h.base) && v16h.proto === "gemini" && /gemini/.test(v16h.model) && v16h.key === "",
  JSON.stringify(v16h));

const v16i = await page.evaluate(() => {
  const d = [...document.querySelectorAll(".yzj-dialog")].pop();
  const key = d.querySelector("#yzj-key");
  const prov = d.querySelector("#yzj-prov");
  key.value = "sk-gemini-own";
  prov.value = "deepseek";
  prov.dispatchEvent(new Event("change", { bubbles: true }));
  const back = { base: d.querySelector("#yzj-base").value, proto: d.querySelector("#yzj-proto").value,
                 key: d.querySelector("#yzj-key").value };
  prov.value = "gemini";
  prov.dispatchEvent(new Event("change", { bubbles: true }));
  return { back, geminiKey: key.value };
});
check("v1.6.0 每家单独记配置：换回来还在（DeepSeek 的 Key 回来了，Gemini 刚才填的也留着）",
  v16i.back.key === "sk-test-key-0000000000000000000000" && v16i.back.proto === "openai"
  && /deepseek/.test(v16i.back.base) && v16i.geminiKey === "sk-gemini-own",
  JSON.stringify(v16i));

// 38b) 点模型清单里的条目 → 填进模型框
const v16j = await page.evaluate(async () => {
  const d = [...document.querySelectorAll(".yzj-dialog")].pop();
  d.querySelector("#yzj-prov").value = "deepseek";
  d.querySelector("#yzj-prov").dispatchEvent(new Event("change", { bubbles: true }));
  d.querySelector("#yzj-key").value = "sk-test-key-0000000000000000000000";
  window.__stub.modelList = { data: [{ id: "aaa" }, { id: "zzz-vl", architecture: { input_modalities: ["image"] } }] };
  d.querySelector('[data-a="models"]').click();
  await new Promise((r) => setTimeout(r, 150));
  const rows = d.querySelectorAll("#yzj-modellist .yzj-mrow");
  if (rows[0]) rows[0].click();                        // 能看图的那条排在第一位
  await new Promise((r) => setTimeout(r, 30));
  const out = { rows: rows.length, model: d.querySelector("#yzj-model").value,
                vision: d.querySelector("#yzj-modelvision").value,
                stat: d.querySelector("#yzj-modelstat").textContent };
  window.__stub.modelList = null;
  document.querySelectorAll(".yzj-mask").forEach((m) => m.remove());
  GM_setValue("provider", "deepseek"); GM_setValue("proto", "openai");
  GM_setValue("modelVision", ""); GM_setValue("model", "deepseek-flash");
  GM_setValue("baseUrl", "https://api.deepseek.com");
  GM_setValue("apiKey", "sk-test-key-0000000000000000000000");
  return out;
});
check("v1.6.0 点模型清单就把名字填进「模型」框，能看图的顺手也填成图片模型",
  v16j.rows === 2 && v16j.model === "zzz-vl" && v16j.vision === "zzz-vl" && /能看图/.test(v16j.stat),
  JSON.stringify(v16j));

// 39) v1.6.1 无人值守上限：字段在、能改、能存、重开还在；顶部有分区跳转
const v161a = await page.evaluate(() => {
  document.querySelectorAll(".yzj-mask").forEach((m) => m.remove());
  GM_setValue("unattended", true);
  GM_setValue("uaMaxTasks", 3);
  window.__yzj.openSettings();
  const d = [...document.querySelectorAll(".yzj-dialog")].pop();
  const chips = [...d.querySelectorAll(".yzj-secnav .yzj-btn")].map((x) => x.textContent);
  const ua = d.querySelector("#yzj-ua");
  const lbl0 = d.querySelector("#yzj-ualbl").textContent;
  ua.checked = true; ua.dispatchEvent(new Event("change", { bubbles: true }));
  const boxShown = getComputedStyle(d.querySelector("#yzj-uabox")).display !== "none";
  const inp = d.querySelector("#yzj-uamax");
  const before = inp ? inp.value : "(no input)";
  if (inp) {
    inp.value = "7";
    inp.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const lbl1 = d.querySelector("#yzj-ualbl").textContent;
  const inputRects = inp ? inp.getClientRects().length : 0;
  d.querySelector('[data-a="save"]').click();
  const saved = window.GM_getValue("uaMaxTasks", null);
  window.__yzj.openSettings();
  const d2 = [...document.querySelectorAll(".yzj-dialog")].pop();
  const after = d2.querySelector("#yzj-uamax") ? d2.querySelector("#yzj-uamax").value : "(no input)";
  document.querySelectorAll(".yzj-mask").forEach((m) => m.remove());
  GM_setValue("unattended", false);
  return { chips, before, boxShown, lbl0, lbl1, saved, after, inputRects };
});
check("v1.6.1 无人值守上限：字段在、能改、保存生效、重开还是 7（不再被迫默认 20）",
  v161a.before === "3" && v161a.saved === 7 && v161a.after === "7",
  JSON.stringify(v161a));
check("v1.6.1 无人值守：上限直接显示在开关标题上（折叠着也看得见），展开后输入框可见",
  /上限 3 套/.test(v161a.lbl0) && /上限 7 套/.test(v161a.lbl1)
  && v161a.boxShown && v161a.inputRects === 1,
  JSON.stringify([v161a.lbl0, v161a.lbl1, v161a.boxShown, v161a.inputRects]));
check("v1.6.1 设置面板顶部有分区跳转（手机上一键到「无人值守」）",
  v161a.chips.length >= 8 && v161a.chips.some((t) => t.includes("无人值守"))
  && v161a.chips.includes("AI 服务商"),
  JSON.stringify(v161a.chips));

// 40) v1.6.2 连线题题干为空时不能被当成"没题干"整套跳过
await reset("ok");
const v162a = await page.evaluate(async (task) => {
  const y = window.__yzj;
  window.__stub.paperMode = "line-nodesc";
  window.__stub.aiAnswerMode = "line";
  window.__stub.aiCalls = [];
  try {
    const j = await y.judgeTask(task);
    return { skipped: false, byNo: j.byNo, count: j.count, calls: window.__stub.aiCalls.length };
  } catch (e) {
    return { skipped: e.name === "SkipError", kind: e.kind, reason: e.reason || e.message,
             calls: window.__stub.aiCalls.length };
  }
}, TASK);
check("v1.6.2 连线题题干为空：不再整套跳过，按 1C#2A#3B 归一化",
  v162a.skipped === false && v162a.count === 49
  && String((v162a.byNo || {})[1] || "") === "1C#2A#3B" && v162a.calls === 5,
  JSON.stringify(v162a));

// 40b) 反过来：真的什么都没有（没题干、没选项、没图片）仍然要跳过，别去瞎问 AI
const v162b = await page.evaluate(async (task) => {
  const y = window.__yzj;
  window.__stub.paperMode = "line-nodesc-empty";
  window.__stub.aiCalls = [];
  try {
    await y.judgeTask(task);
    return { skipped: false, calls: window.__stub.aiCalls.length };
  } catch (e) {
    return { skipped: e.name === "SkipError", reason: e.reason || e.message, calls: window.__stub.aiCalls.length };
  }
}, TASK);
check("v1.6.2 空题（无题干/无选项/无图）仍然不调 AI、直接跳过",
  v162b.skipped === true && v162b.calls === 0 && /没有图片也没有题干/.test(v162b.reason || ""),
  JSON.stringify(v162b));

const bad = results.filter((x) => !x.ok);
console.log(`\n== 结果：${results.length - bad.length}/${results.length} 通过 ==`);
await ctx.close();
process.exit(bad.length ? 1 : 0);
