import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import ics from "./fixtures/events.ics?raw";
import jsonldHtml from "./fixtures/jsonld.html?raw";
import page from "./fixtures/page.html?raw";
import flyerDataUrl from "./fixtures/flyer.pdf?inline";
import { crawlSource, crawlAll, collect, MAX_HTML_PAGES, type CrawlDeps, type SourceRow } from "../src/crawl/run";
import { findNextPageLink } from "../src/crawl/pager";
import { toEventRow, dedupKeyOf } from "../src/crawl/normalize";
import type { ClaudeClient } from "../src/claude";

type Routes = Record<string, Response | (() => Response)>;

function fakeFetch(routes: Routes) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const r = routes[url];
    if (!r) return new Response("not found", { status: 404 });
    return typeof r === "function" ? r() : r.clone();
  });
}

function deps(routes: Routes, claude: ClaudeClient | null = null): CrawlDeps & { fetch: ReturnType<typeof fakeFetch> } {
  return {
    fetch: fakeFetch(routes),
    claude,
    now: () => new Date("2026-11-03T18:00:00Z"),
    sleep: async () => {},
  };
}

async function addSource(url: string, type = "html", extra: Record<string, unknown> = {}) {
  const cols = { name: "テスト", url, type, prefecture: "香川県", status: "approved", ...extra };
  const keys = Object.keys(cols);
  const r = await env.DB.prepare(
    `INSERT INTO sources (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")}) RETURNING id`,
  )
    .bind(...Object.values(cols))
    .first<{ id: number }>();
  return r!.id;
}

async function source(id: number) {
  return (await env.DB.prepare("SELECT * FROM sources WHERE id = ?").bind(id).first())! as SourceRow;
}

const events = async () =>
  (
    await env.DB.prepare(
      "SELECT source_id, crawl_run_id, title, start_at, end_at, all_day, venue, age_min, age_max, price_free, price_min_yen, categories, source_url, summary FROM events ORDER BY start_at",
    ).all()
  ).results;
const runs = async () => (await env.DB.prepare("SELECT * FROM crawl_runs ORDER BY id").all()).results;

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM events"), env.DB.prepare("DELETE FROM crawl_runs"), env.DB.prepare("DELETE FROM sources")]);
});

describe("toEventRow", () => {
  const ctx = { prefecture: "香川県", sourceUrl: "https://a.jp/list", referenceDate: new Date("2026-11-03T00:00:00Z") };

  it("日付テキスト・年齢・料金・カテゴリを正規化する", () => {
    const row = toEventRow(
      { title: "工作教室「どんぐりごま」", dateText: "11月15日（日） 午後2時から", ageText: "小学生", priceText: "材料費100円" },
      ctx,
    );
    expect(row).toMatchObject({
      title: "工作教室「どんぐりごま」",
      startAt: "2026-11-15T14:00",
      allDay: false,
      prefecture: "香川県",
      ageMin: 6,
      ageMax: 12,
      priceFree: false,
      priceMinYen: 100,
      categories: ["craft"],
      sourceUrl: "https://a.jp/list",
    });
    expect(row!.dedupKey).toBe(dedupKeyOf("香川県", "2026-11-15T14:00", "工作教室「どんぐりごま」"));
  });

  it("日付が取れない候補は保存しない（null）", () => {
    expect(toEventRow({ title: "休館日のお知らせ", dateText: "館内工事のため休館" }, ctx)).toBeNull();
  });

  it("説明文は転載しない。要約がなければ summary は null", () => {
    const row = toEventRow({ title: "a", start: "2026-11-20", allDay: true, description: "あ".repeat(300) }, ctx);
    expect(row!.summary).toBeNull();
  });
});

const pdfResponse = () => new Response(Uint8Array.from(atob(flyerDataUrl.slice(flyerDataUrl.indexOf(",") + 1)), (c) => c.charCodeAt(0)), { headers: { "content-type": "application/pdf" } });
const pdfEvents = [
  { title: "紙コップ工作", dates: ["2026年11月15日"], time_text: "10:00〜12:00", apply_text: "電話で受付", summary: "親子工作" },
  { title: "星空観察会", dates: ["2026年11月21日"], time_text: "18:30〜20:00" },
];

