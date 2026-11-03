import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import type { DashboardStats } from "@kids-event-hub/db";
import app from "../src/index";

type DashboardBody = DashboardStats & { generatedAt: string };

beforeEach(async () => {
  for (const t of ["events", "crawl_runs", "extraction_configs", "sources", "facilities"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
});

async function seed() {
  const src = await env.DB.prepare(
    "INSERT INTO sources (name, url, type, prefecture, status) VALUES ('高松市', 'https://example.jp/t', 'pdf', '香川県', 'approved') RETURNING id",
  ).first<{ id: number }>();
  for (const [day, status, err] of [
    ["01", "success", null],
    ["02", "failed", "HTTP 503"],
    ["03", "success", null],
  ] as const) {
    await env.DB.prepare(
      "INSERT INTO crawl_runs (source_id, status, started_at, fetched_count, extracted_count, date_found_count, error_message) VALUES (?, ?, ?, 4, 2, 1, ?)",
    )
      .bind(src!.id, status, `2026-11-${day}T00:00:00Z`, err)
      .run();
  }
}

describe("GET /api/dashboard", () => {
  it("ダッシュボード用の集計を JSON で返す", async () => {
    await seed();
    const res = await app.request("/api/dashboard", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as DashboardBody;
    expect(body.generatedAt).toEqual(expect.any(String));
    expect(body.sources).toMatchObject({ total: 1, pdfOnly: 1, pdfOnlyRate: 1, structured: 0 });
    expect(body.runs).toHaveLength(3);
    expect(body.runs[0]).toMatchObject({ startedAt: "2026-11-03T00:00:00Z", extractionRate: 0.5, dateRate: 0.5 });
    expect(body.failures).toEqual([expect.objectContaining({ status: "failed", errorMessage: "HTTP 503" })]);
    expect(body.configComparisons).toEqual([]);
  });

  it("別オリジンのダッシュボードから読めるよう CORS を許可し、短くキャッシュする", async () => {
    const res = await app.request("/api/dashboard", {}, env);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("runs / failures で件数を絞れる", async () => {
    await seed();
    const res = await app.request("/api/dashboard?runs=1&failures=1", {}, env);
    const body = (await res.json()) as DashboardBody;
    expect(body.runs).toHaveLength(1);
    expect(body.failures).toHaveLength(1);
  });

  it.each(["0", "201", "abc", "1.5"])("件数が 1〜200 の整数でなければ 400（runs=%s）", async (v) => {
    const res = await app.request(`/api/dashboard?runs=${v}`, {}, env);
    expect(res.status).toBe(400);
  });

  it("書き込みのメソッドは受け付けない", async () => {
    const res = await app.request("/api/dashboard", { method: "POST" }, env);
    expect(res.status).toBe(404);
  });
});
