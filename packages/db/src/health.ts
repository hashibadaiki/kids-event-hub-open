import { and, asc, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { ratio } from "./dashboard";
import { healthReports, sourceHealth, sources, type HealthAnomalyKind, RUN_STATUSES } from "./schema";


export const HEALTH_THRESHOLDS = {
  baselineDays: 7,
  minBaselineDays: 3,
  rateDrop: 0.2,
} as const;

export const DEFAULT_ANOMALY_LIMIT = 200;

type RunStatus = (typeof RUN_STATUSES)[number];

export type DayResult = {
  status: Exclude<RunStatus, "running">;
  fetchedCount: number;
  extractedCount: number;
  dateFoundCount: number;
};
export type HistoryDay = {
  date: string;
  status: RunStatus | null;
  extractedCount: number;
  extractionRate: number | null;
  dateRate: number | null;
};

export type Judgement = {
  anomalies: HealthAnomalyKind[];
  consecutiveFailedDays: number;
  baselineExtractionRate: number | null;
  baselineDateRate: number | null;
};

const succeeded = (s: RunStatus | null) => s === "success" || s === "partial";

const mean = (values: (number | null)[]): number | null => {
  const xs = values.filter((v): v is number => v !== null);
  return xs.length >= HEALTH_THRESHOLDS.minBaselineDays ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
};

const dropped = (today: number | null, baseline: number | null) =>
  today !== null && baseline !== null && baseline - today >= HEALTH_THRESHOLDS.rateDrop - 1e-9;
export function judgeSource(today: DayResult | null, history: HistoryDay[]): Judgement {
  const past = history.filter((h) => succeeded(h.status));
  const baselineExtractionRate = mean(past.map((h) => h.extractionRate));
  const baselineDateRate = mean(past.map((h) => h.dateRate));
  const base = { baselineExtractionRate, baselineDateRate };

  if (today === null) return { anomalies: ["no_run"], consecutiveFailedDays: 0, ...base };

  if (today.status === "failed") {
    let streak = 1;
    for (const h of history) {
      if (h.status !== "failed") break;
      streak++;
    }
    return { anomalies: ["failed"], consecutiveFailedDays: streak, ...base };
  }

  const anomalies: HealthAnomalyKind[] = [];
  if (today.extractedCount === 0 && (past[0]?.extractedCount ?? 0) > 0) anomalies.push("zero_events");
  if (dropped(ratio(today.dateFoundCount, today.extractedCount), baselineDateRate)) anomalies.push("date_rate_drop");
  if (dropped(ratio(today.extractedCount, today.fetchedCount), baselineExtractionRate)) anomalies.push("extraction_rate_drop");
  return { anomalies, consecutiveFailedDays: 0, ...base };
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const jstDate = (now: Date) => new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const jstStartUtc = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - JST_OFFSET_MS).toISOString();

type LatestRun = {
  source_id: number;
  id: number;
  status: DayResult["status"];
  fetched_count: number;
  extracted_count: number;
  date_found_count: number;
  error_message: string | null;
};

type SourceHealthInsert = typeof sourceHealth.$inferInsert;
const INSERT_CHUNK = 500;
export async function writeHealthReport(d1: D1Database, now: Date): Promise<{ date: string; anomalyCount: number }> {
  const db = drizzle(d1);
  const date = jstDate(now);
  const targets = await db
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.status, "approved"), eq(sources.enabled, true), sql`coalesce(${sources.policyStatus}, '') <> 'ng'`))
    .orderBy(asc(sources.id));

  const latest = await db.all<LatestRun>(sql`
    SELECT source_id, id, status, fetched_count, extracted_count, date_found_count, error_message FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY started_at DESC, id DESC) AS rn
      FROM crawl_runs
      WHERE started_at >= ${jstStartUtc(date)} AND started_at < ${jstStartUtc(addDays(date, 1))} AND status <> 'running'
    ) WHERE rn = 1`);
  const runBySource = new Map(latest.map((r) => [r.source_id, r]));

  const historyRows = await db
    .select({
      sourceId: sourceHealth.sourceId,
      date: sourceHealth.date,
      status: sourceHealth.status,
      extractedCount: sourceHealth.extractedCount,
      extractionRate: sourceHealth.extractionRate,
      dateRate: sourceHealth.dateRate,
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
  const totals = { success: 0, partial: 0, failed: 0, noRun: 0, anomalies: 0, fetched: 0, extracted: 0, dateFound: 0 };
  for (const { id: sourceId } of targets) {
    const run = runBySource.get(sourceId) ?? null;
    const today: DayResult | null = run && {
      status: run.status,
      fetchedCount: run.fetched_count,
      extractedCount: run.extracted_count,
      dateFoundCount: run.date_found_count,
    };
    const history = (historyBySource.get(sourceId) ?? []).sort((a, b) => b.date.localeCompare(a.date));
    const j = judgeSource(today, history);

    if (today === null) totals.noRun++;
    else {
      totals[today.status]++;
      totals.fetched += today.fetchedCount;
      totals.extracted += today.extractedCount;
      totals.dateFound += today.dateFoundCount;
    }
    if (j.anomalies.length > 0) totals.anomalies++;

    rows.push({
      date,
      sourceId,
      runId: run?.id ?? null,
      status: today?.status ?? null,
      fetchedCount: today?.fetchedCount ?? 0,
      extractedCount: today?.extractedCount ?? 0,
      dateFoundCount: today?.dateFoundCount ?? 0,
      extractionRate: today && ratio(today.extractedCount, today.fetchedCount),
      dateRate: today && ratio(today.dateFoundCount, today.extractedCount),
      baselineExtractionRate: j.baselineExtractionRate,
      baselineDateRate: j.baselineDateRate,
      consecutiveFailedDays: j.consecutiveFailedDays,
      anomalies: j.anomalies.length > 0 ? j.anomalies : null,
      errorMessage: run?.error_message ?? null,
    });
  }

  const statements: D1PreparedStatement[] = [d1.prepare("DELETE FROM source_health WHERE date = ?").bind(date)];
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK).map((r) => ({ ...r, anomalies: r.anomalies ? JSON.stringify(r.anomalies) : null }));
    statements.push(
      d1
        .prepare(
          `INSERT INTO source_health (date, source_id, run_id, status, fetched_count, extracted_count, date_found_count,
             extraction_rate, date_rate, baseline_extraction_rate, baseline_date_rate, consecutive_failed_days, anomalies, error_message)
           SELECT j.value ->> '$.date', j.value ->> '$.sourceId', j.value ->> '$.runId', j.value ->> '$.status',
             j.value ->> '$.fetchedCount', j.value ->> '$.extractedCount', j.value ->> '$.dateFoundCount',
             j.value ->> '$.extractionRate', j.value ->> '$.dateRate', j.value ->> '$.baselineExtractionRate',
             j.value ->> '$.baselineDateRate', j.value ->> '$.consecutiveFailedDays', j.value ->> '$.anomalies', j.value ->> '$.errorMessage'
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
    fetched_count: totals.fetched,
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

export type HealthReportSummary = typeof healthReports.$inferSelect & {
  extractionRate: number | null;
  dateRate: number | null;
};

export type SourceAnomaly = {
  sourceId: number;
  sourceName: string;
  sourceUrl: string;
  prefecture: string;
  anomalies: HealthAnomalyKind[];
  status: RunStatus | null;
  runId: number | null;
  fetchedCount: number;
  extractedCount: number;
  dateFoundCount: number;
  extractionRate: number | null;
  dateRate: number | null;
  baselineExtractionRate: number | null;
  baselineDateRate: number | null;
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
      fetchedCount: sourceHealth.fetchedCount,
      extractedCount: sourceHealth.extractedCount,
      dateFoundCount: sourceHealth.dateFoundCount,
      extractionRate: sourceHealth.extractionRate,
      dateRate: sourceHealth.dateRate,
      baselineExtractionRate: sourceHealth.baselineExtractionRate,
      baselineDateRate: sourceHealth.baselineDateRate,
      consecutiveFailedDays: sourceHealth.consecutiveFailedDays,
      errorMessage: sourceHealth.errorMessage,
    })
    .from(sourceHealth)
    .innerJoin(sources, eq(sourceHealth.sourceId, sources.id))
    .where(and(eq(sourceHealth.date, date), isNotNull(sourceHealth.anomalies)))
    .orderBy(asc(sourceHealth.sourceId))
    .limit(anomalyLimit + 1);
  const anomalies = found.slice(0, anomalyLimit).map((a) => ({ ...a, anomalies: a.anomalies ?? [] }));
  return {
    date,
    status: row.anomalyCount > 0 ? "anomaly" : "ok",
    report: {
      ...row,
      extractionRate: ratio(row.extractedCount, row.fetchedCount),
      dateRate: ratio(row.dateFoundCount, row.extractedCount),
    },
    anomalies,
    anomaliesTruncated: found.length > anomalyLimit,
    thresholds: HEALTH_THRESHOLDS,
  };
}
