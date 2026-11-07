import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { writeHealthReport, type HealthReport } from "@kids-event-hub/db";
import { createApp } from "../src/app";
import { createD1Repository } from "../src/d1-repository";

type HealthBody = HealthReport & { generatedAt: string; today: string };

const NOW = new Date("2026-11-07T07:00:00+09:00");
const app = createApp({ repository: (e) => createD1Repository(e.DB), now: () => NOW });

beforeEach(async () => {
  for (const t of ["source_health", "health_reports", "events", "crawl_runs", "extraction_configs", "sources", "facilities"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
});

async function seed() {
  for (const [name, status] of [
    ["高松市", "success"],
    ["丸亀市", "failed"],
  ] as const) {
    const src = await env.DB.prepare(
      "INSERT INTO sources (name, url, type, prefecture, status) VALUES (?, ?, 'html', '香川県', 'approved') RETURNING id",
    )
      .bind(name, `https://example.jp/${name}`)
      .first<{ id: number }>();
    for (const startedAt of ["2026-11-05T18:00:00.000Z", "2026-11-06T18:00:00.000Z"]) {
      await env.DB.prepare(
        "INSERT INTO crawl_runs (source_id, status, started_at, fetched_count, extracted_count, date_found_count, error_message) VALUES (?, ?, ?, 1, 2, 1, ?)",
      )
        .bind(src!.id, status, startedAt, status === "failed" ? "HTTP 503" : null)
        .run();
    }
  }
  await writeHealthReport(env.DB, new Date("2026-11-06T06:30:00+09:00"));
  await writeHealthReport(env.DB, new Date("2026-11-07T06:30:00+09:00"));
}

describe("GET /api/health", () => {
  it("今日（JST）の要約と異常のある収集元だけを返す", async () => {
    await seed();
    const res = await app.request("/api/health", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as HealthBody;
    expect(body).toMatchObject({ today: "2026-11-07", date: "2026-11-07", status: "anomaly" });
    expect(body.report).toMatchObject({ targetSources: 2, successCount: 1, failedCount: 1, anomalyCount: 1 });
    expect(body.anomalies).toEqual([
      expect.objectContaining({ sourceName: "丸亀市", anomalies: ["failed"], errorMessage: "HTTP 503" }),
    ]);
    expect(body.thresholds).toMatchObject({ rateDrop: expect.any(Number) });
  });

  it("date で日を指定でき、集計がない日は missing", async () => {
    await seed();
    const body = (await (await app.request("/api/health?date=2026-11-05", {}, env)).json()) as HealthBody;
    expect(body).toMatchObject({ date: "2026-11-05", status: "missing", report: null, anomalies: [] });
  });

  it.each(["2026-11", "abc", "2026-13-01"])("date が YYYY-MM-DD の日付でなければ 400（%s）", async (v) => {
    const res = await app.request(`/api/health?date=${v}`, {}, env);
    expect(res.status).toBe(400);
  });

  it("書き込みのメソッドは受け付けない", async () => {
    const res = await app.request("/api/health", { method: "POST" }, env);
    expect(res.status).toBe(404);
  });
});

async function mcp(method: string, params?: unknown) {
  const res = await app.request(
    "/mcp",
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    },
    env,
  );
  return (await res.json()) as {
    result?: { isError?: boolean; structuredContent?: HealthBody; content: { text: string }[]; tools?: { name: string; annotations: Record<string, unknown> }[] };
  };
}

describe("MCP の get_health（毎朝の定期チェック用）", () => {
  it("tools/list に読み取り専用のツールとして出る", async () => {
    const tool = (await mcp("tools/list")).result!.tools!.find((t) => t.name === "get_health");
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it("/api/health と同じ内容を返す", async () => {
    await seed();
    const result = (await mcp("tools/call", { name: "get_health", arguments: {} })).result!;
    expect(result.isError).toBeUndefined();
    const api = (await (await app.request("/api/health", {}, env)).json()) as HealthBody;
    expect(result.structuredContent).toEqual(api);
  });

  it("date を指定できる。形式が違えばエラー", async () => {
    await seed();
    const body = (await mcp("tools/call", { name: "get_health", arguments: { date: "2026-11-05" } })).result!.structuredContent!;
    expect(body.status).toBe("missing");
    const bad = (await mcp("tools/call", { name: "get_health", arguments: { date: "11/06" } })).result!;
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain("date");
  });
});
