/**
 * runtime.mjs —— 自动定位 Codex 自带的 node 运行时（版本号会随更新变化，不要写死）
 *
 * 优先用环境变量 YZJ_RUNTIME 指定的 bin 目录；否则扫描
 * %LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\*\bin，取最新修改的那个。
 */

import fs from "node:fs";
import path from "node:path";

export function runtimeBins() {
  const out = [];
  if (process.env.YZJ_RUNTIME) out.push(process.env.YZJ_RUNTIME);
  const base = path.join(process.env.LOCALAPPDATA || "", "OpenAI", "Codex", "runtimes", "cua_node");
  try {
    for (const d of fs.readdirSync(base)) {
      const bin = path.join(base, d, "bin");
      if (fs.existsSync(path.join(bin, "node.exe")) && fs.existsSync(path.join(bin, "node_modules"))) {
        out.push(bin);
      }
    }
  } catch { /* 目录不存在时忽略 */ }
  try {
    out.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  } catch { /* ignore */ }
  return out;
}

/** 传给 createRequire 的 base（带结尾斜杠） */
export function moduleDirs() {
  return runtimeBins().map((b) => b.replace(/\\/g, "/") + "/");
}

export function nodeExe() {
  const bin = runtimeBins()[0];
  return bin ? path.join(bin, "node.exe") : "node";
}
