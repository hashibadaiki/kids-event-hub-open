import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import page from "./fixtures/page.html?raw";
import { crawlSource, type CrawlDeps, type SourceRow } from "../src/crawl/run";
import { extractHtml } from "../src/extract/html";
import { parseExtractionConfig } from "../src/extract/config";
import { ensureActiveConfig, improveSource, improveLowQuality, saveRawDocument, RAW_DOCS_PER_SOURCE } from "../src/improve/improve";
import type { ClaudeClient, ToolSpec } from "../src/claude";

const NOW = new Date("2026-11-03T18:00:00Z");
const PAGE_URL = "https://example.jp/events/";

async function addSource(type = "html") {
  const r = await env.DB.prepare(
    "INSERT INTO sources (name, url, type, prefecture, status) VALUES ('テスト', ?, ?, '香川県', 'approved') RETURNING id",
  )
    .bind(PAGE_URL, type)
    .first<{ id: number }>();
  return r!.id;
}

const source = async (id: number) => (await env.DB.prepare("SELECT * FROM sources WHERE id = ?").bind(id).first())! as SourceRow;
const configs = async (sourceId: number) =>
  (
    await env.DB.prepare("SELECT * FROM extraction_configs WHERE source_id = ? ORDER BY version").bind(sourceId).all<Record<string, unknown>>()
  ).results;
const evaluations = async () => (await env.DB.prepare("SELECT * FROM config_evaluations ORDER BY id").all<Record<string, unknown>>()).results;

// 現行の設定では会場・年齢が取れず、改善案（ヒント付き）では取れる、という Claude のモック
const POOR = { events: [{ title: "親子リトミック", date_text: "11月10日" }, { title: "工作教室", date_text: "日付不明" }] };
const GOOD = {
  events: [
    { title: "親子リトミック", date_text: "11月10日（火） 10:30", venue: "多目的室", age_text: "1～3歳と保護者" },
    { title: "工作教室「どんぐりごま」", date_text: "11月15日（日） 午後2時", venue: "工作室", age_text: "小学生" },
  ],
};
const PROPOSAL = {
  instructions: "1 行に 1 イベントが書かれた一覧です。会場は「会場：」の後ろにあります。",
  hints: ["対象年齢は「対象：」の後ろ"],
  selectors: ["ul"],
  reason: "会場と対象年齢の取りこぼしが多いため、書式のヒントを足す",
};

function fakeClaude(opts: { proposal?: unknown; improved?: unknown } = {}) {
  const calls: { tool: string; system: string; prompt: string }[] = [];
  const claude: ClaudeClient = {
    callTool: vi.fn(async ({ system, prompt, tool }: { system: string; prompt: string; tool: ToolSpec }) => {
      calls.push({ tool: tool.name, system, prompt });
      if (tool.name === "propose_extraction_config") return opts.proposal ?? PROPOSAL;
      if (tool.name === "record_events") return system.includes("会場は「会場：」") ? (opts.improved ?? GOOD) : POOR;
      return { summaries: [] };
    }),
  };
  return { claude, calls };
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM config_evaluations"),
    env.DB.prepare("DELETE FROM raw_documents"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM crawl_runs"),
    env.DB.prepare("DELETE FROM extraction_configs"),
    env.DB.prepare("DELETE FROM sources"),
  ]);
});

describe("抽出設定（extraction config）", () => {
  it("不正な値は無視して既定（空）にする", () => {
    expect(parseExtractionConfig(null)).toEqual({});
    expect(parseExtractionConfig({ instructions: 1, hints: ["a", 2, " "], selectors: "ul" })).toEqual({ hints: ["a"] });
    expect(parseExtractionConfig(JSON.stringify(PROPOSAL))).toEqual({
      instructions: PROPOSAL.instructions,
      hints: PROPOSAL.hints,
      selectors: PROPOSAL.selectors,
    });
  });

  it("指示とヒントをシステムプロンプトに足し、セレクタで本文を絞る", async () => {
    const { claude, calls } = fakeClaude();
    await extractHtml(page, PAGE_URL, claude, { instructions: "会場は「会場：」の後ろ", hints: ["ヒントA"], selectors: ["ul"] });
    expect(calls[0]!.system).toContain("会場は「会場：」の後ろ");
    expect(calls[0]!.system).toContain("ヒントA");
    expect(calls[0]!.prompt).toContain("親子リトミック");
    expect(calls[0]!.prompt).not.toContain("サイトポリシー"); // nav は落ちる
  });

  it("セレクタに何も一致しなければページ全体を使う", async () => {
    const { claude, calls } = fakeClaude();
    await extractHtml(page, PAGE_URL, claude, { selectors: ["#no-such-id"] });
    expect(calls[0]!.prompt).toContain("サイトポリシー");
  });
});

