// 収集元の robots.txt・利用規約を確認して policy_status を提案する。書き込みはしない
// 使い方: pnpm check-policy <URL>
// ANTHROPIC_API_KEY が環境変数にあれば規約ページを Claude で読む（なければ caution の提案になる）
import { createClaudeClient } from "../src/claude";
import { checkPolicy } from "../src/crawl/policy";

const url = process.argv[2];
if (!url) {
  console.error("使い方: pnpm check-policy <URL>");
  process.exit(1);
}
const apiKey = process.env.ANTHROPIC_API_KEY;
try {
  const r = await checkPolicy(url, {
    fetch,
    claude: apiKey ? createClaudeClient({ apiKey, model: process.env.CLAUDE_MODEL || undefined }) : null,
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
  });
  console.log(`robots.txt: ${r.robots.allowed ? "許可" : `禁止（${r.robots.rule}）`}${r.robots.crawlDelaySec !== null ? ` / Crawl-delay ${r.robots.crawlDelaySec}` : ""}`);
  console.log(`規約ページ: ${r.policyUrls.length > 0 ? r.policyUrls.join(" ") : "見つからない"}`);
  for (const f of r.findings) console.log(`  - ${f.url}: ${f.automatedAccess}（${f.summary}）`);
  console.log(`\n提案: ${r.proposed}（確定はオーナー）\n`);
  console.log(["    policy:", `      status: ${r.proposed}`, `      checked_at: "${new Date().toISOString().slice(0, 10)}"`, `      note: ${JSON.stringify(r.note)}`].join("\n"));
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
