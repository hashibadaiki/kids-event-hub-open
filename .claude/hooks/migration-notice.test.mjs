import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isMigrationPath } from "./migration-notice.mjs";

const hook = fileURLToPath(new URL("./migration-notice.mjs", import.meta.url));

test("スキーマと migration のファイルを検出する", () => {
  for (const p of [
    "/home/user/repo/packages/db/src/schema.ts",
    "packages/db/migrations/0003_x.sql",
    "/w/kids-event-hub-issue-9/packages/db/migrations/meta/_journal.json",
  ]) {
    assert.equal(isMigrationPath(p), true, p);
  }
  for (const p of ["packages/db/src/queries.ts", "apps/web/src/app.tsx", "docs/data-model.md", ""]) {
    assert.equal(isMigrationPath(p), false, p);
  }
});

test("migration を編集したら注意事項を Claude に返す", () => {
  const r = spawnSync("node", [hook], {
    input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/r/packages/db/migrations/0003_x.sql" } }),
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(out.hookSpecificOutput.additionalContext, /pnpm generate/);
  assert.match(out.hookSpecificOutput.additionalContext, /--remote/);
  assert.match(out.hookSpecificOutput.additionalContext, /オーナー作業/);
});

test("関係ないファイルでは何も出さない", () => {
  const r = spawnSync("node", [hook], {
    input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "/r/README.md" } }),
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});