describe("crawlSource", () => {
  it("iCal を取得して events に保存し、crawl_runs に件数を記録する", async () => {
    const id = await addSource("https://example.jp/cal.ics", "ical");
    const d = deps({
      "https://example.jp/robots.txt": new Response("User-agent: *\nDisallow: /private/"),
      "https://example.jp/cal.ics": new Response(ics, { headers: { "content-type": "text/calendar" } }),
    });
    const result = await crawlSource(env.DB, await source(id), d);
    expect(result).toMatchObject({ status: "success", extracted: 3, dateFound: 3, upserted: 3 });

    const saved = await events();
    expect(saved.map((e) => [e.title, e.start_at])).toEqual([
      ["星空観察会", "2026-11-21T18:30"],
      ["UTC の予定", "2026-12-01T10:00"],
      ["冬休みこども工作ひろば", "2026-12-26"],
    ]);
    expect(saved[0]).toMatchObject({ venue: "さぬきこどもの国", source_url: "https://example.jp/ev/1", price_free: 1, age_min: 6 });

    const [run] = await runs();
    expect(run).toMatchObject({
      source_id: id,
      status: "success",
      fetched_count: 1,
      extracted_count: 3,
      date_found_count: 3,
      upserted_count: 3,
      error_message: null,
    });
    expect(run!.finished_at).not.toBeNull();
    expect(saved.every((e) => e.crawl_run_id === run!.id)).toBe(true);

    // User-Agent を付けて取得している
    const ua = new Headers((d.fetch.mock.calls[1] as unknown as [string, RequestInit])[1].headers).get("user-agent");
    expect(ua).toContain("kids-event-hub-crawler");
  });

  it("2 回目は同じイベントを更新し、二重登録しない", async () => {
    const id = await addSource("https://example.jp/cal.ics", "ical");
    const routes = { "https://example.jp/cal.ics": new Response(ics, { headers: { "content-type": "text/calendar" } }) };
    await crawlSource(env.DB, await source(id), deps(routes));
    await crawlSource(env.DB, await source(id), deps(routes));
    expect(await events()).toHaveLength(3);
  });

  it("別の収集元にある同じイベント（表記ゆれ）は重複として入れない", async () => {
    const a = await addSource("https://example.jp/cal.ics", "ical");
    const b = await addSource("https://other.jp/list", "jsonld");
    await crawlSource(env.DB, await source(a), deps({ "https://example.jp/cal.ics": new Response(ics, { headers: { "content-type": "text/calendar" } }) }));
    const html = `<script type="application/ld+json">{"@type":"Event","name":"星空 観察会！","startDate":"2026-11-21T18:30:00+09:00","location":"さぬきこどもの国"}</script>`;
    const r = await crawlSource(env.DB, await source(b), deps({ "https://other.jp/list": new Response(html, { headers: { "content-type": "text/html" } }) }));
    expect(r).toMatchObject({ extracted: 1, dateFound: 1, upserted: 0, duplicates: 1 });
    expect(await events()).toHaveLength(3);
  });

  it("JSON-LD は日付が取れなかった分を partial として記録する", async () => {
    const id = await addSource("https://example.jp/list/", "jsonld");
    const r = await crawlSource(
      env.DB,
      await source(id),
      deps({ "https://example.jp/list/": new Response(jsonldHtml, { headers: { "content-type": "text/html" } }) }),
    );
    expect(r).toMatchObject({ status: "partial", extracted: 3, dateFound: 2, upserted: 2 });
  });

  it("iCal の説明文は Claude で要約して保存し、説明文そのものは保存しない", async () => {
    const id = await addSource("https://example.jp/cal.ics", "ical");
    const claude: ClaudeClient = {
      callTool: vi.fn(async () => ({ summaries: [{ index: 0, summary: "望遠鏡で月と土星を観察します" }] })),
    };
    const routes = { "https://example.jp/cal.ics": new Response(ics, { headers: { "content-type": "text/calendar" } }) };
    const r = await crawlSource(env.DB, await source(id), deps(routes, claude));
    expect(r).toMatchObject({ status: "success", upserted: 3, error: null });
    const star = (await events()).find((e) => e.title === "星空観察会");
    expect(star!.summary).toBe("望遠鏡で月と土星を観察します");
    expect(claude.callTool).toHaveBeenCalledTimes(1);
  });

  it("Claude がなければ要約は空のまま保存する（説明文は使わない）", async () => {
    const id = await addSource("https://example.jp/cal.ics", "ical");
    const routes = { "https://example.jp/cal.ics": new Response(ics, { headers: { "content-type": "text/calendar" } }) };
    const r = await crawlSource(env.DB, await source(id), deps(routes));
    expect(r).toMatchObject({ status: "success", upserted: 3 });
    expect((await events()).every((e) => e.summary === null)).toBe(true);
  });

  it("要約に失敗してもイベントは保存し、理由を crawl_runs に残す", async () => {
    const id = await addSource("https://example.jp/cal.ics", "ical");
    const claude: ClaudeClient = { callTool: vi.fn(async () => Promise.reject(new Error("HTTP 529"))) };
    const routes = { "https://example.jp/cal.ics": new Response(ics, { headers: { "content-type": "text/calendar" } }) };
    const r = await crawlSource(env.DB, await source(id), deps(routes, claude));
    expect(r).toMatchObject({ status: "success", upserted: 3 });
    expect((await events()).every((e) => e.summary === null)).toBe(true);
    expect((await runs())[0]!.error_message).toContain("要約");
  });

  it("HTML は Claude で構造化する（LLM 抽出）", async () => {
    const id = await addSource("https://example.jp/events/", "html");
    const claude: ClaudeClient = {
      callTool: vi.fn(async () => ({
        events: [{ title: "親子リトミック", date_text: "11月10日（火） 10:30～11:15", age_text: "1～3歳と保護者", price_text: "無料", summary: "親子で音楽あそび", url: "/ev/1" }],
      })),
    };
    const r = await crawlSource(env.DB, await source(id), deps({ "https://example.jp/events/": new Response(page, { headers: { "content-type": "text/html" } }) }, claude));
    expect(r).toMatchObject({ status: "success", type: "html", upserted: 1 });
    expect((await events())[0]).toMatchObject({ title: "親子リトミック", start_at: "2026-11-10T10:30", source_url: "https://example.jp/ev/1", summary: "親子で音楽あそび" });
  });

  it("JSON-LD が見つからないページは LLM にフォールバックする", async () => {
    const id = await addSource("https://example.jp/events/", "jsonld");
    const claude: ClaudeClient = { callTool: vi.fn(async () => ({ events: [{ title: "工作教室", date_text: "11月15日" }] })) };
    const r = await crawlSource(env.DB, await source(id), deps({ "https://example.jp/events/": new Response(page, { headers: { "content-type": "text/html" } }) }, claude));
    expect(r).toMatchObject({ type: "llm", upserted: 1 });
  });

  it("robots.txt で禁止されたパスは取得せず failed を記録する", async () => {
    const id = await addSource("https://example.jp/private/cal.ics", "ical");
    const d = deps({ "https://example.jp/robots.txt": new Response("User-agent: *\nDisallow: /private/") });
    const r = await crawlSource(env.DB, await source(id), d);
    expect(r.status).toBe("failed");
    expect(d.fetch).toHaveBeenCalledTimes(1); // robots.txt だけ
    expect((await runs())[0]).toMatchObject({ status: "failed", error_message: expect.stringContaining("robots.txt") });
  });

  it("robots.txt で禁止されていたら収集元を rejected / ng にし、根拠の URL と規則を残す", async () => {
    const id = await addSource("https://example.jp/private/cal.ics", "ical", { policy_status: "ok" });
    const d = deps({ "https://example.jp/robots.txt": new Response("User-agent: *\nDisallow: /private/") });
    await crawlSource(env.DB, await source(id), d);
    const s = await source(id);
    expect(s).toMatchObject({ status: "rejected", policy_status: "ng", policy_checked_at: "2026-11-03T18:00:00.000Z" });
    expect(s.policy_note).toContain("https://example.jp/robots.txt");
    expect(s.policy_note).toContain("Disallow: /private/");
    expect(s.policy_note).toContain("https://example.jp/private/cal.ics");
    expect((await runs())[0]!.error_message).toContain("https://example.jp/robots.txt");
  });

  it("robots.txt を確認できなかっただけなら収集元は rejected にしない", async () => {
    const id = await addSource("https://example.jp/cal.ics", "ical");
    const d = deps({ "https://example.jp/robots.txt": new Response("error", { status: 503 }) });
    await crawlSource(env.DB, await source(id), d);
    expect(await source(id)).toMatchObject({ status: "approved", policy_status: null });
  });

  it("HTML・PDF なのに Claude がなければ failed として記録する", async () => {
    const id = await addSource("https://example.jp/events/", "html");
    const r = await crawlSource(env.DB, await source(id), deps({ "https://example.jp/events/": new Response(page, { headers: { "content-type": "text/html" } }) }));
    expect(r).toMatchObject({ status: "failed", error: expect.stringContaining("ANTHROPIC_API_KEY") });

    const pdf = await addSource("https://example.jp/a.pdf", "pdf");
    const r2 = await crawlSource(env.DB, await source(pdf), deps({ "https://example.jp/a.pdf": new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } }) }));
    expect(r2).toMatchObject({ status: "failed", type: "pdf", error: expect.stringContaining("ANTHROPIC_API_KEY") });
  });

  it("PDF チラシを Claude で構造化し、掲載元を PDF の URL・申込方法付きで保存する", async () => {
    const id = await addSource("https://example.jp/dayori.pdf", "pdf");
    const claude = { callTool: vi.fn(async () => ({ events: pdfEvents })) } satisfies ClaudeClient;
    const r = await crawlSource(env.DB, await source(id), deps({ "https://example.jp/dayori.pdf": pdfResponse() }, claude));
    expect(r).toMatchObject({ status: "success", type: "pdf", extracted: 2, dateFound: 2, upserted: 2, error: null });
    expect(claude.callTool).toHaveBeenCalledTimes(1);
    const saved = await env.DB.prepare("SELECT title, start_at, source_url, apply_text, summary FROM events ORDER BY start_at").all();
    expect(saved.results).toEqual([
      { title: "紙コップ工作", start_at: "2026-11-15T10:00", source_url: "https://example.jp/dayori.pdf", apply_text: "電話で受付", summary: "親子工作" },
      { title: "星空観察会", start_at: "2026-11-21T18:30", source_url: "https://example.jp/dayori.pdf", apply_text: null, summary: null },
    ]);
  });

  it("PDF も品質を採点して記録するが、生データ（バイナリ）は自動改善用に保存しない", async () => {
    const id = await addSource("https://example.jp/dayori.pdf", "pdf");
    const claude = { callTool: vi.fn(async () => ({ events: pdfEvents })) } satisfies ClaudeClient;
    const r = await crawlSource(env.DB, await source(id), deps({ "https://example.jp/dayori.pdf": pdfResponse() }, claude));
    expect(r.quality).not.toBeNull();
    const run = await env.DB.prepare("SELECT quality_score, config_id FROM crawl_runs WHERE id = ?").bind(r.runId).first<{ quality_score: number | null; config_id: number | null }>();
    expect(run?.quality_score).toBe(r.quality!.score);
    expect(run?.config_id).not.toBeNull();
    const raw = await env.DB.prepare("SELECT count(*) AS n FROM raw_documents WHERE source_id = ?").bind(id).first<{ n: number }>();
    expect(raw?.n).toBe(0);
  });

  it("PDF の収集元が HTML の一覧ページなら、同じホストの PDF リンクをたどる（robots.txt で禁止された PDF は取らない）", async () => {
    const id = await addSource("https://example.jp/kodomo/", "pdf");
    const listing = `<a href="/files/a.pdf">A</a><a href="/private/b.pdf">B</a><a href="https://other.example.com/c.pdf">C</a>`;
    const claude = { callTool: vi.fn(async () => ({ events: [pdfEvents[0]] })) } satisfies ClaudeClient;
    const d = deps(
      {
        "https://example.jp/robots.txt": new Response("User-agent: *\nDisallow: /private/"),
        "https://example.jp/kodomo/": new Response(listing, { headers: { "content-type": "text/html" } }),
        "https://example.jp/files/a.pdf": pdfResponse(),
      },
      claude,
    );
    const r = await crawlSource(env.DB, await source(id), d);
    expect(r).toMatchObject({ status: "partial", type: "pdf", extracted: 1, upserted: 1 });
    expect(r.error).toContain("https://example.jp/private/b.pdf");
    const fetched = d.fetch.mock.calls.map((c) => String(c[0]));
    expect(fetched).not.toContain("https://example.jp/private/b.pdf");
    expect(fetched).not.toContain("https://other.example.com/c.pdf");
    expect((await runs())[0]).toMatchObject({ fetched_count: 2 });
    expect((await source(id)).status).toBe("approved");
    expect((await events())[0]).toMatchObject({ source_url: "https://example.jp/files/a.pdf" });
  });

  it("一覧ページに PDF へのリンクがなければ failed", async () => {
    const id = await addSource("https://example.jp/kodomo/", "pdf");
    const claude = { callTool: vi.fn() } satisfies ClaudeClient;
    const r = await crawlSource(
      env.DB,
      await source(id),
      deps({ "https://example.jp/kodomo/": new Response("<p>準備中</p>", { headers: { "content-type": "text/html" } }) }, claude),
    );
    expect(r).toMatchObject({ status: "failed", error: expect.stringContaining("PDF") });
    expect(claude.callTool).not.toHaveBeenCalled();
  });

  it("取得エラーは failed として記録し、例外にしない", async () => {
    const id = await addSource("https://example.jp/cal.ics", "ical");
    const r = await crawlSource(env.DB, await source(id), deps({ "https://example.jp/cal.ics": new Response("x", { status: 500 }) }));
    expect(r.status).toBe("failed");
    expect((await runs())[0]).toMatchObject({ status: "failed", error_message: expect.stringContaining("500") });
  });
});

