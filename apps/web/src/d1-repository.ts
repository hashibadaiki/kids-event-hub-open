import { and, asc, count, desc, eq, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { events } from "@kids-event-hub/db";
import { addDays, type SearchQuery } from "./search";
import { DEFAULT_LIMIT, type EventRecord, type EventRepository } from "./repository";

const columns = {
  id: events.id,
  title: events.title,
  summary: events.summary,
  startAt: events.startAt,
  endAt: events.endAt,
  allDay: events.allDay,
  prefecture: events.prefecture,
  city: events.city,
  venue: events.venue,
  ageMin: events.ageMin,
  ageMax: events.ageMax,
  withParent: events.withParent,
  ageText: events.ageText,
  priceFree: events.priceFree,
  priceText: events.priceText,
  categories: events.categories,
  sourceUrl: events.sourceUrl,
};

/** D1 の events からページ用のイベントを取る。絞り込み条件は search.ts の matchesQuery と同じ */
export function createD1Repository(d1: D1Database): EventRepository {
  const db = drizzle(d1);
  return {
    async search(query: SearchQuery, limit = DEFAULT_LIMIT): Promise<EventRecord[]> {
      const conditions = [
        eq(events.prefecture, query.prefecture),
        // 期間 [from, to] と開催期間が重なる
        lt(events.startAt, addDays(query.to, 1)),
        gte(sql`substr(coalesce(${events.endAt}, ${events.startAt}), 1, 10)`, query.from),
      ];
      if (query.age !== undefined) {
        // 範囲に入る、または年齢の記載がない
        conditions.push(
          or(isNull(events.ageMin), lte(events.ageMin, query.age))!,
          or(isNull(events.ageMax), gte(events.ageMax, query.age))!,
        );
      }
      return db
        .select(columns)
        .from(events)
        .where(and(...conditions))
        .orderBy(asc(events.startAt), asc(events.id))
        .limit(limit);
    },

    async findById(id: number) {
      const [row] = await db.select(columns).from(events).where(eq(events.id, id)).limit(1);
      return row;
    },

    async prefectures() {
      return db
        .select({ prefecture: events.prefecture, count: count() })
        .from(events)
        .groupBy(events.prefecture)
        .orderBy(desc(count()));
    },
  };
}