describe("版の初期化", () => {
  it("active な設定がなければ v1（空の設定）を active として作る。2 回目は同じものを返す", async () => {
    const id = await addSource();
    const a = await ensureActiveConfig(env.DB, id, NOW);
    const b = await ensureActiveConfig(env.DB, id, NOW);
    expect(a).toEqual(b);
    expect(await configs(id)).toMatchObject([{ version: 1, status: "active", parent_config_id: null }]);
  });
});

describe("生データの保存", () => {
  it(`収集元ごとに新しい ${RAW_DOCS_PER_SOURCE} 件だけ残す`, async () => {
    const id = await addSource();
    for (let i = 0; i < RAW_DOCS_PER_SOURCE + 2; i++) {
      await saveRawDocument(env.DB, { sourceId: id, runId: null, url: `${PAGE_URL}?p=${i}`, contentType: "text/html", body: `<p>${i}</p>`, fetchedAt: new Date(NOW.getTime() + i * 1000) });
    }
    const { results } = await env.DB.prepare("SELECT url FROM raw_documents WHERE source_id = ? ORDER BY fetched_at").bind(id).all<{ url: string }>();
    expect(results.map((r) => r.url)).toEqual([2, 3, 4].map((i) => `${PAGE_URL}?p=${i}`));
  });
});

describe("crawlSource と抽出設定・採点", () => {
  it("active な設定で抽出し、使った版・品質スコア・生データを記録する", async () => {
    const id = await addSource();
    const { claude } = fakeClaude();
    const d: CrawlDeps = {
      fetch: vi.fn(async () => new Response(page, { headers: { "content-type": "text/html" } })) as unknown as typeof fetch,
      claude,
      now: () => NOW,
      sleep: async () => {},
    };
    const r = await crawlSource(env.DB, await source(id), d);
    const [cfg] = await configs(id);
    const run = await env.DB.prepare("SELECT * FROM crawl_runs WHERE id = ?").bind(r.runId).first<Record<string, unknown>>();
    expect(run).toMatchObject({ config_id: cfg!.id });
    expect(run!.quality_score).toBeCloseTo(r.quality!.score, 3);
    expect(r.quality!.score).toBeLessThan(0.7); // POOR の応答
    const raw = await env.DB.prepare("SELECT * FROM raw_documents WHERE source_id = ?").bind(id).first<Record<string, unknown>>();
    expect(raw).toMatchObject({ crawl_run_id: r.runId, url: PAGE_URL, content_type: "text/html", body: page });
  });
});

