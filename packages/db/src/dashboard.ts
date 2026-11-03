import { aliasedTable, and, count, desc, eq, inArray, isNotNull, sum } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { crawlRuns, extractionConfigs, sources, SOURCE_TYPES } from "./schema";

/**
 * 運用ダッシュボード（Claude の Dashboard）が読む集計。
 * 公開してよい数字だけを返す（収集元の名前・URL、件数、比率、エラーメッセージ）。
 * 比率は分母が 0 のとき null（0% と区別する）。
 */

type SourceType = (typeof SOURCE_TYPES)[number];

/** 構造化データ（JSON-LD / iCal / RSS）を持つ収集元の type */
export const STRUCTURED_SOURCE_TYPES = ["jsonld", "ical", "rss"] as const satisfies readonly SourceType[];

export type SourceSummary = {
  /** approved かつ有効な収集元の数 */
  total: number;
  byType: Partial<Record<SourceType, number>>;
  /** PDF のみの収集元（type = pdf） */
  pdfOnly: number;
  pdfOnlyRate: number | null;
  /** 構造化データを持つ収集元（type = jsonld / ical / rss） */
  structured: number;
  structuredRate: number | null;
};

export type RunStat = {
  id: number;
  sourceId: number;
  sourceName: string;
  sourceType: SourceType;
  configId: number | null;
  status: (typeof crawlRuns.$inferSelect)["status"];
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  fetchedCount: number;
  extractedCount: number;
  dateFoundCount: number;
  upsertedCount: number;
  /** 抽出成功率 = extracted / fetched */
  extractionRate: number | null;
  /** 日付取得率 = dateFound / extracted */
  dateRate: number | null;
};

export type ConfigRunTotals = {
  runs: number;
  extractedCount: number;
  dateFoundCount: number;
  dateRate: number | null;
};

/** 自動改善の前後比較。親の版（before）と、その改善案の版（after）のクロール実績 */
export type ConfigComparison = {
  sourceId: number;
  sourceName: string;
  configId: number;
  version: number;
  status: (typeof extractionConfigs.$inferSelect)["status"];
  qualityScore: number | null;
  note: string | null;
  adoptedAt: string | null;
  parentConfigId: number;
  parentVersion: number;
  before: ConfigRunTotals;
  after: ConfigRunTotals;
};

export type FailureStat = {
  runId: number;
  sourceId: number;
  sourceName: string;
  sourceUrl: string;
  status: "failed" | "partial";
  startedAt: string;
  errorMessage: string | null;
};

export type DashboardStats = {
  sources: SourceSummary;
  runs: RunStat[];
  configComparisons: ConfigComparison[];
  failures: FailureStat[];
};

export type DashboardOptions = {
  /** 直近のクロールを何件返すか（既定 50） */
  runLimit?: number;
  /** 直近の失敗を何件返すか（既定 20） */
  failureLimit?: number;
};

export const ratio = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? numerator / denominator : null;

export async function dashboardStats(
  db: DrizzleD1Database,
  { runLimit = 50, failureLimit = 20 }: DashboardOptions = {},
): Promise<DashboardStats> {
  const [sourceRows, runRows, comparisons, failures] = await Promise.all([
    sourceSummary(db),
    recentRuns(db, runLimit),
    configComparisons(db),
    recentFailures(db, failureLimit),
  ]);
  return { sources: sourceRows, runs: runRows, configComparisons: comparisons, failures };
}

async function sourceSummary(db: DrizzleD1Database): Promise<SourceSummary> {
  const rows = await db
    .select({ type: sources.type, n: count() })
    .from(sources)
    .where(and(eq(sources.status, "approved"), eq(sources.enabled, true)))
    .groupBy(sources.type);
  const byType: Partial<Record<SourceType, number>> = {};
  let total = 0;
  for (const r of rows) {
    byType[r.type] = r.n;
    total += r.n;
  }
  const pdfOnly = byType.pdf ?? 0;
  const structured = STRUCTURED_SOURCE_TYPES.reduce((acc, t) => acc + (byType[t] ?? 0), 0);
  return {
    total,
    byType,
    pdfOnly,
    pdfOnlyRate: ratio(pdfOnly, total),
    structured,
    structuredRate: ratio(structured, total),
  };
}

