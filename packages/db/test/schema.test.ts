import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import {
  crawlRuns,
  events,
  extractionConfigs,
  facilities,
  sources,
} from "../src/schema";

const db = drizzle(env.DB);

async function resetTables() {
  // 子テーブルから消す
  for (const t of ["pdf_documents", "config_evaluations", "raw_documents", "events", "crawl_runs", "extraction_configs", "sources", "facilities"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
}

async function insertSource(overrides: Partial<typeof sources.$inferInsert> = {}) {
  const [row] = await db
    .insert(sources)
    .values({
      name: "高松市こども未来館",
      url: `https://example.jp/${crypto.randomUUID()}`,
      type: "pdf",
      prefecture: "香川県",
      ...overrides,
    })
    .returning();
  return row;
}

beforeEach(resetTables);

describe("sources", () => {
  it("insert/select できる。同期で入る owner / approved の行が既定値で表せる", async () => {
    const src = await insertSource({ submittedBy: "owner", status: "approved" });
    const [row] = await db.select().from(sources).where(eq(sources.id, src.id));
    expect(row).toMatchObject({
      name: "高松市こども未来館",
      type: "pdf",
      prefecture: "香川県",
      enabled: true,
      submittedBy: "owner",
      status: "approved",
      facilityId: null,
      policyStatus: null,
      policyCheckedAt: null,
      policyNote: null,
    });
    expect(row.createdAt).toBeTruthy();
  });

  it("既定は submitted_by=owner / status=pending（未承認はクロールしない側に倒す）", async () => {
    const src = await insertSource();
    expect(src.submittedBy).toBe("owner");
    expect(src.status).toBe("pending");
  });

  it("URL は一意", async () => {
    await insertSource({ url: "https://example.jp/a" });
    await expect(insertSource({ url: "https://example.jp/a" })).rejects.toThrow();
  });

  it.each([
    ["type", { type: "csv" }],
    ["submitted_by", { submittedBy: "anonymous" }],
    ["status", { status: "deleted" }],
    ["policy_status", { policyStatus: "maybe" }],
  ])("%s に想定外の値は入らない", async (_col, overrides) => {
    await expect(insertSource(overrides as never)).rejects.toThrow();
  });

  it("robots.txt・規約の確認結果を持てる", async () => {
    const src = await insertSource({
      policyStatus: "caution",
      policyCheckedAt: "2026-11-02T10:00:00Z",
      policyNote: "https://example.jp/terms 転載禁止の記述あり。要約と元 URL のみ",
    });
    expect(src.policyStatus).toBe("caution");
  });

  it("施設管理者からの投稿は facilities に紐づけられる", async () => {
    const [fac] = await db
      .insert(facilities)
      .values({ name: "サンポート高松", prefecture: "香川県", url: "https://example.jp/sunport" })
      .returning();
    const src = await insertSource({ submittedBy: "facility", facilityId: fac.id, status: "pending" });
    expect(src.facilityId).toBe(fac.id);
  });

  it("存在しない facility_id は入らない（外部キー）", async () => {
    await expect(insertSource({ submittedBy: "facility", facilityId: 9999 })).rejects.toThrow();
  });

  it("クローラーの対象（approved・有効・policy が ng でない）を選べる", async () => {
    await insertSource({ name: "ok", status: "approved", policyStatus: "ok" });
    await insertSource({ name: "unchecked", status: "approved" });
    await insertSource({ name: "ng", status: "approved", policyStatus: "ng" });
    await insertSource({ name: "pending", status: "pending", policyStatus: "ok" });
    await insertSource({ name: "disabled", status: "approved", policyStatus: "ok", enabled: false });
    const rows = await db
      .select({ name: sources.name })
      .from(sources)
      .where(
        and(
          eq(sources.status, "approved"),
          eq(sources.enabled, true),
          sql`coalesce(${sources.policyStatus}, '') <> 'ng'`,
        ),
      )
      .orderBy(asc(sources.name));
    expect(rows.map((r) => r.name)).toEqual(["ok", "unchecked"]);
  });
});

describe("extraction_configs（版管理）", () => {
  it("収集元ごとに version を積める", async () => {
    const src = await insertSource();
    await db.insert(extractionConfigs).values([
      { sourceId: src.id, version: 1, config: { prompt: "v1" }, status: "retired", qualityScore: 0.6 },
      { sourceId: src.id, version: 2, config: { prompt: "v2" }, status: "active", qualityScore: 0.8 },
    ]);
    const rows = await db
      .select()
      .from(extractionConfigs)
      .where(eq(extractionConfigs.sourceId, src.id))
      .orderBy(asc(extractionConfigs.version));
    expect(rows.map((r) => [r.version, r.status, r.qualityScore])).toEqual([
      [1, "retired", 0.6],
      [2, "active", 0.8],
    ]);
    expect(rows[1].config).toEqual({ prompt: "v2" });
  });

  it("同じ収集元で version は重複できない", async () => {
    const src = await insertSource();
    await db.insert(extractionConfigs).values({ sourceId: src.id, version: 1, config: {} });
    await expect(
      db.insert(extractionConfigs).values({ sourceId: src.id, version: 1, config: {} }),
    ).rejects.toThrow();
  });

  it("採用中（active）は収集元ごとに 1 つだけ", async () => {
    const src = await insertSource();
    await db.insert(extractionConfigs).values({ sourceId: src.id, version: 1, config: {}, status: "active" });
    await expect(
      db.insert(extractionConfigs).values({ sourceId: src.id, version: 2, config: {}, status: "active" }),
    ).rejects.toThrow();
    // 候補は何個でも置ける
    await db.insert(extractionConfigs).values([
      { sourceId: src.id, version: 2, config: {}, status: "candidate" },
      { sourceId: src.id, version: 3, config: {}, status: "candidate" },
    ]);
  });

  it("別の収集元なら同じ version・それぞれ active を持てる", async () => {
    const a = await insertSource();
    const b = await insertSource();
    await db.insert(extractionConfigs).values([
      { sourceId: a.id, version: 1, config: {}, status: "active" },
      { sourceId: b.id, version: 1, config: {}, status: "active" },
    ]);
  });

  it("status の既定は candidate、想定外の値は入らない", async () => {
    const src = await insertSource();
    const [row] = await db
      .insert(extractionConfigs)
      .values({ sourceId: src.id, version: 1, config: {} })
      .returning();
    expect(row.status).toBe("candidate");
    await expect(
      db.insert(extractionConfigs).values({ sourceId: src.id, version: 2, config: {}, status: "live" as never }),
    ).rejects.toThrow();
  });
});

describe("crawl_runs とダッシュボード指標", () => {
  it("config version ごとの抽出成功率・日付取得率・所要時間を集計できる（自動改善の前後比較）", async () => {
    const src = await insertSource();
    const [v1, v2] = await db
      .insert(extractionConfigs)
      .values([
        { sourceId: src.id, version: 1, config: {}, status: "retired" },
        { sourceId: src.id, version: 2, config: {}, status: "active" },
      ])
      .returning();
    await db.insert(crawlRuns).values([
      { sourceId: src.id, configId: v1.id, status: "success", startedAt: "2026-11-01T00:00:00Z", finishedAt: "2026-11-01T00:00:10Z", durationMs: 10000, fetchedCount: 10, extractedCount: 6, dateFoundCount: 3 },
      { sourceId: src.id, configId: v2.id, status: "success", startedAt: "2026-11-02T00:00:00Z", finishedAt: "2026-11-02T00:00:08Z", durationMs: 8000, fetchedCount: 10, extractedCount: 9, dateFoundCount: 9 },
    ]);

    const rows = await db
      .select({
        version: extractionConfigs.version,
        runs: sql<number>`count(*)`,
        extractionRate: sql<number>`1.0 * sum(${crawlRuns.extractedCount}) / sum(${crawlRuns.fetchedCount})`,
        dateRate: sql<number>`1.0 * sum(${crawlRuns.dateFoundCount}) / sum(${crawlRuns.extractedCount})`,
        avgDurationMs: sql<number>`avg(${crawlRuns.durationMs})`,
      })
      .from(crawlRuns)
      .innerJoin(extractionConfigs, eq(crawlRuns.configId, extractionConfigs.id))
      .where(eq(crawlRuns.sourceId, src.id))
      .groupBy(extractionConfigs.version)
      .orderBy(asc(extractionConfigs.version));

    expect(rows).toEqual([
      { version: 1, runs: 1, extractionRate: 0.6, dateRate: 0.5, avgDurationMs: 10000 },
      { version: 2, runs: 1, extractionRate: 0.9, dateRate: 1, avgDurationMs: 8000 },
    ]);
  });

  it("失敗した実行はエラーと共に残せる。件数の既定は 0", async () => {
    const src = await insertSource();
    const [run] = await db
      .insert(crawlRuns)
      .values({ sourceId: src.id, status: "failed", startedAt: "2026-11-02T00:00:00Z", errorMessage: "HTTP 503" })
      .returning();
    expect(run).toMatchObject({ status: "failed", fetchedCount: 0, extractedCount: 0, dateFoundCount: 0, configId: null });
    await expect(
      db.insert(crawlRuns).values({ sourceId: src.id, status: "oops" as never, startedAt: "2026-11-02T00:00:00Z" }),
    ).rejects.toThrow();
  });
});

describe("events", () => {
  function eventValues(sourceId: number, overrides: Partial<typeof events.$inferInsert> = {}) {
    return {
      sourceId,
      title: "親子でつくろう！紙コップ工作",
      startAt: "2026-11-08T10:00",
      endAt: "2026-11-08T12:00",
      prefecture: "香川県",
      city: "高松市",
      venue: "高松市こども未来館",
      sourceUrl: "https://example.jp/event/1",
      dedupKey: `2026-11-08|${crypto.randomUUID()}`,
      ...overrides,
    } satisfies typeof events.$inferInsert;
  }

  it("正規化済みの項目（年齢・料金・カテゴリ・繰り返し）を insert/select できる", async () => {
    const src = await insertSource();
    const [ins] = await db
      .insert(events)
      .values(
        eventValues(src.id, {
          allDay: false,
          ageMin: 3,
          ageMax: 12,
          withParent: true,
          ageText: "3歳〜小学生（保護者同伴）",
          priceFree: false,
          priceMinYen: 300,
          priceMaxYen: 500,
          priceText: "大人500円・子供300円",
          categories: ["craft", "science"],
          recurrence: { freq: "weekly", weekdays: [6] },
          summary: "紙コップで工作をします",
        }),
      )
      .returning();
    const [row] = await db.select().from(events).where(eq(events.id, ins.id));
    expect(row).toMatchObject({
      title: "親子でつくろう！紙コップ工作",
      startAt: "2026-11-08T10:00",
      endAt: "2026-11-08T12:00",
      allDay: false,
      ageMin: 3,
      ageMax: 12,
      withParent: true,
      priceFree: false,
      priceMinYen: 300,
      priceMaxYen: 500,
      categories: ["craft", "science"],
      recurrence: { freq: "weekly", weekdays: [6] },
      prefecture: "香川県",
      city: "高松市",
      sourceUrl: "https://example.jp/event/1",
    });
  });

  it("申込方法（元の表記）を持てる", async () => {
    const src = await insertSource();
    const [ins] = await db.insert(events).values(eventValues(src.id, { applyText: "11月1日から電話で受付（先着20組）" })).returning();
    const [row] = await db.select().from(events).where(eq(events.id, ins.id));
    expect(row!.applyText).toBe("11月1日から電話で受付（先着20組）");
  });

  it("重複キーは一意（同じイベントを二重に入れない）", async () => {
    const src = await insertSource();
    await db.insert(events).values(eventValues(src.id, { dedupKey: "2026-11-08|紙コップ工作" }));
    await expect(
      db.insert(events).values(eventValues(src.id, { dedupKey: "2026-11-08|紙コップ工作" })),
    ).rejects.toThrow();
  });

  it("重複キーで upsert できる（再クロールで内容を更新）", async () => {
    const src = await insertSource();
    const key = "2026-11-08|紙コップ工作";
    await db.insert(events).values(eventValues(src.id, { dedupKey: key, venue: "旧会場" }));
    await db
      .insert(events)
      .values(eventValues(src.id, { dedupKey: key, venue: "新会場" }))
      .onConflictDoUpdate({ target: events.dedupKey, set: { venue: "新会場" } });
    const rows = await db.select().from(events).where(eq(events.dedupKey, key));
    expect(rows).toHaveLength(1);
    expect(rows[0].venue).toBe("新会場");
  });

  it("都道府県 × 日付で探せる（期間をまたぐイベントも拾う）", async () => {
    const src = await insertSource();
    await db.insert(events).values([
      eventValues(src.id, { title: "当日", startAt: "2026-11-08T10:00", endAt: null }),
      eventValues(src.id, { title: "期間中", startAt: "2026-11-01", endAt: "2026-11-30", allDay: true }),
      eventValues(src.id, { title: "別の日", startAt: "2026-11-09T10:00", endAt: null }),
      eventValues(src.id, { title: "別の県", prefecture: "徳島県" }),
    ]);
    const day = "2026-11-08";
    const rows = await db
      .select({ title: events.title })
      .from(events)
      .where(
        and(
          eq(events.prefecture, "香川県"),
          lt(events.startAt, "2026-11-09"), // 翌日 0 時より前に始まる
          gte(sql`coalesce(${events.endAt}, ${events.startAt})`, day),
        ),
      )
      .orderBy(asc(events.startAt));
    expect(rows.map((r) => r.title)).toEqual(["期間中", "当日"]);
  });

  it("収集元・どの実行で入ったかを辿れる", async () => {
    const src = await insertSource();
    const [run] = await db
      .insert(crawlRuns)
      .values({ sourceId: src.id, status: "success", startedAt: "2026-11-02T00:00:00Z" })
      .returning();
    const [ev] = await db.insert(events).values(eventValues(src.id, { crawlRunId: run.id })).returning();
    expect(ev.crawlRunId).toBe(run.id);
    await expect(db.insert(events).values(eventValues(9999))).rejects.toThrow();
  });
});
