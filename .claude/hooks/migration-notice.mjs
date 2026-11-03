#!/usr/bin/env node
// PostToolUse フック（Edit / Write）: D1 のスキーマ・migration を変えたときに注意事項を Claude に返す。
// 止めはしない（additionalContext で伝えるだけ）。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const NOTICE = [
  "[migration-notice] D1 のスキーマ / migration を変更しました。次を確認してください:",
  "- migration は手で書かず `cd packages/db && pnpm generate` で schema.ts から生成する（生成済みの SQL・meta を手で直さない）",
  "- 既存の列・テーブルの削除や型変更は本番データに影響する。必要ならオーナーに確認してから進める（マージもしない）",
  "- 他の open PR が同じ番号の migration を追加していないか確認する（後からマージする側で pnpm generate し直す）",
  "- docs/data-model.md を更新し、テスト（packages/db/test）を足す",
  "- PR 本文の「オーナー作業」に `pnpm exec wrangler d1 migrations apply kids-event-hub --remote` を、デプロイより先に実行するよう書く（自分では --remote を実行しない）",
].join("\n");

/** packages/db の schema.ts または migrations 配下か */
export function isMigrationPath(path) {
  return /(^|\/)packages\/db\/(src\/schema\.ts$|migrations\/)/.test(String(path));
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return 0;
  }
  if (!isMigrationPath(input?.tool_input?.file_path ?? "")) return 0;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: NOTICE } }),
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