describe("crawlSource（PDF の一覧ページ）: 抽出済みの PDF は読み直さない", () => {
  const LIST = "https://example.jp/kodomo/";
  const listing = (...names: string[]) =>
    new Response(names.map((n) => `<a href="/files/${n}.pdf">${n}</a>`).join(""), { headers: { "content-type": "text/html" } });
  const pdfRoutes = (...names: string[]) => Object.fromEntries(names.map((n) => [`https://example.jp/files/${n}.pdf`, pdfResponse]));
  const fetchedPdfs = (d: ReturnType<typeof deps>) =>
    d.fetch.mock.calls.map((c) => String(c[0])).filter((u) => u.endsWith(".pdf"));

  it("2 回目は新しく載った PDF だけを取得・抽出する", async () => {
    const id = await addSource(LIST, "pdf");
    const claude = { callTool: vi.fn(async () => ({ events: [pdfEvents[0]] })) } satisfies ClaudeClient;
    await crawlSource(env.DB, await source(id), deps({ [LIST]: listing("a"), ...pdfRoutes("a") }, claude));
    expect(claude.callTool).toHaveBeenCalledTimes(1);

    const d = deps({ [LIST]: listing("a", "b"), ...pdfRoutes("a", "b") }, claude);
    const r = await crawlSource(env.DB, await source(id), d);
    expect(fetchedPdfs(d)).toEqual(["https://example.jp/files/b.pdf"]);
    expect(claude.callTool).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ status: "success", type: "pdf", extracted: 1 });
  });

  it("新しい PDF がなければ PDF を取得せず、成功として記録する（品質は採点しない）", async () => {
    const id = await addSource(LIST, "pdf");
    const claude = { callTool: vi.fn(async () => ({ events: [pdfEvents[0]] })) } satisfies ClaudeClient;
    await crawlSource(env.DB, await source(id), deps({ [LIST]: listing("a"), ...pdfRoutes("a") }, claude));

    const d = deps({ [LIST]: listing("a"), ...pdfRoutes("a") }, claude);
    const r = await crawlSource(env.DB, await source(id), d);
    expect(fetchedPdfs(d)).toEqual([]);
    expect(claude.callTool).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ status: "success", extracted: 0, quality: null, error: null });
    expect((await runs())[1]).toMatchObject({ status: "success", quality_score: null });
  });

  it("1 回に処理する新しい PDF は 5 件まで。残りは次回に回す", async () => {
    const id = await addSource(LIST, "pdf");
    const names = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
    const claude = { callTool: vi.fn(async () => ({ events: [pdfEvents[0]] })) } satisfies ClaudeClient;
    const d1 = deps({ [LIST]: listing(...names), ...pdfRoutes(...names) }, claude);
    const r1 = await crawlSource(env.DB, await source(id), d1);
    expect(fetchedPdfs(d1)).toHaveLength(5);
    expect(r1.status).toBe("success");
    expect(r1.error).toContain("2 件");

    const d2 = deps({ [LIST]: listing(...names), ...pdfRoutes(...names) }, claude);
    await crawlSource(env.DB, await source(id), d2);
    expect(fetchedPdfs(d2)).toEqual(["https://example.jp/files/p6.pdf", "https://example.jp/files/p7.pdf"]);
  });

  it("古い月の PDF が先頭に並ぶ一覧でも、11 件目以降の新しい PDF に順に届く", async () => {
    const id = await addSource(LIST, "pdf");
    const names = Array.from({ length: 12 }, (_, i) => `m${i + 1}`);
    const claude = { callTool: vi.fn(async () => ({ events: [pdfEvents[0]] })) } satisfies ClaudeClient;
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const d = deps({ [LIST]: listing(...names), ...pdfRoutes(...names) }, claude);
      await crawlSource(env.DB, await source(id), d);
      seen.push(...fetchedPdfs(d));
    }
    expect(seen).toHaveLength(12);
    expect(seen).toContain("https://example.jp/files/m12.pdf");
  });

  it("リンク文言の月を読み、今月・来月の号を先に取る（3 施設 × 4〜11 月号の並びで初回に 11 月号 3 本が入る）", async () => {
    const id = await addSource(LIST, "pdf");
    const months = [4, 5, 6, 7, 8, 9, 10, 11];
    const issues = ["じどうかんだより", "すくすくだより", "すくすくだより"].flatMap((label, f) =>
      months.map((m, i) => ({ url: `https://example.jp/uploaded/attachment/${4201 + f * months.length + i}.pdf`, text: `${label}${m}月号 [PDFファイル／4.${m}MB]`, m })),
    );
    const html = issues.map((x) => `<a href="${x.url}">${x.text}</a>`).join("");
    const claude = { callTool: vi.fn(async () => ({ events: [pdfEvents[0]] })) } satisfies ClaudeClient;
    const d = deps(
      { [LIST]: new Response(html, { headers: { "content-type": "text/html" } }), ...Object.fromEntries(issues.map((x) => [x.url, pdfResponse])) },
      claude,
    );
    const r = await crawlSource(env.DB, await source(id), d);
    const byMonth = (m: number) => issues.filter((x) => x.m === m).map((x) => x.url);
    expect(fetchedPdfs(d)).toEqual([...byMonth(11), ...byMonth(10).slice(0, 2)]);
    expect(r).toMatchObject({ status: "success", extracted: 5 });
    expect(r.error).toContain("19 件");
  });

  it("取得・抽出に失敗した PDF は次回に取り直す", async () => {
    const id = await addSource(LIST, "pdf");
    const claude = { callTool: vi.fn(async () => ({ events: [pdfEvents[0]] })) } satisfies ClaudeClient;
    const broken = { "https://example.jp/files/b.pdf": () => new Response("x", { status: 500 }) };
    await crawlSource(env.DB, await source(id), deps({ [LIST]: listing("a", "b"), ...pdfRoutes("a"), ...broken }, claude));

    const d = deps({ [LIST]: listing("a", "b"), ...pdfRoutes("a", "b") }, claude);
    await crawlSource(env.DB, await source(id), d);
    expect(fetchedPdfs(d)).toEqual(["https://example.jp/files/b.pdf"]);
  });

  it("先頭の PDF が失敗し続けても、まだ試していない後ろの PDF を先に取りに行く", async () => {
    const id = await addSource(LIST, "pdf");
    const names = ["x1", "x2", "x3", "x4", "x5", "ok"];
    const claude = { callTool: vi.fn(async () => ({ events: [pdfEvents[0]] })) } satisfies ClaudeClient;
    const r1 = await crawlSource(env.DB, await source(id), deps({ [LIST]: listing(...names), ...pdfRoutes("ok") }, claude));
    expect(r1.status).toBe("failed");

    const d2 = deps({ [LIST]: listing(...names), ...pdfRoutes("ok") }, claude);
    const r2 = await crawlSource(env.DB, await source(id), d2);
    expect(fetchedPdfs(d2)[0]).toBe("https://example.jp/files/ok.pdf");
    expect(r2.extracted).toBe(1);
  });

  it("robots.txt で禁止の PDF は 5 件の枠を使わない", async () => {
    const id = await addSource(LIST, "pdf");
    const html = [1, 2, 3, 4, 5].map((i) => `<a href="/private/p${i}.pdf">p</a>`).join("") + `<a href="/files/a.pdf">a</a>`;
    const claude = { callTool: vi.fn(async () => ({ events: [pdfEvents[0]] })) } satisfies ClaudeClient;
    const d = deps(
      {
        "https://example.jp/robots.txt": new Response("User-agent: *\nDisallow: /private/"),
        [LIST]: new Response(html, { headers: { "content-type": "text/html" } }),
        ...pdfRoutes("a"),
      },
      claude,
    );
    const r = await crawlSource(env.DB, await source(id), d);
    expect(fetchedPdfs(d)).toEqual(["https://example.jp/files/a.pdf"]);
    expect(r).toMatchObject({ status: "partial", extracted: 1 });
  });

  it("3 回失敗した PDF はあきらめて、以後は取得しない", async () => {
    const id = await addSource(LIST, "pdf");
    const claude = { callTool: vi.fn(async () => ({ events: [pdfEvents[0]] })) } satisfies ClaudeClient;
    const tries: string[][] = [];
    for (let i = 0; i < 4; i++) {
      const d = deps({ [LIST]: listing("a", "gone"), ...pdfRoutes("a") }, claude);
      await crawlSource(env.DB, await source(id), d);
      tries.push(fetchedPdfs(d));
    }
    expect(tries.map((t) => t.includes("https://example.jp/files/gone.pdf"))).toEqual([true, true, true, false]);
  });

  it("Claude の障害など、取得の 4xx 以外の失敗は何回続いてもあきらめない", async () => {
    const id = await addSource(LIST, "pdf");
    let down = true;
    const claude = {
      callTool: vi.fn(async () => {
        if (down) throw new Error("529 overloaded");
        return { events: [pdfEvents[0]] };
      }),
    } satisfies ClaudeClient;
    for (let i = 0; i < 4; i++) await crawlSource(env.DB, await source(id), deps({ [LIST]: listing("a"), ...pdfRoutes("a") }, claude));
    down = false;
    const d = deps({ [LIST]: listing("a"), ...pdfRoutes("a") }, claude);
    const r = await crawlSource(env.DB, await source(id), d);
    expect(fetchedPdfs(d)).toEqual(["https://example.jp/files/a.pdf"]);
    expect(r).toMatchObject({ status: "success", extracted: 1 });
  });

  it("イベントが 0 件の PDF も抽出済みとして記録し、ほかの PDF が失敗しても次回は読まない", async () => {
    const id = await addSource(LIST, "pdf");
    const claude = { callTool: vi.fn(async () => ({ events: [] })) } satisfies ClaudeClient;
    const r1 = await crawlSource(env.DB, await source(id), deps({ [LIST]: listing("form", "gone"), ...pdfRoutes("form") }, claude));
    expect(r1).toMatchObject({ status: "partial", extracted: 0 });

    const d2 = deps({ [LIST]: listing("form", "gone"), ...pdfRoutes("form") }, claude);
    await crawlSource(env.DB, await source(id), d2);
    expect(fetchedPdfs(d2)).not.toContain("https://example.jp/files/form.pdf");
  });

  it("collect は上限を指定できる（pnpm try-extract は一覧の PDF をすべて試す）", async () => {
    const names = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
    const claude = { callTool: vi.fn(async () => ({ events: [pdfEvents[0]] })) } satisfies ClaudeClient;
    const d = deps({ [LIST]: listing(...names), ...pdfRoutes(...names) }, claude);
    await collect({ url: LIST, type: "pdf" }, d, undefined, { maxNewPdfs: Infinity });
    expect(fetchedPdfs(d)).toHaveLength(7);
  });

  it("PDF 直リンクの収集元は毎回読み直す（同じ URL で差し替わるため）", async () => {
    const id = await addSource("https://example.jp/dayori.pdf", "pdf");
    const claude = { callTool: vi.fn(async () => ({ events: pdfEvents })) } satisfies ClaudeClient;
    await crawlSource(env.DB, await source(id), deps({ "https://example.jp/dayori.pdf": pdfResponse() }, claude));
    await crawlSource(env.DB, await source(id), deps({ "https://example.jp/dayori.pdf": pdfResponse() }, claude));
    expect(claude.callTool).toHaveBeenCalledTimes(2);
  });
});

