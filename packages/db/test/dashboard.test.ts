import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { dashboardStats } from "../src/dashboard";
import { crawlRuns, extractionConfigs, sources } from "../src/schema";

const db = drizzle(env.DB);

beforeEach(async () => {
  for (const t of ["events", "crawl_runs", "extraction_configs", "sources", "facilities"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
});

async function insertSource(overrides: Partial<typeof sources.$inferInsert>) {
  const [row] = await db
    .insert(sources)
    .values({
      name: "x",
      url: `https://example.jp/${crypto.randomUUID()}`,
      type: "html",
      prefecture: "香川県",
      status: "approved",
      ...overrides,
    })
    .returning();
  return row!;
}

async function insertRun(overrides: Partial<typeof crawlRuns.$inferInsert> & { sourceId: number }) {
  const [row] = await db
    .insert(crawlRuns)
    .values({ status: "success", startedAt: "2026-11-01T00:00:00Z", ...overrides })
    .returning();
  return row!;
}

describe("dashboardStats", () => {
  it("データがなくても 0 と null で返す", async () => {
    const stats = await dashboardStats(db);
    expect(stats.sources).toEqual({
      total: 0,
      byType: {},
      pdfOnly: 0,
      pdfOnlyRate: null,
      structured: 0,
      structuredRate: null,
    });
    expect(stats.runs).toEqual([]);
    expect(stats.configComparisons).toEqual([]);
    expect(stats.failures).toEqual([]);
  });

  it("収集元の数・PDF のみの割合・構造化データを持つ割合（approved かつ有効な行だけ）", async () => {
    await insertSource({ type: "pdf" });
    await insertSource({ type: "pdf" });
    await insertSource({ type: "jsonld" });
    await insertSource({ type: "ical" });
    await insertSource({ type: "rss" });
    await insertSource({ type: "html" });
    await insertSource({ type: "llm" });
    await insertSource({ type: "html" });
    // 数えない: 未承認・無効
    await insertSource({ type: "pdf", status: "pending" });
    await insertSource({ type: "jsonld", enabled: false });

    const { sources: s } = await dashboardStats(db);
    expect(s.total).toBe(8);
    expect(s.byType).toEqual({ pdf: 2, jsonld: 1, ical: 1, rss: 1, html: 2, llm: 1 });
    expect(s.pdfOnly).toBe(2);
    expect(s.pdfOnlyRate).toBeCloseTo(0.25);
    expect(s.structured).toBe(3);
    expect(s.structuredRate).toBeCloseTo(0.375);
  });

  it("クロールごとの取得件数・抽出成功率・日付取得率を新しい順に返す", async () => {
    const src = await insertSource({ name: "高松市", type: "pdf" });
    await insertRun({
      sourceId: src.id,
      startedAt: "2026-11-01T00:00:00Z",
      fetchedCount: 10,
      extractedCount: 8,
      dateFoundCount: 6,
      upsertedCount: 6,
      durationMs: 1200,
    });
    await insertRun({ sourceId: src.id, startedAt: "2026-11-02T00:00:00Z", fetchedCount: 0 });

    const { runs } = await dashboardStats(db);
    expect(runs.map((r) => r.startedAt)).toEqual(["2026-11-02T00:00:00Z", "2026-11-01T00:00:00Z"]);
    expect(runs[1]).toMatchObject({
      sourceId: src.id,
      sourceName: "高松市",
      sourceType: "pdf",
      status: "success",
      fetchedCount: 10,
      extractedCount: 8,
      dateFoundCount: 6,
      upsertedCount: 6,
      durationMs: 1200,
      extractionRate: 0.8,
      dateRate: 0.75,
    });
    // 分母 0 は null（0% と区別する）
    expect(runs[0]).toMatchObject({ extractionRate: null, dateRate: null });
  });

  it("件数の上限を指定できる", async () => {
    const src = await insertSource({});
    for (let d = 1; d <= 5; d++) {
      await insertRun({ sourceId: src.id, startedAt: `2026-11-0${d}T00:00:00Z`, status: "failed", errorMessage: "x" });
    }
    const stats = await dashboardStats(db, { runLimit: 3, failureLimit: 2 });
    expect(stats.runs).toHaveLength(3);
    expect(stats.failures).toHaveLength(2);
    expect(stats.runs[0]!.startedAt).toBe("2026-11-05T00:00:00Z");
  });

  it("自動改善の前後（親の版 → 子の版）の日付取得率を比べる", async () => {
    const src = await insertSource({ name: "丸亀市" });
    const [v1] = await db
      .insert(extractionConfigs)
      .values({ sourceId: src.id, version: 1, config: {}, status: "retired" })
      .returning();
    const [v2] = await db
      .insert(extractionConfigs)
      .values({
        sourceId: src.id,
        version: 2,
        config: {},
        status: "active",
        parentConfigId: v1!.id,
        qualityScore: 0.9,
        note: "和暦の日付に対応",
        adoptedAt: "2026-11-02T00:00:00Z",
      })
      .returning();
    await insertRun({ sourceId: src.id, configId: v1!.id, extractedCount: 10, dateFoundCount: 4 });
    await insertRun({ sourceId: src.id, configId: v1!.id, extractedCount: 10, dateFoundCount: 6 });
    await insertRun({ sourceId: src.id, configId: v2!.id, extractedCount: 10, dateFoundCount: 9 });

    const { configComparisons } = await dashboardStats(db);
    expect(configComparisons).toEqual([
      {
        sourceId: src.id,
        sourceName: "丸亀市",
        configId: v2!.id,
        version: 2,
        status: "active",
        qualityScore: 0.9,
        note: "和暦の日付に対応",
        adoptedAt: "2026-11-02T00:00:00Z",
        parentConfigId: v1!.id,
        parentVersion: 1,
        before: { runs: 2, extractedCount: 20, dateFoundCount: 10, dateRate: 0.5 },
        after: { runs: 1, extractedCount: 10, dateFoundCount: 9, dateRate: 0.9 },
      },
    ]);
  });

  it("採用前でクロールがない版は after を 0 件・null で返す", async () => {
    const src = await insertSource({});
    const [v1] = await db
      .insert(extractionConfigs)
      .values({ sourceId: src.id, version: 1, config: {}, status: "active" })
      .returning();
    await db
      .insert(extractionConfigs)
      .values({ sourceId: src.id, version: 2, config: {}, status: "candidate", parentConfigId: v1!.id });
    const { configComparisons } = await dashboardStats(db);
    expect(configComparisons).toHaveLength(1);
    expect(configComparisons[0]!.before).toEqual({ runs: 0, extractedCount: 0, dateFoundCount: 0, dateRate: null });
    expect(configComparisons[0]!.after).toEqual({ runs: 0, extractedCount: 0, dateFoundCount: 0, dateRate: null });
  });

  it("直近の失敗と原因（failed と partial）を新しい順に返す", async () => {
    const src = await insertSource({ name: "坂出市", url: "https://example.jp/sakaide" });
    await insertRun({ sourceId: src.id, startedAt: "2026-11-01T00:00:00Z", status: "failed", errorMessage: "HTTP 503" });
    await insertRun({ sourceId: src.id, startedAt: "2026-11-02T00:00:00Z", status: "success" });
    const partial = await insertRun({
      sourceId: src.id,
      startedAt: "2026-11-03T00:00:00Z",
      status: "partial",
      errorMessage: "PDF 1 件の読み取りに失敗",
    });

    const { failures } = await dashboardStats(db);
    expect(failures).toEqual([
      {
        runId: partial.id,
        sourceId: src.id,
        sourceName: "坂出市",
        sourceUrl: "https://example.jp/sakaide",
        status: "partial",
        startedAt: "2026-11-03T00:00:00Z",
        errorMessage: "PDF 1 件の読み取りに失敗",
      },
      expect.objectContaining({ status: "failed", errorMessage: "HTTP 503" }),
    ]);
  });
});
