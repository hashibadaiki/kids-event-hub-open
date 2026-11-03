import { and, asc, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { sources } from "./schema";

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