describe("findNextPageLink", () => {
  it("rel=\"next\" のリンクを絶対 URL にして返す", () => {
    const html = '<div class="s_moreButton"><a class="button" href="?page=2&amp;sort=1" title="次のページへ" rel="next">もっと見る</a></div>';
    expect(findNextPageLink(html, "https://example.jp/tenpo/event")).toBe("https://example.jp/tenpo/event?page=2&sort=1");
  });

  it("<link rel=\"next\"> や、rel に複数の値があるリンクも拾う", () => {
    expect(findNextPageLink('<link rel="next" href="/list/2">', "https://example.jp/list/")).toBe("https://example.jp/list/2");
    expect(findNextPageLink("<a rel='nofollow next' href='p2.html'>次へ</a>", "https://example.jp/list/")).toBe("https://example.jp/list/p2.html");
  });

  it("rel=\"next\" がなければ「次へ」の文言のリンクを拾う（岡山市こそだてぽけっとの形）", () => {
    const html =
      '<nav class="page_head"><div class="pager"><ul><li><a href="/ft4/event_search.php?event4_site=6&amp;page=2">2</a></li></ul>' +
      '<p><a href="/ft4/event_search.php?event4_site=6&amp;page=2">次へ</a></p><p><a href="/ft4/event_search.php?event4_site=6&amp;page=6">最後へ</a></p></div></nav>';
    expect(findNextPageLink(html, "https://www.city.okayama.jp/ft4/event_search.php?event4_site=6")).toBe(
      "https://www.city.okayama.jp/ft4/event_search.php?event4_site=6&page=2",
    );
  });

  it.each([
    ["次のページ", '<a href="p2.html">次のページ</a>'],
    ["次のページへ ＞", '<a href="p2.html"><span>次のページへ</span> ＞</a>'],
    ["次へ »", '<a class="next" href="p2.html">次へ&nbsp;&raquo;</a>'],
    ["Next", '<a href="p2.html">Next</a>'],
  ])("文言「%s」のリンクも次のページとみなす", (_label, html) => {
    expect(findNextPageLink(html, "https://example.jp/list/")).toBe("https://example.jp/list/p2.html");
  });

  it("rel=\"next\" があれば文言より優先する", () => {
    const html = '<a href="text.html">次へ</a><a rel="next" href="rel.html">もっと見る</a>';
    expect(findNextPageLink(html, "https://example.jp/list/")).toBe("https://example.jp/list/rel.html");
  });

  it("「次へ」以外の文言や、ページ内リンク・javascript: は拾わない", () => {
    const base = "https://example.jp/list/";
    expect(findNextPageLink('<a href="p6.html">最後へ</a><a href="p0.html">前へ</a>', base)).toBeNull();
    expect(findNextPageLink('<a href="/event/9">次のイベントはこちら</a>', base)).toBeNull();
    expect(findNextPageLink('<a href="#top">次へ</a>', base)).toBeNull();
    expect(findNextPageLink('<a href="javascript:void(0)">次へ</a>', base)).toBeNull();
  });

  it("次のページがなければ null", () => {
    expect(findNextPageLink('<a href="?page=2">2</a><a rel="prev" href="?page=0">前へ</a>', "https://example.jp/")).toBeNull();
  });
});

