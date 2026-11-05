import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isGitCommit } from "./pre-commit-check.mjs";

const hook = fileURLToPath(new URL("./pre-commit-check.mjs", import.meta.url));

function run(input, env = {}) {
  return spawnSync("node", [hook], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, ...env } });
}

const sandbox = mkdtempSync(join(tmpdir(), "pre-commit-check-"));
after(() => rmSync(sandbox, { recursive: true, force: true }));

function makeRepo(name) {
  const root = join(sandbox, name);
  mkdirSync(join(root, "sub"), { recursive: true });
  const init = spawnSync("git", ["init", "-q", root], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  return { root: realpathSync(root), sub: realpathSync(join(root, "sub")) };
}

function runRecordingCwd(input, env = {}) {
  const record = join(sandbox, `cwd-${Math.random().toString(36).slice(2)}.txt`);
  const r = run(input, { ...env, PRECOMMIT_CHECK_CMD: `pwd -P > '${record}'` });
  assert.equal(r.status, 0, r.stderr);
  return realpathSync(readFileSync(record, "utf8").trim());
}

const elsewhere = realpathSync(mkdtempSync(join(sandbox, "elsewhere-")));
const commit = (command, cwd) => ({ tool_name: "Bash", tool_input: { command }, ...(cwd ? { cwd } : {}) });

test("入力の cwd があるリポジトリのルートでチェックを走らせる（CLAUDE_PROJECT_DIR は使わない）", () => {
  const repo = makeRepo("by-cwd");
  const recorded = runRecordingCwd(commit("git commit -m x", repo.sub), { CLAUDE_PROJECT_DIR: elsewhere });
  assert.equal(recorded, repo.root);
});

test("cwd が無ければコマンド先頭の cd <path> のリポジトリのルートを使う", () => {
  const repo = makeRepo("by-cd");
  const recorded = runRecordingCwd(commit(`cd ${repo.sub} && git commit -m x`), { CLAUDE_PROJECT_DIR: elsewhere });
  assert.equal(recorded, repo.root);
});

test("cwd があっても先頭の cd <絶対パス> が指す worktree を優先する", () => {
  const repo = makeRepo("cd-over-cwd");
  const recorded = runRecordingCwd(commit(`cd "${repo.sub}" && git commit -m x`, elsewhere), { CLAUDE_PROJECT_DIR: elsewhere });
  assert.equal(recorded, repo.root);
});

test("先頭の cd <相対パス> は cwd から解決する", () => {
  const repo = makeRepo("cd-relative");
  const recorded = runRecordingCwd(commit("cd sub && git commit -m x", repo.root), { CLAUDE_PROJECT_DIR: elsewhere });
  assert.equal(recorded, repo.root);
});

test("git リポジトリでなければ起点のディレクトリをそのまま使う", () => {
  const plain = realpathSync(mkdtempSync(join(sandbox, "plain-")));
  const recorded = runRecordingCwd(commit("git commit -m x", plain), { CLAUDE_PROJECT_DIR: elsewhere });
  assert.equal(recorded, plain);
});

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
