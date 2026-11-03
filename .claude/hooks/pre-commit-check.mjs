#!/usr/bin/env node
// PreToolUse フック（Bash）: git commit の前に CI と同じチェック（typecheck → lint → test）を走らせる。
// 失敗したら exit 2 + stderr に出力の末尾を返してコミットを止める（Claude が直してからコミットし直す）。
// テスト用に PRECOMMIT_CHECK_CMD で実行するコマンドを差し替えられる。

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_CHECK = "pnpm typecheck && pnpm lint && pnpm test";
const LAUNCHERS = new Set(["command", "env", "--"]);

/** コマンド列に git commit が含まれるか */
export function isGitCommit(command) {
  for (const segment of String(command).split(/&&|\|\||[;|\n]/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length && (LAUNCHERS.has(tokens[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) i++;
    if (tokens[i] !== "git") continue;
    i++;
    // git -C <path> / -c key=value などのグローバルオプションを飛ばす
    while (i < tokens.length && tokens[i].startsWith("-")) i += ["-C", "-c"].includes(tokens[i]) ? 2 : 1;
    if (tokens[i] === "commit") return true;
  }
  return false;
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return 0;
  }
  if (input?.tool_name !== "Bash" || !isGitCommit(input.tool_input?.command ?? "")) return 0;
  const check = process.env.PRECOMMIT_CHECK_CMD || DEFAULT_CHECK;
  const r = spawnSync(check, {
    shell: true,
    cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status === 0) return 0;
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-40).join("\n");
  process.stderr.write(`[pre-commit-check] コミット前のチェック（${check}）が失敗しました。直してからコミットしてください。\n${output}\n`);
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
