import { createClaudeClient } from "./claude";
import { crawlAll } from "./crawl/run";

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
    ctx.waitUntil(
      crawlAll(env.DB, {
        fetch: (input, init) => fetch(input, init),
        claude,
        now: () => new Date(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      }).then((results) => {
        for (const r of results) {
          console.log(
            JSON.stringify({ source: r.sourceId, status: r.status, type: r.type, extracted: r.extracted, dateFound: r.dateFound, upserted: r.upserted, error: r.error }),
          );
        }
      }),
    );
  },
} satisfies ExportedHandler<CrawlerEnv>;
