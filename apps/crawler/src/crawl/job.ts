import { improveLowQuality, type ImproveResult } from "../improve/improve";
import { crawlAll, type CrawlAllOptions, type CrawlDeps, type CrawlResult } from "./run";

export type CrawlJobHooks = {
  onResult?: (result: CrawlResult) => void | Promise<void>;
  onImprove?: (result: ImproveResult) => void | Promise<void>;
};

/** クロールし、品質が閾値を下回った収集元は抽出設定の改善案を出させて保存データで検証し、良ければ採用する（Cron と pnpm crawl-prod で共通） */
export async function runCrawlJob(
  db: D1Database,
  deps: CrawlDeps,
  options: Omit<CrawlAllOptions, "onResult"> = {},
  hooks: CrawlJobHooks = {},
): Promise<{ results: CrawlResult[]; improved: ImproveResult[] }> {
  const results = await crawlAll(db, deps, { ...options, onResult: hooks.onResult });
  const improved = await improveLowQuality(db, results, { claude: deps.claude, now: deps.now });
  for (const r of improved) await hooks.onImprove?.(r);
  return { results, improved };
}
