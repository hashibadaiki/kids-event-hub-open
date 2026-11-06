import { createClaudeClient } from "./claude";
import { runCrawlJob } from "./crawl/job";

export type CrawlerEnv = {
  DB: D1Database;
  /** wrangler secret put ANTHROPIC_API_KEY（オーナーが設定）。未設定なら HTML の LLM 抽出は failed になる */
  ANTHROPIC_API_KEY?: string;
  CLAUDE_MODEL?: string;
};

/** Cron Trigger でクロールする Worker。03:00 JST に全収集元、12:00 JST は最後の成功から 20 時間以上あいた収集元（直前に失敗したもの・未取得のもの）の取り直し（対象は crawlAll が選ぶ） */
export default {
  async scheduled(_controller, env, ctx) {
    const claude = env.ANTHROPIC_API_KEY
      ? createClaudeClient({ apiKey: env.ANTHROPIC_API_KEY, model: env.CLAUDE_MODEL || undefined })
      : null;
    ctx.waitUntil(
      runCrawlJob(
        env.DB,
        {
          fetch: (input, init) => fetch(input, init),
          claude,
          now: () => new Date(),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        },
        {},
        {
          onResult: (r) =>
            console.log(
              JSON.stringify({ source: r.sourceId, status: r.status, type: r.type, extracted: r.extracted, dateFound: r.dateFound, upserted: r.upserted, quality: r.quality?.score ?? null, error: r.error }),
            ),
          onImprove: (r) => console.log(JSON.stringify({ improve: r.sourceId, decision: r.decision, reason: r.reason })),
        },
      ),
    );
  },
} satisfies ExportedHandler<CrawlerEnv>;
