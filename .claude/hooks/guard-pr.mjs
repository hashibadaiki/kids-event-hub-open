#!/usr/bin/env node
// PreToolUse フック（Bash / GitHub MCP）: 開発ループの PR まわりの関門。
// - PR 作成: 本文に issue の紐付け（Closes / Fixes / Resolves #N）がなければ止める（deny）
// - PR マージ: 止めずに、マージしてよいかのチェックリストを Claude に渡す（additionalContext）。
//   CI グリーンなら Claude がマージしてよいという CLAUDE.md のルールに合わせ、要件・本番・運用ルールに触れる PR だけオーナーに回す
// 判定は PreToolUse の JSON（hookSpecificOutput）で返す。

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const LINK = /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#\d+/i;

const MERGE_CHECKLIST = [
  "マージする前に次を確認してください。1 と 3 を満たし、2 と 4 に当たらなければマージしてよい。2 か 4 に当たる場合はマージせず、オーナーに確認する:",
  "1. CI（typecheck → lint → test）がグリーンか",
  "2. issue の要件（ゴール）を変えたり緩めたりしていないか（PR 本文の「判断に迷った点」「未対応」）",
  "3. Reviewer サブエージェント（/review-pr）の指摘が解消されているか",
  "4. 運用ルール（CLAUDE.md・.claude/ の変更）や本番データに影響しないか。migration・デプロイなど「オーナー作業」は PR 本文に書いてあるか",
].join("\n");

/** 本文をファイルから読む指定（gh pr create --body-file / -F <path>、gh api -F body=@<path>）の中身 */
function bodyFileText(command) {
  const texts = [];
  for (const m of command.matchAll(/(?:--body-file|\s-F|--field)\s+("[^"]+"|'[^']+'|\S+)/g)) {
    let path = m[1].replace(/^["']|["']$/g, "");
    if (path.startsWith("body=@")) path = path.slice("body=@".length);
    if (path !== "-" && existsSync(path)) texts.push(readFileSync(path, "utf8"));
  }
  return texts.join("\n");
}

function isBashPrCreate(command) {
  if (/\bgh\s+pr\s+create\b/.test(command)) return true;
  // gh api repos/<o>/<r>/pulls（一覧取得の GET は除く。-f などのフィールド付きか -X POST なら作成）
  if (!/\bgh\s+api\b/.test(command) || !/repos\/[^\s/]+\/[^\s/]+\/pulls(?=[\s'"]|$)/.test(command)) return false;
  if (/(-X|--method)\s+GET\b/i.test(command)) return false;
  return /(-X|--method)\s+POST\b/i.test(command) || /\s-(f|F)\s|--(raw-)?field\s|--input\s/.test(command);
}

function isBashPrMerge(command) {
  return /\bgh\s+pr\s+merge\b/.test(command) || (/\bgh\s+api\b/.test(command) && /\/pulls\/\d+\/merge\b/.test(command));
}

const denyUnlinked = {
  decision: "deny",
  reason:
    "[guard-pr] PR 本文に issue の紐付け（`Closes #<番号>`）がありません。1 issue = 1 PR のルールに従い、本文の先頭に `Closes #<番号>` を書いてから作成してください。",
};
const mergeChecklist = { decision: "context", reason: `[guard-pr] ${MERGE_CHECKLIST}` };

/** 判定（{ decision, reason }）を返す。対象外なら null */
export function checkToolCall(input) {
  const name = input?.tool_name;
  const args = input?.tool_input ?? {};
  if (name === "mcp__github__create_pull_request") return LINK.test(args.body ?? "") ? null : denyUnlinked;
  if (name === "mcp__github__merge_pull_request") return mergeChecklist;
  if (name !== "Bash") return null;
  const command = String(args.command ?? "");
  if (isBashPrMerge(command)) return mergeChecklist;
  if (isBashPrCreate(command)) return LINK.test(command) || LINK.test(bodyFileText(command)) ? null : denyUnlinked;
  return null;
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return 0;
  }
  const result = checkToolCall(input);
  if (!result) return 0;
  const hookSpecificOutput =
    result.decision === "context"
      ? { hookEventName: "PreToolUse", additionalContext: result.reason }
      : { hookEventName: "PreToolUse", permissionDecision: result.decision, permissionDecisionReason: result.reason };
  process.stdout.write(JSON.stringify({ hookSpecificOutput }));
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
