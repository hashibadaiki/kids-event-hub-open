import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { crawlTargets } from "@kids-event-hub/db";
import { planSync, type ExistingSource } from "../src/sources/sync";
import type { SourceEntry } from "../src/sources/file";

const entry = (overrides: Partial<SourceEntry> = {}): SourceEntry => ({
  name: "高松市こども未来館",
  url: "https://example.jp/miraikan.pdf",
  prefecture: "香川県",
  type: "pdf",
  enabled: true,
  note: null,
  policy: null,
  ...overrides,
});

async function readExisting(): Promise<ExistingSource[]> {
  const { results } = await env.DB.prepare("SELECT url, submitted_by, enabled FROM sources").all<{
    url: string;
    submitted_by: string;
    enabled: number;
  }>();
  return results.map((r) => ({ url: r.url, submittedBy: r.submitted_by, enabled: r.enabled === 1 }));
}

/** 実際の同期と同じ流れ: D1 の現状を読む → 計画 → 実行 */
async function sync(entries: SourceEntry[]) {
  const plan = planSync(entries, await readExisting());
  if (plan.statements.length > 0) {
    await env.DB.batch(plan.statements.map((s) => env.DB.prepare(s)));
  }
  return plan;
}

async function rows() {
  const { results } = await env.DB.prepare(
    `SELECT name, url, type, prefecture, enabled, submitted_by, status,
            policy_status, policy_checked_at, policy_note
       FROM sources ORDER BY url`,
  ).all();
  return results;
}

async function insertFacilitySource(url: string) {
  await env.DB.prepare(
    `INSERT INTO sources (name, url, type, prefecture, submitted_by, status)
     VALUES ('施設からの投稿', ?, 'html', '香川県', 'facility', 'pending')`,
  )
    .bind(url)
    .run();
}

beforeEach(async () => {
  for (const t of ["events", "crawl_runs", "extraction_configs", "sources", "facilities"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
});

describe("planSync + D1", () => {
  it("新しい収集元は owner / approved で入る", async () => {
    const plan = await sync([
      entry({ policy: { status: "ok", checkedAt: "2026-11-03", note: "robots.txt に禁止なし" } }),
    ]);
    expect(plan.inserted).toEqual(["https://example.jp/miraikan.pdf"]);
    expect(await rows()).toEqual([
      {
        name: "高松市こども未来館",
        url: "https://example.jp/miraikan.pdf",
        type: "pdf",
        prefecture: "香川県",
        enabled: 1,
        submitted_by: "owner",
        status: "approved",
        policy_status: "ok",
        policy_checked_at: "2026-11-03",
        policy_note: "robots.txt に禁止なし",
      },
    ]);
  });

  it("2 回同期しても 1 行のまま。変更は上書きされる", async () => {
    await sync([entry()]);
    const plan = await sync([entry({ name: "こども未来館（改名）", type: "html", enabled: false })]);
    expect(plan.updated).toEqual(["https://example.jp/miraikan.pdf"]);
    expect(plan.inserted).toEqual([]);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ name: "こども未来館（改名）", type: "html", enabled: 0, status: "approved" });
  });

  it("ファイルで policy を省略しても、D1 にある確認結果は消さない", async () => {
    await sync([entry({ policy: { status: "caution", checkedAt: "2026-11-03", note: "規約が曖昧" } })]);
    await sync([entry({ policy: null })]);
    expect((await rows())[0]).toMatchObject({
      policy_status: "caution",
      policy_checked_at: "2026-11-03",
      policy_note: "規約が曖昧",
    });
  });

  it("ファイルから消えた owner の行は削除せず無効にする（過去のイベントを残す）", async () => {
    await sync([entry({ url: "https://example.jp/a" }), entry({ url: "https://example.jp/b" })]);
    const plan = await sync([entry({ url: "https://example.jp/a" })]);
    expect(plan.disabled).toEqual(["https://example.jp/b"]);
    expect((await rows()).map((r) => [r.url, r.enabled])).toEqual([
      ["https://example.jp/a", 1],
      ["https://example.jp/b", 0],
    ]);
  });

  it("ファイルが空なら owner の行はすべて無効になる", async () => {
    await sync([entry({ url: "https://example.jp/a" })]);
    const plan = await sync([]);
    expect(plan.disabled).toEqual(["https://example.jp/a"]);
    expect((await rows())[0]).toMatchObject({ enabled: 0 });
  });

  it("owner 以外（施設投稿）の行は触らない。同じ URL がファイルにあってもスキップ", async () => {
    await insertFacilitySource("https://example.jp/facility");
    await insertFacilitySource("https://example.jp/conflict");
    const plan = await sync([entry({ url: "https://example.jp/conflict", name: "上書きしたい" })]);
    expect(plan.skipped).toEqual([
      { url: "https://example.jp/conflict", reason: expect.stringMatching(/facility/) },
    ]);
    expect(plan.disabled).toEqual([]);
    expect(await rows()).toEqual([
      expect.objectContaining({ url: "https://example.jp/conflict", name: "施設からの投稿", submitted_by: "facility", status: "pending", enabled: 1 }),
      expect.objectContaining({ url: "https://example.jp/facility", submitted_by: "facility", status: "pending", enabled: 1 }),
    ]);
  });

  it("計画の後に施設投稿が入っても、SQL 側でも owner 以外は上書きしない", async () => {
    const plan = planSync([entry({ url: "https://example.jp/race", name: "上書きしたい" })], []);
    await insertFacilitySource("https://example.jp/race");
    await env.DB.batch(plan.statements.map((s) => env.DB.prepare(s)));
    expect((await rows())[0]).toMatchObject({ name: "施設からの投稿", submitted_by: "facility" });
  });

  it("シングルクォートなどを含む値も壊れずに入る", async () => {
    const name = "O'Brien こども館; DROP TABLE sources; --";
    await sync([entry({ name, note: "x" })]);
    expect((await rows())[0]).toMatchObject({ name });
  });

  it("無効化済みの行はもう一度無効化の対象にしない", async () => {
    await sync([entry({ url: "https://example.jp/a" })]);
    await sync([]);
    const plan = await sync([]);
    expect(plan.disabled).toEqual([]);
  });
});

describe("planSync（クロール対象との関係）", () => {
  it("同期した行のうち有効なものだけがクロール対象になる", async () => {
    await insertFacilitySource("https://example.jp/facility");
    await sync([
      entry({ url: "https://example.jp/on" }),
      entry({ url: "https://example.jp/off", enabled: false }),
      entry({ url: "https://example.jp/ng", policy: { status: "ng", checkedAt: "2026-11-03", note: "規約で禁止" } }),
    ]);
    const targets = await crawlTargets(drizzle(env.DB));
    expect(targets.map((t) => t.url)).toEqual(["https://example.jp/on"]);
  });
});