describe("crawlSource（HTML）: 次のページをたどる", () => {
  const base = "https://example.jp/event";
  const listPage = (title: string, next?: string) =>
    new Response(
      `<html><body><ul><li>【${title}】11月21日（土）</li></ul>${next ? `<a class="button" href="${next}" rel="next">もっと見る</a>` : ""}</body></html>`,
      { headers: { "content-type": "text/html" } },
    );
  const pageClaude = (): ClaudeClient => ({
    callTool: vi.fn(async ({ prompt, tool }) => {
      if (tool.name !== "record_events") return { summaries: [] };
      const titles = [...prompt.matchAll(/【([^】]+)】/g)].map((m) => m[1]);
      return { events: titles.map((title) => ({ title, date_text: "11月21日（土）" })) };
    }),
  });
  const titles = async () => (await events()).map((e) => e.title).sort();

  it("rel=\"next\" をたどって全ページから抽出し、各ページを生データとして保存する", async () => {
    const id = await addSource(base, "html");
    const d = deps(
      {
        [base]: listPage("パズル大会", "?page=1"),
        [`${base}?page=1`]: listPage("わなげ遊び", "?page=2"),
        [`${base}?page=2`]: listPage("親子えいごあそび"),
      },
      pageClaude(),
    );
    const r = await crawlSource(env.DB, await source(id), d);
    expect(r).toMatchObject({ status: "success", type: "html", extracted: 3, upserted: 3 });
    expect(await titles()).toEqual(["パズル大会", "わなげ遊び", "親子えいごあそび"].sort());
    expect((await runs())[0]).toMatchObject({ fetched_count: 3, error_message: null });
    const raw = await env.DB.prepare("SELECT url FROM raw_documents WHERE source_id = ? ORDER BY id").bind(id).all<{ url: string }>();
    expect(raw.results.map((x) => x.url)).toEqual([base, `${base}?page=1`, `${base}?page=2`]);
  });

  it("rel=\"next\" がない「次へ」リンクもたどる", async () => {
    const id = await addSource(base, "html");
    const textPage = (title: string, next?: string) =>
      new Response(
        `<html><body><ul><li>【${title}】11月21日（土）</li></ul>${next ? `<p><a href="${next}">次へ</a></p>` : ""}</body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    const d = deps(
      {
        [base]: textPage("パズル大会", "?page=2"),
        [`${base}?page=2`]: textPage("わなげ遊び"),
      },
      pageClaude(),
    );
    const r = await crawlSource(env.DB, await source(id), d);
    expect(r).toMatchObject({ status: "success", extracted: 2 });
    expect(await titles()).toEqual(["パズル大会", "わなげ遊び"].sort());
  });

  it(`たどるのは ${MAX_HTML_PAGES} ページまで。残りがあることを記録する`, async () => {
    const id = await addSource(base, "html");
    const routes: Routes = { [base]: listPage("ページ0の工作教室", "?page=1") };
    for (let i = 1; i <= MAX_HTML_PAGES + 2; i++) routes[`${base}?page=${i}`] = listPage(`${"あいうえおかきくけこ"[i]}の工作教室`, `?page=${i + 1}`);
    const d = deps(routes, pageClaude());
    const r = await crawlSource(env.DB, await source(id), d);
    expect(r.extracted).toBe(MAX_HTML_PAGES);
    expect((await runs())[0]!.fetched_count).toBe(MAX_HTML_PAGES);
    expect(r.error).toContain("次のページ");
  });

  it("別のホストや、一度読んだページへのリンクはたどらない", async () => {
    const id = await addSource(base, "html");
    const d = deps(
      {
        [base]: listPage("パズル大会", "?page=1"),
        [`${base}?page=1`]: listPage("わなげ遊び", base),
      },
      pageClaude(),
    );
    const r = await crawlSource(env.DB, await source(id), d);
    expect(r).toMatchObject({ status: "success", extracted: 2 });

    const other = await addSource("https://example.jp/other", "html");
    const d2 = deps({ "https://example.jp/other": listPage("消防フェスタ", "https://evil.example.com/next") }, pageClaude());
    await crawlSource(env.DB, await source(other), d2);
    expect(d2.fetch.mock.calls.map((c) => String(c[0]))).not.toContain("https://evil.example.com/next");
  });

  it("robots.txt で禁止された次のページは取得しない", async () => {
    const id = await addSource(base, "html");
    const d = deps(
      {
        "https://example.jp/robots.txt": new Response("User-agent: *\nDisallow: /event?page="),
        [base]: listPage("パズル大会", "?page=1"),
        [`${base}?page=1`]: listPage("わなげ遊び"),
      },
      pageClaude(),
    );
    const r = await crawlSource(env.DB, await source(id), d);
    expect(r).toMatchObject({ status: "partial", extracted: 1 });
    expect(r.error).toContain("robots.txt");
    expect(d.fetch.mock.calls.map((c) => String(c[0]))).not.toContain(`${base}?page=1`);
  });

  it("2 ページ目以降の取得に失敗しても、それまでのページの分は保存する", async () => {
    const id = await addSource(base, "html");
    const d = deps(
      {
        [base]: listPage("パズル大会", "?page=1"),
        [`${base}?page=1`]: () => new Response("error", { status: 500 }),
      },
      pageClaude(),
    );
    const r = await crawlSource(env.DB, await source(id), d);
    expect(r).toMatchObject({ status: "partial", upserted: 1 });
    expect(r.error).toContain(`${base}?page=1`);
    expect(await titles()).toEqual(["パズル大会"]);
  });

  it("type が html 以外の収集元は次のページをたどらない", async () => {
    const id = await addSource(base, "jsonld");
    const d = deps({ [base]: listPage("パズル大会", "?page=1"), [`${base}?page=1`]: listPage("わなげ遊び") }, pageClaude());
    await crawlSource(env.DB, await source(id), d);
    expect(d.fetch.mock.calls.map((c) => String(c[0]))).not.toContain(`${base}?page=1`);
  });
});

describe("collect", () => {
  it("DB に書かずに、取得から抽出までの結果を返す（pnpm try-extract 用）", async () => {
    const claude = { callTool: vi.fn(async () => ({ events: pdfEvents })) } satisfies ClaudeClient;
    const out = await collect({ url: "https://example.jp/dayori.pdf", type: "pdf" }, deps({ "https://example.jp/dayori.pdf": pdfResponse() }, claude));
    expect(out).toMatchObject({ type: "pdf", fetched: 1, skipped: [], warnings: [] });
    expect(out.raws.map((r) => r.title)).toEqual(["紙コップ工作", "星空観察会"]);
    expect(await runs()).toEqual([]);
    expect(await events()).toEqual([]);
  });
});

describe("crawlAll", () => {
  it("ng・無効・未承認の収集元と、20 時間以内に取得した収集元は対象外", async () => {
    const routes = { "https://example.jp/cal.ics": new Response(ics, { headers: { "content-type": "text/calendar" } }) };
    const target = await addSource("https://example.jp/cal.ics", "ical", { policy_status: "caution" });
    await addSource("https://example.jp/ng.ics", "ical", { policy_status: "ng" });
    await addSource("https://example.jp/off.ics", "ical", { enabled: 0 });
    await addSource("https://example.jp/pending.ics", "ical", { status: "pending" });

    const first = await crawlAll(env.DB, deps(routes));
    expect(first.map((r) => r.sourceId)).toEqual([target]);
    const second = await crawlAll(env.DB, deps(routes));
    expect(second).toEqual([]);
  });
});
