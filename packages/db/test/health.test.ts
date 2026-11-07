import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { HEALTH_THRESHOLDS, healthReport, judgeSource, writeHealthReport, type DayResult, type HistoryDay } from "../src/health";
import { crawlRuns, sources } from "../src/schema";

const db = drizzle(env.DB);

beforeEach(async () => {
  for (const t of ["source_health", "health_reports", "events", "crawl_runs", "extraction_configs", "sources", "facilities"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
});

let nextRunId = 1000;
const day = (date: string, over: Partial<HistoryDay> = {}): HistoryDay => ({
  date,
  runId: nextRunId++,
  status: "success",
  nothingNew: false,
  extractedCount: 40,
  dateRate: 0.9,
  ...over,
});
const today = (over: Partial<DayResult> = {}): DayResult => ({
  runId: 1,
  status: "success",
  nothingNew: false,
  extractedCount: 40,
  dateFoundCount: 36,
  ...over,
});
const week = [day("2026-11-06"), day("2026-11-05"), day("2026-11-04")];
const D = "2026-11-07";

describe("judgeSource", () => {
  it("直近の実行がなければ no_run", () => {
    expect(judgeSource(D, null, week).anomalies).toEqual(["no_run"]);
  });

  it(`failed は ${HEALTH_THRESHOLDS.failedDays} 日続いたら異常。1 日だけなら連続日数だけ返す`, () => {
    const failed = today({ status: "failed", extractedCount: 0, dateFoundCount: 0 });
    expect(judgeSource(D, failed, week)).toMatchObject({ anomalies: [], consecutiveFailedDays: 1 });
    const history = [day("2026-11-06", { status: "failed" }), day("2026-11-05", { status: "failed" }), day("2026-11-04")];
    expect(judgeSource(D, failed, history)).toMatchObject({ anomalies: ["failed"], consecutiveFailedDays: 3 });
  });

  it("連続失敗日数は日付が飛んだら数えない", () => {
    const failed = today({ status: "failed", extractedCount: 0, dateFoundCount: 0 });
    const gap = [day("2026-11-05", { status: "failed" }), day("2026-11-04", { status: "failed" })];
    expect(judgeSource(D, failed, gap)).toMatchObject({ anomalies: [], consecutiveFailedDays: 1 });
  });

  it("前日の集計と同じ実行は二重に数えない", () => {
    const failed = today({ runId: 77, status: "failed", extractedCount: 0, dateFoundCount: 0 });
    const history = [day("2026-11-06", { runId: 77, status: "failed" }), day("2026-11-05")];
    expect(judgeSource(D, failed, history)).toMatchObject({ anomalies: [], consecutiveFailedDays: 1 });
  });

  it("前回まで取れていたのに 0 件なら zero_events", () => {
    const zero = today({ extractedCount: 0, dateFoundCount: 0 });
    expect(judgeSource(D, zero, [day("2026-11-06", { status: "failed", extractedCount: 0 }), day("2026-11-05")]).anomalies).toEqual(["zero_events"]);
    expect(judgeSource(D, zero, [day("2026-11-06", { extractedCount: 0 })]).anomalies).toEqual([]);
    expect(judgeSource(D, zero, []).anomalies).toEqual([]);
  });

  it("新しい PDF がなかった実行（nothingNew）は件数・率を判定せず、平均にも入れない", () => {
    const quiet = today({ nothingNew: true, extractedCount: 0, dateFoundCount: 0 });
    expect(judgeSource(D, quiet, week).anomalies).toEqual([]);

    const afterQuiet = [day("2026-11-06", { nothingNew: true, extractedCount: 0, dateRate: null }), day("2026-11-05", { extractedCount: 0 })];
    expect(judgeSource(D, today({ extractedCount: 0, dateFoundCount: 0 }), afterQuiet).anomalies).toEqual([]);
  });

  it(`件数が過去の平均の ${HEALTH_THRESHOLDS.countDropRatio} 倍を下回ったら event_count_drop。少しの揺れでは出ない`, () => {
    expect(judgeSource(D, today({ extractedCount: 39, dateFoundCount: 35 }), week).anomalies).toEqual([]);
    expect(judgeSource(D, today({ extractedCount: 15, dateFoundCount: 14 }), week)).toMatchObject({
      anomalies: ["event_count_drop"],
      baselineExtractedCount: 40,
    });
  });

  it(`日付取得率が過去の平均から ${HEALTH_THRESHOLDS.rateDrop} 以上下がったら date_rate_drop`, () => {
    expect(judgeSource(D, today({ dateFoundCount: 24 }), week)).toMatchObject({
      anomalies: ["date_rate_drop"],
      baselineDateRate: expect.closeTo(0.9),
    });
    expect(judgeSource(D, today({ dateFoundCount: 30 }), week).anomalies).toEqual([]);
  });

  it(`比べる過去が ${HEALTH_THRESHOLDS.minBaselineDays} 日に満たなければ件数・率の低下は判定しない`, () => {
    const j = judgeSource(D, today({ extractedCount: 1, dateFoundCount: 0 }), week.slice(0, 2));
    expect(j).toMatchObject({ anomalies: [], baselineExtractedCount: null, baselineDateRate: null });
  });

  it("failed の日は平均に入れない", () => {
    const history = [day("2026-11-06", { status: "failed", extractedCount: 0, dateRate: null }), ...week.slice(1), day("2026-11-03")];
    expect(judgeSource(D, today(), history)).toMatchObject({ anomalies: [], baselineExtractedCount: 40 });
  });
});

async function insertSource(overrides: Partial<typeof sources.$inferInsert> = {}) {
  const [row] = await db
    .insert(sources)
    .values({ name: "x", url: `https://example.jp/${crypto.randomUUID()}`, type: "html", prefecture: "香川県", status: "approved", ...overrides })
    .returning();
  return row!;
}

async function insertRun(sourceId: number, startedAt: Date | string, over: Partial<typeof crawlRuns.$inferInsert> = {}) {
  await db.insert(crawlRuns).values({
    sourceId,
    status: "success",
    startedAt: typeof startedAt === "string" ? startedAt : startedAt.toISOString(),
    fetchedCount: 1,
    extractedCount: 40,
    dateFoundCount: 36,
    ...over,
  });
}

const jst = (date: string, time: string) => new Date(`${date}T${time}:00+09:00`);
const summaryAt = (date: string) => jst(date, "06:30");
const failedRun = { status: "failed" as const, fetchedCount: 0, extractedCount: 0, dateFoundCount: 0 };

describe("writeHealthReport / healthReport", () => {
  it(`直近 ${HEALTH_THRESHOLDS.runLookbackHours} 時間の最後の実行で集計し、異常のある収集元だけ返す`, async () => {
    const good = await insertSource({ name: "良い" });
    const noon = await insertSource({ name: "前日 12 時に取得" });
    const broken = await insertSource({ name: "壊れた", url: "https://example.jp/broken" });
    const silent = await insertSource({ name: "走らなかった" });
    await insertSource({ name: "無効", enabled: false });
    await insertSource({ name: "禁止", policyStatus: "ng" });

    await insertRun(good.id, jst("2026-11-07", "03:00"));
    await insertRun(noon.id, jst("2026-11-06", "12:05"));
    await insertRun(broken.id, jst("2026-11-06", "03:00"), { ...failedRun, errorMessage: "HTTP 503" });
    await insertRun(broken.id, jst("2026-11-07", "03:00"), { ...failedRun, errorMessage: "HTTP 500" });
    await insertRun(silent.id, jst("2026-11-06", "04:00"));

    await writeHealthReport(env.DB, summaryAt("2026-11-06"));
    await writeHealthReport(env.DB, summaryAt("2026-11-07"));
    const r = await healthReport(db, "2026-11-07");

    expect(r.status).toBe("anomaly");
    expect(r.report).toMatchObject({
      date: "2026-11-07",
      targetSources: 4,
      ranSources: 3,
      successCount: 2,
      partialCount: 0,
      failedCount: 1,
      noRunCount: 1,
      anomalyCount: 2,
      extractedCount: 80,
      dateRate: 0.9,
    });
    const byName = Object.fromEntries(r.anomalies.map((a) => [a.sourceName, a]));
    expect(Object.keys(byName).sort()).toEqual(["壊れた", "走らなかった"]);
    expect(byName["壊れた"]).toMatchObject({
      sourceUrl: "https://example.jp/broken",
      anomalies: ["failed"],
      status: "failed",
      consecutiveFailedDays: 2,
      errorMessage: "HTTP 500",
    });
    expect(byName["走らなかった"]).toMatchObject({ anomalies: ["no_run"], status: null });
  });

  it("前日までの集計と比べて件数・日付取得率の低下を検出する。新しい PDF がない日は外す", async () => {
    const s = await insertSource({ name: "落ちた" });
    const pdf = await insertSource({ name: "PDF 一覧", type: "pdf" });
    for (const d of ["04", "05", "06"]) {
      await insertRun(s.id, jst(`2026-11-${d}`, "03:00"));
      await insertRun(pdf.id, jst(`2026-11-${d}`, "03:00"), { extractedCount: 12, dateFoundCount: 12 });
      await writeHealthReport(env.DB, summaryAt(`2026-11-${d}`));
    }
    await insertRun(s.id, jst("2026-11-07", "03:00"), { extractedCount: 40, dateFoundCount: 20 });
    await insertRun(pdf.id, jst("2026-11-07", "03:00"), { extractedCount: 0, dateFoundCount: 0, nothingNew: true });
    await writeHealthReport(env.DB, summaryAt("2026-11-07"));

    const r = await healthReport(db, "2026-11-07");
    expect(r.anomalies).toEqual([
      expect.objectContaining({ sourceName: "落ちた", anomalies: ["date_rate_drop"], dateRate: 0.5, baselineDateRate: expect.closeTo(0.9) }),
    ]);
  });

  it("同じ日に書き直すと置き換える", async () => {
    const s = await insertSource();
    await writeHealthReport(env.DB, summaryAt("2026-11-07"));
    expect((await healthReport(db, "2026-11-07")).status).toBe("anomaly");

    await insertRun(s.id, jst("2026-11-07", "12:00"));
    await writeHealthReport(env.DB, jst("2026-11-07", "12:30"));
    const r = await healthReport(db, "2026-11-07");
    expect(r).toMatchObject({ status: "ok", anomalies: [] });
    expect(r.report).toMatchObject({ successCount: 1, noRunCount: 0, anomalyCount: 0 });
  });

  it("その日の集計がなければ missing（Cron が走っていない）", async () => {
    const r = await healthReport(db, "2026-11-07");
    expect(r).toMatchObject({ date: "2026-11-07", status: "missing", report: null, anomalies: [] });
  });

  it("異常は上限件数で切り、切ったことを返す", async () => {
    for (let i = 0; i < 3; i++) await insertSource();
    await writeHealthReport(env.DB, summaryAt("2026-11-07"));
    const r = await healthReport(db, "2026-11-07", { anomalyLimit: 2 });
    expect(r.anomalies).toHaveLength(2);
    expect(r.anomaliesTruncated).toBe(true);
    expect(r.report?.anomalyCount).toBe(3);
  });

  it("1 文で入れる行数を超える収集元でも全部書く。長いエラーメッセージは切る", async () => {
    const values = Array.from({ length: 501 }, (_, i) => ({
      name: `s${i}`,
      url: `https://example.jp/many/${i}`,
      type: "html" as const,
      prefecture: "香川県",
      status: "approved" as const,
    }));
    for (let i = 0; i < values.length; i += 10) await db.insert(sources).values(values.slice(i, i + 10));
    const [first] = await db.select().from(sources).limit(1);
    await insertRun(first!.id, jst("2026-11-07", "03:00"), { ...failedRun, errorMessage: "あ".repeat(5000) });

    await writeHealthReport(env.DB, summaryAt("2026-11-07"));
    const r = await healthReport(db, "2026-11-07", { anomalyLimit: 1000 });
    expect(r.report).toMatchObject({ targetSources: 501, noRunCount: 500, failedCount: 1, anomalyCount: 500 });
    const count = await env.DB.prepare("SELECT count(*) AS n, max(length(error_message)) AS len FROM source_health").first<{ n: number; len: number }>();
    expect(count).toEqual({ n: 501, len: 300 });
  });
});
