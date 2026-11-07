import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { HEALTH_THRESHOLDS, healthReport, judgeSource, writeHealthReport, type HistoryDay } from "../src/health";
import { crawlRuns, sources } from "../src/schema";

const db = drizzle(env.DB);

beforeEach(async () => {
  for (const t of ["source_health", "health_reports", "events", "crawl_runs", "extraction_configs", "sources", "facilities"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
});

const ok = (date: string, over: Partial<HistoryDay> = {}): HistoryDay => ({
  date,
  status: "success",
  extractedCount: 10,
  extractionRate: 1,
  dateRate: 0.9,
  ...over,
});

describe("judgeSource", () => {
  it("当日の実行がなければ no_run", () => {
    expect(judgeSource(null, [ok("2026-11-06")]).anomalies).toEqual(["no_run"]);
  });

  it("当日が failed なら failed。前日から続いていれば連続日数を数える", () => {
    const failed = { status: "failed" as const, fetchedCount: 0, extractedCount: 0, dateFoundCount: 0 };
    expect(judgeSource(failed, [ok("2026-11-06")])).toMatchObject({ anomalies: ["failed"], consecutiveFailedDays: 1 });
    const history = [ok("2026-11-06", { status: "failed" }), ok("2026-11-05", { status: "failed" }), ok("2026-11-04")];
    expect(judgeSource(failed, history)).toMatchObject({ anomalies: ["failed"], consecutiveFailedDays: 3 });
  });

  it("前回まで取れていたのに 0 件なら zero_events", () => {
    const zero = { status: "success" as const, fetchedCount: 3, extractedCount: 0, dateFoundCount: 0 };
    expect(judgeSource(zero, [ok("2026-11-06", { status: "failed", extractedCount: 0 }), ok("2026-11-05")]).anomalies).toContain(
      "zero_events",
    );
    expect(judgeSource(zero, [ok("2026-11-06", { extractedCount: 0 })]).anomalies).not.toContain("zero_events");
    expect(judgeSource(zero, []).anomalies).toEqual([]);
  });

  it("日付取得率・抽出成功率が過去の平均からしきい値以上下がったら検出する", () => {
    const history = [ok("2026-11-06"), ok("2026-11-05"), ok("2026-11-04")];
    const today = { status: "success" as const, fetchedCount: 10, extractedCount: 10, dateFoundCount: 6 };
    const j = judgeSource(today, history);
    expect(j.baselineDateRate).toBeCloseTo(0.9);
    expect(j.anomalies).toEqual(["date_rate_drop"]);

    const slight = { ...today, dateFoundCount: 8 };
    expect(judgeSource(slight, history).anomalies).toEqual([]);

    const lowExtraction = { status: "success" as const, fetchedCount: 10, extractedCount: 5, dateFoundCount: 5 };
    expect(judgeSource(lowExtraction, history).anomalies).toEqual(["extraction_rate_drop"]);
  });

  it(`比べる過去が ${HEALTH_THRESHOLDS.minBaselineDays} 日に満たなければ率の低下は判定しない`, () => {
    const today = { status: "success" as const, fetchedCount: 10, extractedCount: 10, dateFoundCount: 1 };
    const j = judgeSource(today, [ok("2026-11-06"), ok("2026-11-05")]);
    expect(j.anomalies).toEqual([]);
    expect(j.baselineDateRate).toBeNull();
  });

  it("failed の日は平均に入れない", () => {
    const history = [ok("2026-11-06", { status: "failed", dateRate: null, extractionRate: null }), ok("2026-11-05"), ok("2026-11-04"), ok("2026-11-03")];
    const today = { status: "success" as const, fetchedCount: 10, extractedCount: 10, dateFoundCount: 9 };
    expect(judgeSource(today, history)).toMatchObject({ anomalies: [], baselineDateRate: expect.closeTo(0.9) });
  });
});

async function insertSource(overrides: Partial<typeof sources.$inferInsert> = {}) {
  const [row] = await db
    .insert(sources)
    .values({
      name: "x",
      url: `https://example.jp/${crypto.randomUUID()}`,
      type: "html",
      prefecture: "香川県",
      status: "approved",
      ...overrides,
    })
    .returning();
  return row!;
}

async function insertRun(sourceId: number, startedAt: string, over: Partial<typeof crawlRuns.$inferInsert> = {}) {
  await db.insert(crawlRuns).values({
    sourceId,
    status: "success",
    startedAt,
    fetchedCount: 10,
    extractedCount: 10,
    dateFoundCount: 9,
    ...over,
  });
}

/** 03:30 JST */
const at = (date: string) => new Date(`${date}T03:30:00+09:00`);

describe("writeHealthReport / healthReport", () => {
  it("JST のその日の最後の実行で集計し、異常のある収集元だけ返す", async () => {
    const good = await insertSource({ name: "良い" });
    const broken = await insertSource({ name: "壊れた", url: "https://example.jp/broken" });
    const silent = await insertSource({ name: "走らなかった" });
    await insertSource({ name: "無効", enabled: false });
    await insertSource({ name: "禁止", policyStatus: "ng" });

    await insertRun(good.id, "2026-11-06T18:00:00.000Z");
    await insertRun(broken.id, "2026-11-06T18:01:00.000Z", { status: "failed", fetchedCount: 0, extractedCount: 0, dateFoundCount: 0, errorMessage: "HTTP 503" });
    await insertRun(broken.id, "2026-11-07T03:00:00.000Z", { status: "failed", fetchedCount: 0, extractedCount: 0, dateFoundCount: 0, errorMessage: "HTTP 500" });
    await insertRun(silent.id, "2026-11-06T14:59:00.000Z");

    await writeHealthReport(env.DB, at("2026-11-07"));
    const r = await healthReport(db, "2026-11-07");

    expect(r.status).toBe("anomaly");
    expect(r.report).toMatchObject({
      date: "2026-11-07",
      targetSources: 3,
      ranSources: 2,
      successCount: 1,
      partialCount: 0,
      failedCount: 1,
      noRunCount: 1,
      anomalyCount: 2,
      extractionRate: 1,
      dateRate: 0.9,
    });
    expect(r.anomalies).toHaveLength(2);
    const byName = Object.fromEntries(r.anomalies.map((a) => [a.sourceName, a]));
    expect(byName["壊れた"]).toMatchObject({
      sourceUrl: "https://example.jp/broken",
      anomalies: ["failed"],
      status: "failed",
      consecutiveFailedDays: 1,
      errorMessage: "HTTP 500",
    });
    expect(byName["走らなかった"]).toMatchObject({ anomalies: ["no_run"], status: null });
  });

  it("前日までの集計と比べて率の低下を検出し、連続失敗を数える", async () => {
    const s = await insertSource({ name: "落ちた" });
    const f = await insertSource({ name: "ずっと失敗" });
    for (const d of ["03", "04", "05", "06"]) {
      await insertRun(s.id, `2026-11-${d}T18:00:00.000Z`);
      await insertRun(f.id, `2026-11-${d}T18:00:00.000Z`, { status: "failed", extractedCount: 0, dateFoundCount: 0 });
      await writeHealthReport(env.DB, at(`2026-11-0${Number(d) + 1}`));
    }
    await insertRun(s.id, "2026-11-07T18:00:00.000Z", { dateFoundCount: 4 });
    await insertRun(f.id, "2026-11-07T18:00:00.000Z", { status: "failed", extractedCount: 0, dateFoundCount: 0 });
    await writeHealthReport(env.DB, at("2026-11-08"));

    const r = await healthReport(db, "2026-11-08");
    const byName = Object.fromEntries(r.anomalies.map((a) => [a.sourceName, a]));
    expect(byName["落ちた"]).toMatchObject({ anomalies: ["date_rate_drop"], dateRate: 0.4, baselineDateRate: expect.closeTo(0.9) });
    expect(byName["ずっと失敗"]).toMatchObject({ anomalies: ["failed"], consecutiveFailedDays: 5 });
  });

  it("同じ日に 2 回書くと置き換える（12:00 の取り直しで直った収集元は異常から外れる）", async () => {
    const s = await insertSource();
    await insertRun(s.id, "2026-11-06T18:00:00.000Z", { status: "failed", extractedCount: 0, dateFoundCount: 0 });
    await writeHealthReport(env.DB, at("2026-11-07"));
    expect((await healthReport(db, "2026-11-07")).status).toBe("anomaly");

    await insertRun(s.id, "2026-11-07T03:00:00.000Z");
    await writeHealthReport(env.DB, new Date("2026-11-07T12:30:00+09:00"));
    const r = await healthReport(db, "2026-11-07");
    expect(r.status).toBe("ok");
    expect(r.anomalies).toEqual([]);
    expect(r.report).toMatchObject({ successCount: 1, failedCount: 0, anomalyCount: 0 });
  });

  it("その日の集計がなければ missing（Cron が走っていない）", async () => {
    const r = await healthReport(db, "2026-11-07");
    expect(r).toMatchObject({ date: "2026-11-07", status: "missing", report: null, anomalies: [] });
  });

  it("異常は上限件数で切り、切ったことを返す", async () => {
    for (let i = 0; i < 3; i++) await insertSource();
    await writeHealthReport(env.DB, at("2026-11-07"));
    const r = await healthReport(db, "2026-11-07", { anomalyLimit: 2 });
    expect(r.anomalies).toHaveLength(2);
    expect(r.anomaliesTruncated).toBe(true);
    expect(r.report?.anomalyCount).toBe(3);
  });
});
