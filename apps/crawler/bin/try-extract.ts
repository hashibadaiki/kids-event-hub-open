// 収集元の URL を取得・抽出して結果を表示する。DB には書き込まない
// 使い方: pnpm try-extract <URL> [type]（type は sources.yaml と同じ。一覧ページから PDF をたどるなら pdf）
// ANTHROPIC_API_KEY が必要（PDF・HTML の抽出と要約に使う）
import { createClaudeClient } from "../src/claude";
import { toEventRow } from "../src/crawl/normalize";
import { collect } from "../src/crawl/run";

const [url, type] = process.argv.slice(2);
if (!url) {
  console.error("使い方: pnpm try-extract <URL> [type]");
  process.exit(1);
}
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) console.error("ANTHROPIC_API_KEY が未設定です。JSON-LD / iCal / RSS 以外は抽出できません\n");

try {
  const now = new Date();
  const out = await collect(
    { url, type },
    {
      fetch,
      claude: apiKey ? createClaudeClient({ apiKey, model: process.env.CLAUDE_MODEL || undefined }) : null,
      now: () => now,
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    },
  );
  const rows = out.raws.map((r) => ({ raw: r, row: toEventRow(r, { prefecture: "（確認用）", sourceUrl: url, referenceDate: now }) }));
  for (const { raw, row } of rows) {
    const when = row ? `${row.startAt}${row.endAt ? ` 〜 ${row.endAt}` : ""}` : `日付が取れない（${raw.dateText ?? "記載なし"}）`;
    console.log(`- ${when}  ${raw.title}`);
    for (const [k, v] of [["会場", raw.venue], ["対象", raw.ageText], ["料金", raw.priceText], ["申込", raw.applyText], ["要約", raw.summary], ["掲載元", raw.url]]) {
      if (v) console.log(`    ${k}: ${v}`);
    }
  }
  const dated = rows.filter((r) => r.row).length;
  console.log(`\n種別: ${out.type} / 取得した文書: ${out.fetched} / 抽出: ${out.raws.length} 件 / 日付が取れた: ${dated} 件（${out.raws.length ? Math.round((dated / out.raws.length) * 100) : 0}%）`);
  for (const m of [...out.skipped, ...out.warnings]) console.log(`注意: ${m}`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
