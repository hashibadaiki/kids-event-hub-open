// 手元の Node から本番 D1 に（remote binding で）つなぎ、クロールと自動改善を 1 回だけ実行する（本番 D1 に書き込む。オーナーが実行する）
// 使い方: pnpm crawl-prod [--source <id> ...] [--local]
//   引数なし       クロール対象の全収集元を、間隔の制限（成功から 20 時間 / 直前から 6 時間）なしで今すぐ取る
//   --source <id>  その収集元だけ取る（複数指定可）
//   --local        本番ではなく、ローカル D1（apps/web と共通）に向ける。動作確認用
// 事前に wrangler login 済みであること。ANTHROPIC_API_KEY は apps/crawler/.dev.vars から読む
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import { createClaudeClient } from "../src/claude";
import { parseCrawlProdArgs } from "../src/crawl/adhoc";
import { runCrawlJob } from "../src/crawl/job";
import type { CrawlerEnv } from "../src/worker";

let parsed: ReturnType<typeof parseCrawlProdArgs>;
try {
  parsed = parseCrawlProdArgs(process.argv.slice(2));
} catch (e) {
  console.error((e as Error).message);
  console.error("使い方: pnpm crawl-prod [--source <id> ...] [--local]");
  process.exit(1);
}
const { local, options } = parsed;

const dir = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const proxy = await getPlatformProxy<CrawlerEnv>(
  local
    ? { configPath: dir("../wrangler.jsonc"), remoteBindings: false, persist: { path: dir("../../web/.wrangler/state/v3") } }
    : { configPath: dir("../wrangler.prod.jsonc"), remoteBindings: true },
);

try {
  const { env } = proxy;
  const apiKey = env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) console.error("ANTHROPIC_API_KEY が未設定です。HTML・PDF の抽出は failed になります");
  const claude = apiKey ? createClaudeClient({ apiKey, model: env.CLAUDE_MODEL || process.env.CLAUDE_MODEL || undefined }) : null;

  const names = new Map(
    (await env.DB.prepare("SELECT id, name FROM sources").all<{ id: number; name: string }>()).results.map((s) => [s.id, s.name]),
  );
  const target = options.sourceIds ? `収集元 ${options.sourceIds.join(", ")}` : "全収集元";
  console.log(`${local ? "ローカル" : "本番"} D1 に向けてクロールします（${target}。間隔の制限なし）`);

  const started = Date.now();
  const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;
  const { results } = await runCrawlJob(
    env.DB,
    { fetch, claude, now: () => new Date(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
    options,
    {
      onResult: (r) => {
        const counts = `抽出 ${r.extracted} / 日付あり ${r.dateFound} / 保存 ${r.upserted}`;
        const quality = r.quality ? ` / 品質 ${r.quality.score.toFixed(2)}` : "";
        console.log(`[${elapsed()}] ${r.sourceId} ${names.get(r.sourceId) ?? ""}: ${r.status}（${counts}${quality}）${r.error ? `\n    ${r.error}` : ""}`);
      },
      onImprove: (r) => console.log(`[${elapsed()}] 自動改善 ${r.sourceId} ${names.get(r.sourceId) ?? ""}: ${r.decision}（${r.reason}）`),
    },
  );

  const failed = results.filter((r) => r.status === "failed").length;
  console.log(`\n完了（${elapsed()}）: ${results.length} 件をクロール、うち failed ${failed} 件`);
  if (options.sourceIds) {
    const skipped = options.sourceIds.filter((id) => !results.some((r) => r.sourceId === id));
    if (skipped.length) console.log(`クロール対象外（未承認・無効・policy が ng・存在しない）: ${skipped.join(", ")}`);
  }
} finally {
  await proxy.dispose();
}
