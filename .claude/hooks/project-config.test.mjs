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

test("スキルが定義されている", () => {
  for (const name of ["add-source", "crawl", "improve", "review-pr"]) {
    const fm = frontmatter(read(`.claude/skills/${name}/SKILL.md`));
    assert.equal(fm?.name, name);
    assert.ok(fm.description, `${name} の description`);
  }
});

test("MCP の検索サーバーを Claude Code に登録している", () => {
  const mcp = JSON.parse(read(".mcp.json"));
  const server = mcp.mcpServers["kids-event-hub"];
  assert.equal(server.type, "http");
  assert.match(server.url, /^https:\/\/.+\/mcp$/);
});