describe("improveSource（改善案 → 検証 → 採否）", () => {
  async function seed() {
    const id = await addSource();
    await saveRawDocument(env.DB, { sourceId: id, runId: null, url: PAGE_URL, contentType: "text/html", body: page, fetchedAt: NOW });
    return id;
  }

  it("改善案のほうがスコアが高ければ新しい版として採用し、旧版は retired にする", async () => {
    const id = await seed();
    const { claude, calls } = fakeClaude();
    const r = await improveSource(env.DB, id, { claude, now: () => NOW });

    expect(r.decision).toBe("adopted");
    expect(r.candidate!.score).toBeGreaterThan(r.baseline!.score);
    const [v1, v2] = await configs(id);
    expect(v1).toMatchObject({ version: 1, status: "retired" });
    expect(v1!.quality_score).toBeCloseTo(r.baseline!.score, 3);
    expect(v2).toMatchObject({ version: 2, status: "active", parent_config_id: v1!.id, adopted_at: NOW.toISOString(), note: PROPOSAL.reason });
    expect(v2!.quality_score).toBeCloseTo(r.candidate!.score, 3);
    expect(JSON.parse(v2!.config as string)).toEqual({ instructions: PROPOSAL.instructions, hints: PROPOSAL.hints, selectors: PROPOSAL.selectors });

    // Claude には現在の設定と失敗したサンプルを渡している
    const propose = calls.find((c) => c.tool === "propose_extraction_config")!;
    expect(propose.prompt).toContain("工作教室"); // 日付が取れなかったサンプル
    expect(propose.prompt).toContain("現在の抽出設定");

    // 前後比較を記録する
    const [ev] = await evaluations();
    expect(ev).toMatchObject({ source_id: id, baseline_config_id: v1!.id, candidate_config_id: v2!.id, decision: "adopted", sample_count: 1 });
    expect(JSON.parse(ev!.candidate_metrics as string)).toMatchObject({ venueRate: 1 });
  });

  it("良くならなければ採用しない（候補は rejected、旧版は active のまま）", async () => {
    const id = await seed();
    const { claude } = fakeClaude({ improved: POOR });
    const r = await improveSource(env.DB, id, { claude, now: () => NOW });
    expect(r.decision).toBe("rejected");
    expect(await configs(id)).toMatchObject([
      { version: 1, status: "active" },
      { version: 2, status: "rejected" },
    ]);
    expect(await evaluations()).toMatchObject([{ decision: "rejected" }]);
  });

  it("採用後にもう一度回すと、v2 を親にした v3 を作る", async () => {
    const id = await seed();
    await improveSource(env.DB, id, { claude: fakeClaude().claude, now: () => NOW });
    const r = await improveSource(env.DB, id, { claude: fakeClaude({ improved: POOR }).claude, now: () => NOW });
    const cs = await configs(id);
    expect(cs.map((c) => [c.version, c.status])).toEqual([
      [1, "retired"],
      [2, "active"],
      [3, "rejected"],
    ]);
    expect(cs[2]!.parent_config_id).toBe(cs[1]!.id);
    expect(r.decision).toBe("rejected");
  });

  it("保存済みの生データがなければ何もしない", async () => {
    const id = await addSource();
    const { claude } = fakeClaude();
    const r = await improveSource(env.DB, id, { claude, now: () => NOW });
    expect(r.decision).toBe("skipped");
    expect(claude.callTool).not.toHaveBeenCalled();
  });

  it("Claude の改善案が壊れていたら候補を作らない", async () => {
    const id = await seed();
    const { claude } = fakeClaude({ proposal: { reason: 1 } });
    const r = await improveSource(env.DB, id, { claude, now: () => NOW });
    expect(r.decision).toBe("skipped");
    expect(await configs(id)).toHaveLength(1);
  });
});

describe("improveLowQuality", () => {
  it("閾値を下回った HTML / LLM の収集元だけ改善ジョブを回す", async () => {
    const id = await addSource();
    await saveRawDocument(env.DB, { sourceId: id, runId: null, url: PAGE_URL, contentType: "text/html", body: page, fetchedAt: NOW });
    const { claude } = fakeClaude();
    const base = { runId: 1, status: "success" as const, extracted: 2, dateFound: 1, upserted: 1, duplicates: 0, error: null };
    const out = await improveLowQuality(
      env.DB,
      [
        { ...base, sourceId: id, type: "html", quality: { score: 0.4 } },
        { ...base, sourceId: 9999, type: "ical", quality: { score: 0.1 } }, // 決まった形式は対象外
        { ...base, sourceId: 9998, type: "html", quality: { score: 0.9 } }, // 閾値以上
        { ...base, sourceId: 9997, type: "html", quality: null }, // 採点できなかった
      ],
      { claude, now: () => NOW },
    );
    expect(out.map((o) => [o.sourceId, o.decision])).toEqual([[id, "adopted"]]);
  });

  it("Claude がなければ何もしない", async () => {
    const out = await improveLowQuality(env.DB, [], { claude: null, now: () => NOW });
    expect(out).toEqual([]);
  });
});
