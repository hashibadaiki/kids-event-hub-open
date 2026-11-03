import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkToolCall } from "./guard-pr.mjs";

const hook = fileURLToPath(new URL("./guard-pr.mjs", import.meta.url));
const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });

test("issue 番号の紐付けがない PR 作成は止める", () => {
  for (const input of [
    bash("gh pr create --base main --title x --body '変更点だけ'"),
    bash("gh api -X POST repos/o/r/pulls -f title=x -f head=issue-3 -f base=main -f body='説明 #3 関連'"),
    { tool_name: "mcp__github__create_pull_request", tool_input: { title: "x", body: "変更点" } },
  ]) {
    assert.equal(checkToolCall(input)?.decision, "deny", JSON.stringify(input));
  }
});

test("Closes #N がある PR 作成は通す", () => {
  for (const input of [
    bash("gh pr create --base main --title x --body 'Closes #12\n\n変更点'"),
    bash("gh api repos/o/r/pulls -f title=x -f body='Fixes #3'"),
    { tool_name: "mcp__github__create_pull_request", tool_input: { title: "x", body: "resolves #7" } },
  ]) {
    assert.equal(checkToolCall(input), null, JSON.stringify(input));
  }
});

test("--body-file の中身も見る", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-pr-"));
  const ok = join(dir, "ok.md");
  const ng = join(dir, "ng.md");
  writeFileSync(ok, "Closes #12\n");
  writeFileSync(ng, "説明のみ\n");
  assert.equal(checkToolCall(bash(`gh pr create --title x --body-file ${ok}`)), null);
  assert.equal(checkToolCall(bash(`gh pr create --title x -F ${ng}`))?.decision, "deny");
  assert.equal(checkToolCall(bash(`gh api -X POST repos/o/r/pulls -f title=x -F body=@${ok}`)), null);
  assert.equal(checkToolCall(bash(`gh api repos/o/r/pulls -f title=x --field "body=@${ng}"`))?.decision, "deny");
});

test("マージの前に人間の確認を求める", () => {
  for (const input of [
    bash("gh pr merge 32 --merge"),
    bash("gh api -X PUT repos/o/r/pulls/32/merge -f merge_method=merge"),
    { tool_name: "mcp__github__merge_pull_request", tool_input: { owner: "o", repo: "r", pullNumber: 32 } },
  ]) {
    const r = checkToolCall(input);
    assert.equal(r?.decision, "ask", JSON.stringify(input));
    assert.match(r.reason, /CI/);
    assert.match(r.reason, /要件/);
  }
});

test("PR の閲覧などは対象外", () => {
  for (const input of [
    bash("gh api repos/o/r/pulls?state=open"),
    bash("gh api repos/o/r/pulls/32/files"),
    bash("gh pr view 32"),
    bash("git commit -m 'merge main'"),
    { tool_name: "mcp__github__pull_request_read", tool_input: {} },
  ]) {
    assert.equal(checkToolCall(input), null, JSON.stringify(input));
  }
});

test("判定を PreToolUse の JSON で返す", () => {
  const r = spawnSync("node", [hook], { input: JSON.stringify(bash("gh pr merge 1")), encoding: "utf8" });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, "PreToolUse");
  assert.equal(out.permissionDecision, "ask");
  const none = spawnSync("node", [hook], { input: JSON.stringify(bash("ls")), encoding: "utf8" });
  assert.equal(none.stdout, "");
});
