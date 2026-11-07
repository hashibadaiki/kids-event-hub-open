import { and, asc, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { ratio } from "./dashboard";
import { healthReports, sourceHealth, sources, type HealthAnomalyKind, RUN_STATUSES } from "./schema";

export const HEALTH_THRESHOLDS = {
  runLookbackHours: 26,
  baselineDays: 7,
  minBaselineDays: 3,
  failedDays: 2,
  countDropRatio: 0.5,
  rateDrop: 0.2,
  qualityDrop: 0.15,
} as const;

export const DEFAULT_ANOMALY_LIMIT = 200;
const MAX_ERROR_MESSAGE_LENGTH = 300;
const INSERT_CHUNK = 500;

type RunStatus = (typeof RUN_STATUSES)[number];

export type DayResult = {
  runId: number;
  status: Exclude<RunStatus, "running">;
  nothingNew: boolean;
  extractedCount: number;
  dateFoundCount: number;
  qualityScore: number | null;
};

export type HistoryDay = {
  date: string;
  runId: number | null;
  status: RunStatus | null;
  nothingNew: boolean;
  extractedCount: number;
  dateRate: number | null;
  qualityScore: number | null;
};

export type Judgement = {
  anomalies: HealthAnomalyKind[];
  consecutiveFailedDays: number;
  baselineExtractedCount: number | null;
  baselineDateRate: number | null;
  baselineQualityScore: number | null;
};

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const jstDate = (now: Date) => new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

const comparable = (h: HistoryDay) => (h.status === "success" || h.status === "partial") && !h.nothingNew;

const mean = (values: (number | null)[]): number | null => {
  const xs = values.filter((v): v is number => v !== null);
  return xs.length >= HEALTH_THRESHOLDS.minBaselineDays ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
};

export function judgeSource(date: string, today: DayResult | null, history: HistoryDay[]): Judgement {
  const past = history
    .filter((h) => h.date < date && (today === null || h.runId !== today.runId))
    .sort((a, b) => b.date.localeCompare(a.date));
  const base = past.filter(comparable);
  const baselineExtractedCount = mean(base.map((h) => h.extractedCount));
  const baselineDateRate = mean(base.map((h) => h.dateRate));
  const baselineQualityScore = mean(base.map((h) => h.qualityScore));
  const judged = (anomalies: HealthAnomalyKind[], consecutiveFailedDays = 0): Judgement => ({
    anomalies,
    consecutiveFailedDays,
    baselineExtractedCount,
    baselineDateRate,
    baselineQualityScore,
  });
  const dropped = (value: number | null, baseline: number | null, by: number) =>
    value !== null && baseline !== null && baseline - value >= by - 1e-9;

  if (today === null) return judged(["no_run"]);

  if (today.status === "failed") {
    let streak = 1;
    let expected = addDays(date, -1);
    for (const h of past) {
      if (h.date !== expected || h.status !== "failed") break;
      streak++;
      expected = addDays(expected, -1);
    }
    return judged(streak >= HEALTH_THRESHOLDS.failedDays ? ["failed"] : [], streak);
  }

  if (today.nothingNew) return judged([]);

  const anomalies: HealthAnomalyKind[] = [];
  if (today.extractedCount === 0) {
    if ((base[0]?.extractedCount ?? 0) > 0) anomalies.push("zero_events");
  } else if (baselineExtractedCount !== null && today.extractedCount < baselineExtractedCount * HEALTH_THRESHOLDS.countDropRatio) {
    anomalies.push("event_count_drop");
  }
  if (dropped(ratio(today.dateFoundCount, today.extractedCount), baselineDateRate, HEALTH_THRESHOLDS.rateDrop)) {
    anomalies.push("date_rate_drop");
  }
  if (dropped(today.qualityScore, baselineQualityScore, HEALTH_THRESHOLDS.qualityDrop)) anomalies.push("quality_drop");
  return judged(anomalies);
}

type LatestRun = {
  source_id: number;
  id: number;
  status: DayResult["status"];
  nothing_new: number;
  extracted_count: number;
  date_found_count: number;
  quality_score: number | null;
  error_message: string | null;
};

type SourceHealthInsert = typeof sourceHealth.$inferInsert;

export async function writeHealthReport(d1: D1Database, now: Date): Promise<{ date: string; anomalyCount: number }> {
  const db = drizzle(d1);
  const date = jstDate(now);
  const targets = await db
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.status, "approved"), eq(sources.enabled, true), sql`coalesce(${sources.policyStatus}, '') <> 'ng'`))
    .orderBy(asc(sources.id));

  const since = new Date(now.getTime() - HEALTH_THRESHOLDS.runLookbackHours * HOUR_MS).toISOString();
  const latest = await db.all<LatestRun>(sql`
    SELECT source_id, id, status, nothing_new, extracted_count, date_found_count, quality_score, error_message FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY started_at DESC, id DESC) AS rn
      FROM crawl_runs
      WHERE started_at >= ${since} AND started_at <= ${now.toISOString()} AND status <> 'running'
    ) WHERE rn = 1`);
  const runBySource = new Map(latest.map((r) => [r.source_id, r]));

  const historyRows = await db
    .select({
      sourceId: sourceHealth.sourceId,
      date: sourceHealth.date,
      runId: sourceHealth.runId,
      status: sourceHealth.status,
      nothingNew: sourceHealth.nothingNew,
      extractedCount: sourceHealth.extractedCount,
      dateRate: sourceHealth.dateRate,
      qualityScore: sourceHealth.qualityScore,
    })
    .from(sourceHealth)
    .where(and(gte(sourceHealth.date, addDays(date, -HEALTH_THRESHOLDS.baselineDays)), lt(sourceHealth.date, date)));
  const historyBySource = new Map<number, HistoryDay[]>();
  for (const { sourceId, ...h } of historyRows) {
    const list = historyBySource.get(sourceId) ?? [];
    list.push(h);
    historyBySource.set(sourceId, list);
  }

  const rows: SourceHealthInsert[] = [];
  const totals = { success: 0, partial: 0, failed: 0, noRun: 0, anomalies: 0, extracted: 0, dateFound: 0 };
  for (const { id: sourceId } of targets) {
    const run = runBySource.get(sourceId);
    const today: DayResult | null = run
      ? {
          runId: run.id,
          status: run.status,
          nothingNew: run.nothing_new === 1,
          extractedCount: run.extracted_count,
          dateFoundCount: run.date_found_count,
          qualityScore: run.quality_score,
        }
      : null;
    const j = judgeSource(date, today, historyBySource.get(sourceId) ?? []);

    if (today === null) totals.noRun++;
    else {
      totals[today.status]++;
      totals.extracted += today.extractedCount;
      totals.dateFound += today.dateFoundCount;
    }
    if (j.anomalies.length > 0) totals.anomalies++;

    rows.push({
      date,
      sourceId,
      runId: today?.runId ?? null,
      status: today?.status ?? null,
      nothingNew: today?.nothingNew ?? false,
      extractedCount: today?.extractedCount ?? 0,
      dateFoundCount: today?.dateFoundCount ?? 0,
      dateRate: today && ratio(today.dateFoundCount, today.extractedCount),
      baselineExtractedCount: j.baselineExtractedCount,
      baselineDateRate: j.baselineDateRate,
      qualityScore: today?.qualityScore ?? null,
      baselineQualityScore: j.baselineQualityScore,
      consecutiveFailedDays: j.consecutiveFailedDays,
      anomalies: j.anomalies.length > 0 ? j.anomalies : null,
      errorMessage: run?.error_message?.slice(0, MAX_ERROR_MESSAGE_LENGTH) ?? null,
    });
  }

  const statements: D1PreparedStatement[] = [d1.prepare("DELETE FROM source_health WHERE date = ?").bind(date)];
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows
      .slice(i, i + INSERT_CHUNK)
      .map((r) => ({ ...r, nothingNew: r.nothingNew ? 1 : 0, anomalies: r.anomalies ? JSON.stringify(r.anomalies) : null }));
    statements.push(
      d1
        .prepare(
          `INSERT INTO source_health (date, source_id, run_id, status, nothing_new, extracted_count, date_found_count,
             date_rate, baseline_extracted_count, baseline_date_rate, quality_score, baseline_quality_score,
             consecutive_failed_days, anomalies, error_message)
           SELECT j.value ->> '$.date', j.value ->> '$.sourceId', j.value ->> '$.runId', j.value ->> '$.status',
             j.value ->> '$.nothingNew', j.value ->> '$.extractedCount', j.value ->> '$.dateFoundCount',
             j.value ->> '$.dateRate', j.value ->> '$.baselineExtractedCount', j.value ->> '$.baselineDateRate',
             j.value ->> '$.qualityScore', j.value ->> '$.baselineQualityScore', j.value ->> '$.consecutiveFailedDays', j.value ->> '$.anomalies', j.value ->> '$.errorMessage'
           FROM json_each(?) AS j`,
        )
        .bind(JSON.stringify(chunk)),
    );
  }
  const report = {
    date,
    generated_at: now.toISOString(),
    target_sources: targets.length,
    ran_sources: targets.length - totals.noRun,
    success_count: totals.success,
    partial_count: totals.partial,
    failed_count: totals.failed,
    no_run_count: totals.noRun,
    anomaly_count: totals.anomalies,
    extracted_count: totals.extracted,
    date_found_count: totals.dateFound,
  };
  const cols = Object.keys(report);
  statements.push(
    d1
      .prepare(`INSERT OR REPLACE INTO health_reports (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
      .bind(...Object.values(report)),
  );
  await d1.batch(statements);
  return { date, anomalyCount: totals.anomalies };
}

export type HealthReportSummary = typeof healthReports.$inferSelect & { dateRate: number | null };

export type SourceAnomaly = {
  sourceId: number;
  sourceName: string;
  sourceUrl: string;
  prefecture: string;
  anomalies: HealthAnomalyKind[];
  status: RunStatus | null;
  runId: number | null;
  extractedCount: number;
  dateFoundCount: number;
  dateRate: number | null;
  baselineExtractedCount: number | null;
  baselineDateRate: number | null;
  qualityScore: number | null;
  baselineQualityScore: number | null;
  consecutiveFailedDays: number;
  errorMessage: string | null;
};

export type HealthReport = {
  date: string;
  status: "ok" | "anomaly" | "missing";
  report: HealthReportSummary | null;
  anomalies: SourceAnomaly[];
  anomaliesTruncated: boolean;
  thresholds: typeof HEALTH_THRESHOLDS;
};

export async function healthReport(
  db: DrizzleD1Database,
  date: string,
  { anomalyLimit = DEFAULT_ANOMALY_LIMIT }: { anomalyLimit?: number } = {},
): Promise<HealthReport> {
  const [row] = await db.select().from(healthReports).where(eq(healthReports.date, date));
  if (!row) {
    return { date, status: "missing", report: null, anomalies: [], anomaliesTruncated: false, thresholds: HEALTH_THRESHOLDS };
  }
  const found = await db
    .select({
      sourceId: sourceHealth.sourceId,
      sourceName: sources.name,
      sourceUrl: sources.url,
      prefecture: sources.prefecture,
      anomalies: sourceHealth.anomalies,
      status: sourceHealth.status,
      runId: sourceHealth.runId,
      extractedCount: sourceHealth.extractedCount,
      dateFoundCount: sourceHealth.dateFoundCount,
      dateRate: sourceHealth.dateRate,
      baselineExtractedCount: sourceHealth.baselineExtractedCount,
      baselineDateRate: sourceHealth.baselineDateRate,
      qualityScore: sourceHealth.qualityScore,
      baselineQualityScore: sourceHealth.baselineQualityScore,
      consecutiveFailedDays: sourceHealth.consecutiveFailedDays,
      errorMessage: sourceHealth.errorMessage,
    })
    .from(sourceHealth)
    .innerJoin(sources, eq(sourceHealth.sourceId, sources.id))
    .where(and(eq(sourceHealth.date, date), isNotNull(sourceHealth.anomalies)))
    .orderBy(asc(sourceHealth.sourceId))
    .limit(anomalyLimit + 1);
  return {
    date,
    status: row.anomalyCount > 0 ? "anomaly" : "ok",
    report: { ...row, dateRate: ratio(row.dateFoundCount, row.extractedCount) },
    anomalies: found.slice(0, anomalyLimit).map((a) => ({ ...a, anomalies: a.anomalies ?? [] })),
    anomaliesTruncated: found.length > anomalyLimit,
    thresholds: HEALTH_THRESHOLDS,
  };
}
