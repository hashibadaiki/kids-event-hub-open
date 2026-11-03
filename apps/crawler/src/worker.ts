import { createClaudeClient } from "./claude";
import { crawlAll } from "./crawl/run";
import { improveLowQuality } from "./improve/improve";

export type CrawlerEnv = {
  DB: D1Database;
  /** wrangler secret put ANTHROPIC_API_KEY（オーナーが設定）。未設定なら HTML の LLM 抽出は failed になる */
  ANTHROPIC_API_KEY?: string;
  CLAUDE_MODEL?: string;
};

/** Cron Trigger（1 日 1 回）でクロールする Worker */
export default {
  async scheduled(_controller, env, ctx) {
    const claude = env.ANTHROPIC_API_KEY
      ? createClaudeClient({ apiKey: env.ANTHROPIC_API_KEY, model: env.CLAUDE_MODEL || undefined })
      : null;
    const now = () => new Date();
    ctx.waitUntil(
      (async () => {
        const results = await crawlAll(env.DB, {
          fetch: (input, init) => fetch(input, init),
          claude,
          now,
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        });
        for (const r of results) {
          console.log(
            JSON.stringify({ source: r.sourceId, status: r.status, type: r.type, extracted: r.extracted, dateFound: r.dateFound, upserted: r.upserted, quality: r.quality?.score ?? null, error: r.error }),
          );
        }
        // 品質が閾値を下回った収集元は、Claude に抽出設定の改善案を出させて保存データで検証し、良ければ採用する
        for (const r of await improveLowQuality(env.DB, results, { claude, now })) {
          console.log(JSON.stringify({ improve: r.sourceId, decision: r.decision, reason: r.reason }));
        }
      })(),
    );
  },
} satisfies ExportedHandler<CrawlerEnv>;
