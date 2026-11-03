import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkCommand } from "./guard-bash.mjs";

const hook = fileURLToPath(new URL("./guard-bash.mjs", import.meta.url));

test("オーナー作業の wrangler コマンドをブロックする", () => {
  for (const cmd of [
    "wrangler deploy",
    "pnpm exec wrangler deploy",
    "cd apps/web && npx wrangler deploy --env production",
    "wrangler login",
    "wrangler secret put ANTHROPIC_API_KEY",
    "echo x | wrangler secret bulk secrets.json",
    "wrangler d1 create kids-event-hub",
    "wrangler kv namespace create CACHE",
    "wrangler r2 bucket create pdfs",
    "wrangler queues create crawl",
    "wrangler d1 migrations apply kids-event-hub --remote",
    "wrangler d1 execute kids-event-hub --remote --command 'select 1'",
  ]) {
    assert.notEqual(checkCommand(cmd), null, cmd);
  }
});

test("main への push をブロックする", () => {
  for (const cmd of [
    "git push origin main",
    "git push -u origin main",
    "git push origin HEAD:main",
    "git push origin issue-3:refs/heads/main",
    "git push --force origin main",
  ]) {
    assert.notEqual(checkCommand(cmd), null, cmd);
  }
});

test("通常の開発コマンドは通す", () => {
  for (const cmd of [
    "pnpm test",
    "pnpm exec wrangler dev",
    "wrangler d1 migrations apply kids-event-hub --local",
    "wrangler d1 execute kids-event-hub --local --command 'select 1'",
    "git push -u origin issue-3",
    "git push origin issue-12-maintenance",
    "git fetch origin main",
    "git checkout -b issue-3 origin/main",
    "grep -r 'wrangler deploy' README.md",
  ]) {
    assert.equal(checkCommand(cmd), null, cmd);
  }
});

function runHook(input) {
  return spawnSync(process.execPath, [hook], { input: JSON.stringify(input), encoding: "utf8" });
}

test("フックとして実行するとブロック時は exit 2 で理由を stderr に出す", () => {
  const res = runHook({ tool_name: "Bash", tool_input: { command: "wrangler deploy" } });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /オーナー/);
});

test("フックとして実行すると許可時は exit 0", () => {
  const res = runHook({ tool_name: "Bash", tool_input: { command: "pnpm test" } });
  assert.equal(res.status, 0);
});

test("Bash 以外や壊れた入力は素通しする", () => {
  assert.equal(runHook({ tool_name: "Read", tool_input: { file_path: "x" } }).status, 0);
  const res = spawnSync(process.execPath, [hook], { input: "not json", encoding: "utf8" });
  assert.equal(res.status, 0);
});
