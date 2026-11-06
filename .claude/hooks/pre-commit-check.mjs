#!/usr/bin/env node
// PreToolUse フック（Bash）: git commit の前に CI と同じチェック（typecheck → lint → test）を走らせる。
// チェックはコミットするリポジトリ（worktree）のルートで走らせる: 入力の cwd（無ければ process.cwd()）に
// コマンド先頭の `cd <path> &&` と `git -C <path>` を適用した場所から `git rev-parse --show-toplevel` で求める。
// CLAUDE_PROJECT_DIR は共有チェックアウトを指すので、チェックの cwd には使わない。
// 失敗したら exit 2 + stderr に出力の末尾を返してコミットを止める（Claude が直してからコミットし直す）。
// テスト用に PRECOMMIT_CHECK_CMD で実行するコマンドを差し替えられる。

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
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

function leadingCd(command) {
  const m = /^\s*cd\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))\s*(?:&&|;|\n)/.exec(String(command));
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

function gitDashC(command) {
  for (const segment of String(command).split(/&&|\|\||[;|\n]/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length && (LAUNCHERS.has(tokens[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) i++;
    if (tokens[i] !== "git") continue;
    for (i++; i < tokens.length && tokens[i].startsWith("-"); i += ["-C", "-c"].includes(tokens[i]) ? 2 : 1) {
      if (tokens[i] === "-C" && tokens[i + 1]) return tokens[i + 1].replace(/^["']|["']$/g, "");
    }
  }
  return null;
}

export function commitRepoRoot(input) {
  const command = input.tool_input?.command ?? "";
  const start = resolve(input.cwd || process.cwd(), leadingCd(command) ?? ".", gitDashC(command) ?? ".");
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: start, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : start;
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
  const cwd = commitRepoRoot(input);
  const r = spawnSync(check, {
    shell: true,
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status === 0) return 0;
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error?.message ?? ""}`.trim().split("\n").slice(-40).join("\n");
  process.stderr.write(`[pre-commit-check] コミット前のチェック（${check}。実行場所: ${cwd}）が失敗しました。直してからコミットしてください。\n${output}\n`);
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