async function recentRuns(db: DrizzleD1Database, limit: number): Promise<RunStat[]> {
  const rows = await db
    .select({
      id: crawlRuns.id,
      sourceId: crawlRuns.sourceId,
      sourceName: sources.name,
      sourceType: sources.type,
      configId: crawlRuns.configId,
      status: crawlRuns.status,
      startedAt: crawlRuns.startedAt,
      finishedAt: crawlRuns.finishedAt,
      durationMs: crawlRuns.durationMs,
      fetchedCount: crawlRuns.fetchedCount,
      extractedCount: crawlRuns.extractedCount,
      dateFoundCount: crawlRuns.dateFoundCount,
      upsertedCount: crawlRuns.upsertedCount,
    })
    .from(crawlRuns)
    .innerJoin(sources, eq(crawlRuns.sourceId, sources.id))
    .orderBy(desc(crawlRuns.startedAt), desc(crawlRuns.id))
    .limit(limit);
  return rows.map((r) => ({
    ...r,
    extractionRate: ratio(r.extractedCount, r.fetchedCount),
    dateRate: ratio(r.dateFoundCount, r.extractedCount),
  }));
}

async function configComparisons(db: DrizzleD1Database): Promise<ConfigComparison[]> {
  const parent = aliasedTable(extractionConfigs, "parent");
  const configs = await db
    .select({
      sourceId: extractionConfigs.sourceId,
      sourceName: sources.name,
      configId: extractionConfigs.id,
      version: extractionConfigs.version,
      status: extractionConfigs.status,
      qualityScore: extractionConfigs.qualityScore,
      note: extractionConfigs.note,
      adoptedAt: extractionConfigs.adoptedAt,
      parentConfigId: parent.id,
      parentVersion: parent.version,
    })
    .from(extractionConfigs)
    .innerJoin(parent, eq(extractionConfigs.parentConfigId, parent.id))
    .innerJoin(sources, eq(extractionConfigs.sourceId, sources.id))
    .orderBy(desc(extractionConfigs.createdAt), desc(extractionConfigs.id));
  if (configs.length === 0) return [];

  const ids = [...new Set(configs.flatMap((c) => [c.configId, c.parentConfigId]))];
  const totals = await db
    .select({
      configId: crawlRuns.configId,
      runs: count(),
      extractedCount: sum(crawlRuns.extractedCount).mapWith(Number),
      dateFoundCount: sum(crawlRuns.dateFoundCount).mapWith(Number),
    })
    .from(crawlRuns)
    .where(and(isNotNull(crawlRuns.configId), inArray(crawlRuns.configId, ids)))
    .groupBy(crawlRuns.configId);
  const byConfig = new Map(totals.map((t) => [t.configId, t]));
  const totalsOf = (id: number): ConfigRunTotals => {
    const t = byConfig.get(id);
    const extractedCount = t?.extractedCount ?? 0;
    const dateFoundCount = t?.dateFoundCount ?? 0;
    return { runs: t?.runs ?? 0, extractedCount, dateFoundCount, dateRate: ratio(dateFoundCount, extractedCount) };
  };

  return configs.map((c) => ({ ...c, before: totalsOf(c.parentConfigId), after: totalsOf(c.configId) }));
}

async function recentFailures(db: DrizzleD1Database, limit: number): Promise<FailureStat[]> {
  const rows = await db
    .select({
      runId: crawlRuns.id,
      sourceId: crawlRuns.sourceId,
      sourceName: sources.name,
      sourceUrl: sources.url,
      status: crawlRuns.status,
      startedAt: crawlRuns.startedAt,
      errorMessage: crawlRuns.errorMessage,
    })
    .from(crawlRuns)
    .innerJoin(sources, eq(crawlRuns.sourceId, sources.id))
    .where(inArray(crawlRuns.status, ["failed", "partial"]))
    .orderBy(desc(crawlRuns.startedAt), desc(crawlRuns.id))
    .limit(limit);
  return rows.map((r) => ({ ...r, status: r.status as FailureStat["status"] }));
}

