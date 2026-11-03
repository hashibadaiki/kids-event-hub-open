import { matchesQuery, type SearchQuery } from "./search";

/**
 * 画面で使うイベント。列は packages/db の `events`（#5）に合わせている。
 * 日時は JST ローカル表記（`YYYY-MM-DD` / `YYYY-MM-DDTHH:mm`）
 */
export type EventRecord = {
  id: number;
  title: string;
  summary: string | null;
  startAt: string;
  endAt: string | null;
  allDay: boolean;
  prefecture: string;
  city: string | null;
  venue: string | null;
  ageMin: number | null;
  ageMax: number | null;
  withParent: boolean | null;
  ageText: string | null;
  priceFree: boolean | null;
  priceText: string | null;
  categories: string[];
  sourceUrl: string;
};

export type PrefectureCount = { prefecture: string; count: number };

/** ページが必要とするイベントの取得。D1 実装と、テスト・開発用のインメモリ実装を差し替える */
export interface EventRepository {
  /** 条件に合うイベントを開始日時の早い順で返す */
  search(query: SearchQuery, limit?: number): Promise<EventRecord[]>;
  findById(id: number): Promise<EventRecord | undefined>;
  /** イベントがある都道府県と件数 */
  prefectures(): Promise<PrefectureCount[]>;
}

export const DEFAULT_LIMIT = 200;

export function createMemoryRepository(events: readonly EventRecord[]): EventRepository {
  return {
    async search(query, limit = DEFAULT_LIMIT) {
      return events
        .filter((e) => matchesQuery(e, query))
        .sort((a, b) => (a.startAt < b.startAt ? -1 : a.startAt > b.startAt ? 1 : a.id - b.id))
        .slice(0, limit);
    },
    async findById(id) {
      return events.find((e) => e.id === id);
    },
    async prefectures() {
      const counts = new Map<string, number>();
      for (const e of events) counts.set(e.prefecture, (counts.get(e.prefecture) ?? 0) + 1);
      return [...counts].map(([prefecture, count]) => ({ prefecture, count }));
    },
  };
}
