import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import cronConfig from "../wrangler.jsonc?raw";
import worker, { HEALTH_CRON } from "../src/worker";

beforeEach(async () => {
  for (const t of ["source_health", "health_reports", "crawl_runs", "sources"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

async function fire(cron: string, scheduledTime: Date) {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {}, props: {} };
  await worker.scheduled({ cron, scheduledTime: scheduledTime.getTime(), noRetry: () => {} } as ScheduledController, { DB: env.DB }, ctx as unknown as ExecutionContext);
  await Promise.all(pending);
}

describe("scheduled", () => {
  it("健全性の Cron が wrangler.jsonc の Cron Trigger に入っている", () => {
    expect(cronConfig).toContain(`"${HEALTH_CRON}"`);
  });

  it("健全性の Cron ではクロールせず、日次サマリーだけ書く", async () => {
    await env.DB.prepare(
      "INSERT INTO sources (name, url, type, prefecture, status) VALUES ('高松市', 'https://example.jp/t', 'html', '香川県', 'approved')",
    ).run();
    await fire(HEALTH_CRON, new Date("2026-11-07T06:30:00+09:00"));

    const runs = await env.DB.prepare("SELECT count(*) AS n FROM crawl_runs").first<{ n: number }>();
    expect(runs!.n).toBe(0);
    const report = await env.DB.prepare("SELECT date, target_sources, no_run_count FROM health_reports").all();
    expect(report.results).toEqual([{ date: "2026-11-07", target_sources: 1, no_run_count: 1 }]);
  });
});
