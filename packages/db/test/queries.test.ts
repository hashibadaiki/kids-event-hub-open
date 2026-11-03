import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { configComparisons, crawlTargets } from "../src/queries";
import { configEvaluations, extractionConfigs, rawDocuments, sources } from "../src/schema";

const db = drizzle(env.DB);

beforeEach(async () => {
  for (const t of ["pdf_documents", "config_evaluations", "raw_documents", "events", "crawl_runs", "extraction_configs", "sources", "facilities"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
});

async function insertSource(overrides: Partial<typeof sources.$inferInsert>) {
  await db.insert(sources).values({
    name: "x",
    url: `https://example.jp/${crypto.randomUUID()}`,
    type: "html",
    prefecture: "香川県",
    ...overrides,
  });
}

describe("crawlTargets", () => {
  it("approved・有効・policy が ng でない行だけを id 順に返す", async () => {
    await insertSource({ name: "ok", status: "approved", policyStatus: "ok" });
    await insertSource({ name: "unchecked", status: "approved" });
    await insertSource({ name: "caution", status: "approved", policyStatus: "caution" });
    await insertSource({ name: "ng", status: "approved", policyStatus: "ng" });
    await insertSource({ name: "pending", status: "pending", policyStatus: "ok" });
    await insertSource({ name: "rejected", status: "rejected", policyStatus: "ok" });
    await insertSource({ name: "disabled", status: "approved", policyStatus: "ok", enabled: false });
    const rows = await crawlTargets(db);
    expect(rows.map((r) => r.name)).toEqual(["ok", "unchecked", "caution"]);
  });
});

describe("configComparisons（自動改善の前後比較）", () => {
  it("評価ごとに収集元・旧版/新版の番号・スコア・採否を新しい順に返す", async () => {
    const [src] = await db
      .insert(sources)
      .values({ name: "未来館", url: "https://example.jp/a", type: "html", prefecture: "香川県" })
      .returning();
    const [v1, v2, v3] = await db
      .insert(extractionConfigs)
      .values([
        { sourceId: src!.id, version: 1, config: {}, status: "retired" },
        { sourceId: src!.id, version: 2, config: { hints: ["a"] }, status: "active" },
        { sourceId: src!.id, version: 3, config: { hints: ["b"] }, status: "rejected" },
      ])
      .returning();
    await db.insert(configEvaluations).values([
      {
        sourceId: src!.id,
        baselineConfigId: v1!.id,
        candidateConfigId: v2!.id,
        baselineScore: 0.4,
        candidateScore: 0.8,
        baselineMetrics: { dateRate: 0.5 },
        candidateMetrics: { dateRate: 1 },
        sampleCount: 2,
        decision: "adopted",
        reason: "0.4 → 0.8",
        createdAt: "2026-11-01 00:00:00",
      },
      {
        sourceId: src!.id,
        baselineConfigId: v2!.id,
        candidateConfigId: v3!.id,
        baselineScore: 0.8,
        candidateScore: 0.79,
        baselineMetrics: {},
        candidateMetrics: {},
        sampleCount: 2,
        decision: "rejected",
        reason: "改善幅が足りない",
        createdAt: "2026-11-02 00:00:00",
      },
    ]);
    const rows = await configComparisons(db);
    expect(rows).toMatchObject([
      { sourceName: "未来館", baselineVersion: 2, candidateVersion: 3, baselineScore: 0.8, candidateScore: 0.79, decision: "rejected" },
      { sourceName: "未来館", baselineVersion: 1, candidateVersion: 2, baselineScore: 0.4, candidateScore: 0.8, decision: "adopted", candidateMetrics: { dateRate: 1 } },
    ]);
  });

  it("decision は adopted / rejected のみ", async () => {
    const [src] = await db.insert(sources).values({ name: "x", url: "https://example.jp/b", type: "html", prefecture: "香川県" }).returning();
    const [v1] = await db.insert(extractionConfigs).values({ sourceId: src!.id, version: 1, config: {} }).returning();
    await expect(
      db.insert(configEvaluations).values({
        sourceId: src!.id,
        baselineConfigId: v1!.id,
        candidateConfigId: v1!.id,
        baselineScore: 0,
        candidateScore: 0,
        baselineMetrics: {},
        candidateMetrics: {},
        sampleCount: 0,
        decision: "maybe" as never,
      }),
    ).rejects.toThrow();
  });

  it("生データ（raw_documents）は収集元を消すと一緒に消える", async () => {
    const [src] = await db.insert(sources).values({ name: "x", url: "https://example.jp/c", type: "html", prefecture: "香川県" }).returning();
    await db.insert(rawDocuments).values({ sourceId: src!.id, url: "https://example.jp/c", contentType: "text/html", body: "<p>a</p>", fetchedAt: "2026-11-03T00:00:00Z" });
    await env.DB.prepare("DELETE FROM sources WHERE id = ?").bind(src!.id).run();
    expect(await db.select().from(rawDocuments)).toEqual([]);
  });
});
