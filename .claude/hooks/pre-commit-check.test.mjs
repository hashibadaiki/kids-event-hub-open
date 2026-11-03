import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isGitCommit } from "./pre-commit-check.mjs";

const hook = fileURLToPath(new URL("./pre-commit-check.mjs", import.meta.url));

function run(input, env = {}) {
  return spawnSync("node", [hook], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, ...env } });
}

test("git commit を検出する", () => {
  for (const cmd of [
    "git commit -m 'feat: x'",
    "git add -A && git commit -m x",
    "git -C ../wt commit -m x",
    "git -c user.name=a commit --amend --no-edit",
    "cd apps/web && git commit",
  ]) {
    assert.equal(isGitCommit(cmd), true, cmd);
  }
});

test("git commit 以外は対象外", () => {
  for (const cmd of ["git status", "git log --grep commit", "echo git commit", "git push -u origin issue-12", "pnpm test"]) {
    assert.equal(isGitCommit(cmd), false, cmd);
  }
});

test("チェックが失敗したら exit 2 でコミットを止め、理由を返す", () => {
  const r = run({ tool_name: "Bash", tool_input: { command: "git commit -m x" } }, { PRECOMMIT_CHECK_CMD: "echo 'lint error' && false" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /pre-commit-check/);
  assert.match(r.stderr, /lint error/);
});

test("チェックが通ればそのままコミットさせる", () => {
  const r = run({ tool_name: "Bash", tool_input: { command: "git commit -m x" } }, { PRECOMMIT_CHECK_CMD: "true" });
  assert.equal(r.status, 0);
});

test("コミット以外のコマンドではチェックを走らせない", () => {
  const r = run({ tool_name: "Bash", tool_input: { command: "ls" } }, { PRECOMMIT_CHECK_CMD: "false" });
  assert.equal(r.status, 0);
});
