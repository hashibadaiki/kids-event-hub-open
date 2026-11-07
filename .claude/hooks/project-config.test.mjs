// .claude/ の設定一式（フックの登録・サブエージェント・スキル・MCP）が揃っているかのテスト
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (p) => readFileSync(root + p, "utf8");

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  return Object.fromEntries(
    m[1].split("\n").map((line) => line.match(/^([a-z-]+):\s*(.*)$/)).filter(Boolean).map((x) => [x[1], x[2]]),
  );
}

test("フックが settings.json に登録されている", () => {
  const settings = JSON.parse(read(".claude/settings.json"));
  const commands = (event) => (settings.hooks[event] ?? []).flatMap((h) => h.hooks.map((x) => x.command)).join("\n");
  for (const name of ["guard-bash.mjs", "pre-commit-check.mjs", "guard-pr.mjs"]) {
    assert.match(commands("PreToolUse"), new RegExp(name.replace(".", "\\.")), name);
    assert.ok(existsSync(root + ".claude/hooks/" + name), name);
  }
  assert.match(commands("PostToolUse"), /migration-notice\.mjs/);
  const prMatcher = settings.hooks.PreToolUse.find((h) => h.hooks.some((x) => x.command.includes("guard-pr.mjs"))).matcher;
  assert.match(prMatcher, /mcp__github__merge_pull_request/);
  assert.match(prMatcher, /mcp__github__create_pull_request/);
});

test("サブエージェントが定義されている", () => {
  for (const name of ["planner", "implementer", "reviewer", "improver", "verifier"]) {
    const fm = frontmatter(read(`.claude/agents/${name}.md`));
    assert.equal(fm?.name, name);
    assert.ok(fm.description, `${name} の description`);
  }
});

test("レビュー役と検証役は書き込みツールを持たない", () => {
  for (const name of ["reviewer", "verifier"]) {
    const tools = frontmatter(read(`.claude/agents/${name}.md`)).tools ?? "";
    assert.ok(tools, `${name} は tools を絞る`);
    assert.doesNotMatch(tools, /\b(Edit|Write)\b/, name);
  }
});

test("レビュー役は PR のブランチに切り替えず、PR のコードを手元で実行しない", () => {
  const reviewer = read(".claude/agents/reviewer.md");
  assert.doesNotMatch(reviewer, /git\s+(switch|checkout|worktree)\b/);
  assert.doesNotMatch(reviewer, /\b(pnpm|npm)\s+(i|install|add|ci|typecheck|lint|test|run|exec|dlx)\b|\bnpx\s/);
  assert.match(reviewer, /check-runs/);
});

test("スキルが定義されている", () => {
  for (const name of ["add-source", "crawl", "improve", "review-pr"]) {
    const fm = frontmatter(read(`.claude/skills/${name}/SKILL.md`));
    assert.equal(fm?.name, name);
    assert.ok(fm.description, `${name} の description`);
  }
});

test("ローカルのクローラーは sync-sources と同じ apps/web のローカル D1 を使う", () => {
  const dev = JSON.parse(read("apps/crawler/package.json")).scripts.dev;
  assert.match(dev, /--test-scheduled/);
  assert.match(dev, /--persist-to \.\.\/web\/\.wrangler\/state(\s|$)/);
});

test("apps/web と apps/crawler は同じ D1 database_id を使う", () => {
  const ids = ["apps/web/wrangler.jsonc", "apps/crawler/wrangler.jsonc"].map(
    (p) => read(p).match(/"database_id"\s*:\s*"([^"]+)"/)?.[1],
  );
  assert.ok(ids[0]);
  assert.equal(ids[1], ids[0]);
});

test("スキルのローカル D1 への SQL は apps/web で実行する", () => {
  for (const name of ["add-source", "crawl"]) {
    for (const line of read(`.claude/skills/${name}/SKILL.md`).split("\n")) {
      if (!/wrangler d1 execute/.test(line)) continue;
      assert.match(line, /cd apps\/web && pnpm exec wrangler d1 execute/, `${name}: ${line.trim()}`);
    }
  }
});

test("MCP の検索サーバーを Claude Code に登録している", () => {
  const mcp = JSON.parse(read(".mcp.json"));
  const server = mcp.mcpServers["kids-event-hub"];
  assert.equal(server.type, "http");
  assert.match(server.url, /^https:\/\/.+\/mcp$/);
});
