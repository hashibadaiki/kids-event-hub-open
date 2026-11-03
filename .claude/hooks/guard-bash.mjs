#!/usr/bin/env node
// PreToolUse フック（Bash）: CLAUDE.md の「やらないこと」を機械的に止める。
// - オーナー作業の wrangler コマンド（deploy / login / secret / リソース作成 / --remote）
// - main への直接 push
// ブロック時は exit 2 + stderr に理由（Claude Code が Claude に理由を返す）。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OWNER_TASK = "はオーナーが手元で実行する作業です。必要なら PR 本文の「オーナー作業」に書いてください。";

// コマンドを実行する前に付くランチャー（pnpm exec wrangler など）
const LAUNCHERS = new Set(["pnpm", "exec", "dlx", "npx", "pnpx", "yarn", "bunx", "--"]);

function tokenize(segment) {
  return segment.trim().split(/\s+/).filter(Boolean);
}

/** 先頭のランチャーと環境変数代入を飛ばし、実行されるプログラム名以降を返す */
function invocation(tokens) {
  let i = 0;
  while (i < tokens.length && (LAUNCHERS.has(tokens[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) i++;
  return tokens.slice(i);
}

function checkWrangler(args) {
  const [sub, sub2] = args;
  const words = args.filter((a) => !a.startsWith("-"));
  if (["deploy", "publish", "login", "rollback"].includes(sub)) return `wrangler ${sub} ${OWNER_TASK}`;
  if (sub === "versions" && ["deploy", "upload"].includes(sub2)) return `wrangler versions ${sub2} ${OWNER_TASK}`;
  if (sub === "secret" && ["put", "bulk", "delete"].includes(sub2)) return `wrangler secret ${sub2} ${OWNER_TASK}`;
  const isLocalMigrationFile = sub === "d1" && sub2 === "migrations";
  if (words.includes("create") && !isLocalMigrationFile) return `Cloudflare リソースの作成（wrangler ${words.join(" ")}）${OWNER_TASK}`;
  if (args.includes("--remote")) return `本番 D1 への操作（--remote）${OWNER_TASK}`;
  return null;
}

function checkGitPush(args) {
  let i = 0;
  // git -C <path> push ... に対応
  while (i < args.length && args[i] !== "push") i += args[i] === "-C" ? 2 : 1;
  if (args[i] !== "push") return null;
  const positional = args.slice(i + 1).filter((a) => !a.startsWith("-"));
  const refspecs = positional.slice(1); // 先頭はリモート名
  for (const spec of refspecs) {
    const dst = spec.replace(/^\+/, "").split(":").pop();
    if (dst === "main" || dst === "refs/heads/main") {
      return "main への直接 push は禁止です。issue-<番号> ブランチに push して PR を作ってください。";
    }
  }
  return null;
}

/** ブロックすべきなら理由を、問題なければ null を返す */
export function checkCommand(command) {
  for (const segment of String(command).split(/&&|\|\||[;|\n]/)) {
    const [prog, ...args] = invocation(tokenize(segment));
    const reason = prog === "wrangler" ? checkWrangler(args) : prog === "git" ? checkGitPush(args) : null;
    if (reason) return reason;
  }
  return null;
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return 0; // 入力が読めないときは邪魔しない
  }
  if (input?.tool_name !== "Bash") return 0;
  const reason = checkCommand(input.tool_input?.command ?? "");
  if (!reason) return 0;
  process.stderr.write(`[guard-bash] ${reason}\n`);
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
