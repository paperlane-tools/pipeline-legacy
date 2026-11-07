#!/usr/bin/env node
/**
 * browser.mjs —— 让程序自己把浏览器拉起来（不再需要人工先开好 Chrome）
 *
 *   node scripts/browser.mjs status           # 看 9222 是否已经在监听
 *   node scripts/browser.mjs ensure           # 没起就起一个（默认无头）
 *   node scripts/browser.mjs ensure --headful # 带界面启动（需要人工登录时用）
 *
 * 关键点：必须用「非默认」的 --user-data-dir（Chrome 136+ 会忽略默认配置目录上的调试端口），
 * 这里固定用 <项目根>\browser-profile，和登录态无关——登录态由 sessionStorage 注入（见 get_session.mjs）。
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = process.env.YZJ_ROOT || path.dirname(SCRIPTS_DIR);
export const PROFILE_DIR = process.env.YZJ_BROWSER_PROFILE || path.join(PROJECT_ROOT, "browser-profile");
const CHROME = process.env.YZJ_CHROME ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(port, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** 确保有一个带调试端口的浏览器；返回 {launched, port, version} */
export async function ensureBrowser({ port = 9222, headless = true, timeoutMs = 45000 } = {}) {
  const alive = await probe(port);
  if (alive) return { launched: false, port, version: alive.Browser };

  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--no-default-browser-check",
    "--disable-features=Translate",
    ...(headless ? ["--headless=new", "--disable-gpu"] : []),
    "about:blank",
  ];
  const child = spawn(CHROME, chromeArgs, { detached: true, stdio: "ignore" });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(700);
    const info = await probe(port);
    if (info) return { launched: true, port, version: info.Browser, pid: child.pid };
  }
  throw new Error(`启动 Chrome 后 ${timeoutMs}ms 内没等到调试端口 ${port}（profile: ${PROFILE_DIR}）`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const cmd = process.argv[2] || "ensure";
  const headless = !process.argv.includes("--headful");
  if (cmd === "status") {
    const info = await probe(9222);
    console.log(info ? `9222 已就绪：${info.Browser}` : "9222 未监听");
    process.exit(info ? 0 : 1);
  }
  const r = await ensureBrowser({ headless });
  console.log(r.launched
    ? `已启动 Chrome（pid=${r.pid}，profile=${PROFILE_DIR}，headless=${headless}）→ ${r.version}`
    : `复用已有的浏览器 → ${r.version}`);
  process.exit(0);
}
