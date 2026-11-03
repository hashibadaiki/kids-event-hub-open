import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { createMemoryRepository, type EventRecord, type EventRepository } from "../src/repository";
import { createD1Repository } from "../src/d1-repository";
import type { SearchQuery } from "../src/search";
import app from "../src/index";

const ev = (over: Partial<EventRecord> & { id: number }): EventRecord => ({
  title: "おはなし会",
  summary: "絵本の読み聞かせ",
  startAt: "2026-11-08T10:00",
  endAt: "2026-11-08T11:00",
  allDay: false,
  prefecture: "香川県",
  city: "高松市",
  venue: "中央図書館",
  ageMin: 3,
  ageMax: 6,
  withParent: true,
  ageText: "3〜6歳（保護者同伴）",
  priceFree: true,
  priceText: "無料",
  categories: ["storytelling"],
  sourceUrl: `https://example.jp/event/${over.id}`,
  ...over,
});

const EVENTS: EventRecord[] = [
  ev({ id: 1 }),
  ev({ id: 2, title: "親子工作教室", startAt: "2026-11-15T13:00", endAt: null, ageMin: 6, ageMax: 12, withParent: null, priceFree: false, priceText: "材料費300円", categories: ["craft"] }),
  ev({ id: 3, title: "秋のスタンプラリー", startAt: "2026-11-01", endAt: "2026-11-30", allDay: true, ageMin: null, ageMax: null, ageText: null, withParent: null, priceFree: null, priceText: null, summary: null, city: null, venue: null, categories: [] }),
  ev({ id: 4, title: "阿波の子ども祭り", prefecture: "徳島県", startAt: "2026-11-08" }),
  ev({ id: 5, title: "同じ時刻のもう一件", startAt: "2026-11-08T10:00", endAt: null, ageMin: 10, ageMax: null }),
  ev({ id: 6, title: "前日に終わる", startAt: "2026-11-05", endAt: "2026-11-07T18:00" }),
  ev({ id: 7, title: "翌日に始まる", startAt: "2026-11-09T00:00", endAt: null }),
];

const q = (over: Partial<SearchQuery>): SearchQuery => ({
  prefecture: "香川県",
  slug: "kagawa",
  from: "2026-11-08",
  to: "2026-11-08",
  ...over,
});

async function seedD1(events: EventRecord[]) {
  for (const t of ["events", "crawl_runs", "extraction_configs", "sources", "facilities"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  await env.DB.prepare(
    `INSERT INTO sources (id, name, url, type, prefecture, status) VALUES (1, 's', 'https://example.jp/', 'html', '香川県', 'approved')`,
  ).run();
  await env.DB.batch(
    events.map((e) =>
      env.DB.prepare(
        `INSERT INTO events (id, source_id, title, summary, start_at, end_at, all_day, prefecture, city, venue,
           age_min, age_max, with_parent, age_text, price_free, price_text, categories, source_url, dedup_key)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        e.id, e.title, e.summary, e.startAt, e.endAt, e.allDay ? 1 : 0, e.prefecture, e.city, e.venue,
        e.ageMin, e.ageMax, e.withParent === null ? null : e.withParent ? 1 : 0, e.ageText,
        e.priceFree === null ? null : e.priceFree ? 1 : 0, e.priceText, JSON.stringify(e.categories),
        e.sourceUrl, `key-${e.id}`,
      ),
    ),
  );
}

const ids = (rows: EventRecord[]) => rows.map((r) => r.id);

// 同じ期待値をインメモリ実装と D1 実装の両方で確かめる（SQL が matchesQuery と同じ条件であること）
const implementations: [string, () => Promise<EventRepository>][] = [
  ["memory", async () => createMemoryRepository(EVENTS)],
  ["d1", async () => {
    await seedD1(EVENTS);
    return createD1Repository(env.DB);
  }],
];

describe.each(implementations)("EventRepository (%s)", (_name, make) => {
  let repo: EventRepository;
  beforeEach(async () => {
    repo = await make();
  });

  it("1 日指定: その日に開催中のイベントを開始日時順（同時刻は id 順）で返す", async () => {
    expect(ids(await repo.search(q({})))).toEqual([3, 1, 5]);
  });

  it("期間指定: 期間と開催期間が重なるもの", async () => {
    expect(ids(await repo.search(q({ from: "2026-11-07", to: "2026-11-09" })))).toEqual([3, 6, 1, 5, 7]);
    expect(ids(await repo.search(q({ from: "2026-11-10", to: "2026-11-20" })))).toEqual([3, 2]);
  });

  it("対象年齢: 範囲に入るもの + 年齢の記載がないもの", async () => {
    expect(ids(await repo.search(q({ age: 4 })))).toEqual([3, 1]);
    expect(ids(await repo.search(q({ age: 11 })))).toEqual([3, 5]);
  });

  it("他県は含まない", async () => {
    expect(ids(await repo.search(q({ prefecture: "徳島県", slug: "tokushima" })))).toEqual([4]);
  });

  it("件数の上限", async () => {
    expect(ids(await repo.search(q({ from: "2026-11-01", to: "2026-11-30" }), 2))).toEqual([3, 6]);
  });

  it("findById は全項目を EventRecord の形で返す。なければ undefined", async () => {
    expect(await repo.findById(2)).toEqual(EVENTS[1]);
    expect(await repo.findById(3)).toEqual(EVENTS[2]);
    expect(await repo.findById(999)).toBeUndefined();
  });

  it("prefectures は県ごとの件数", async () => {
    const rows = await repo.prefectures();
    expect([...rows].sort((a, b) => a.prefecture.localeCompare(b.prefecture))).toEqual(
      [
        { prefecture: "香川県", count: 6 },
        { prefecture: "徳島県", count: 1 },
      ].sort((a, b) => a.prefecture.localeCompare(b.prefecture)),
    );
  });
});

describe("本番のアプリ（src/index.ts）は D1 から表示する", () => {
  it("D1 のイベントが県一覧・詳細に出る", async () => {
    await seedD1(EVENTS);
    const home = await (await app.request("/", {}, env)).text();
    expect(home).toContain('href="/kagawa"');
    const detail = await app.request("/events/2", {}, env);
    expect(detail.status).toBe(200);
    expect(await detail.text()).toContain("親子工作教室");
  });
});
