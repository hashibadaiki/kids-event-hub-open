import { and, asc, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { configEvaluations, extractionConfigs, sources } from "./schema";

/**
 * クロール対象の収集元: approved・有効・policy が ng でない（未確認 / caution は含む）。
 * 施設投稿の pending 行や、sources.yaml から消えて無効化された行は入らない
 */
export function crawlTargets(db: DrizzleD1Database) {
  return db
    .select()
    .from(sources)
    .where(
      and(
        eq(sources.status, "approved"),
        eq(sources.enabled, true),
        sql`coalesce(${sources.policyStatus}, '') <> 'ng'`,
      ),
    )
    .orderBy(asc(sources.id));
}

/**
 * 自動改善の前後比較（ダッシュボード用）。評価ごとに旧版・候補の版番号とスコア・指標・採否を新しい順に返す
 */
export function configComparisons(db: DrizzleD1Database, opts: { sourceId?: number; limit?: number } = {}) {
  const baseline = alias(extractionConfigs, "baseline");
  const candidate = alias(extractionConfigs, "candidate");
  return db
    .select({
      id: configEvaluations.id,
      sourceId: configEvaluations.sourceId,
      sourceName: sources.name,
      baselineVersion: baseline.version,
      candidateVersion: candidate.version,
      baselineScore: configEvaluations.baselineScore,
      candidateScore: configEvaluations.candidateScore,
      baselineMetrics: configEvaluations.baselineMetrics,
      candidateMetrics: configEvaluations.candidateMetrics,
      sampleCount: configEvaluations.sampleCount,
      decision: configEvaluations.decision,
      reason: configEvaluations.reason,
      createdAt: configEvaluations.createdAt,
    })
    .from(configEvaluations)
    .innerJoin(sources, eq(configEvaluations.sourceId, sources.id))
    .innerJoin(baseline, eq(configEvaluations.baselineConfigId, baseline.id))
    .innerJoin(candidate, eq(configEvaluations.candidateConfigId, candidate.id))
    .where(opts.sourceId === undefined ? undefined : eq(configEvaluations.sourceId, opts.sourceId))
    .orderBy(desc(configEvaluations.createdAt), desc(configEvaluations.id))
    .limit(opts.limit ?? 100);
}
