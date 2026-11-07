import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { createMemoryRepository, type EventRecord } from "../src/repository";

const ev = (over: Partial<EventRecord>): EventRecord => ({
  id: 1,
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
  categories: ["読み聞かせ"],
  sourceUrl: "https://example.jp/event/1",
  ...over,
});

const events = [
  ev({ id: 1 }),
  ev({ id: 2, title: "親子工作教室", venue: "中央児童館", startAt: "2026-11-15T13:00", endAt: null, ageMin: 6, ageMax: 12, sourceUrl: "https://example.jp/flyer.pdf" }),
  ev({ id: 3, title: "秋のスタンプラリー", startAt: "2026-11-01", endAt: "2026-11-30", allDay: true, ageMin: null, ageMax: null, ageText: null, withParent: null }),
  ev({ id: 4, title: "阿波の子ども祭り", prefecture: "徳島県", startAt: "2026-11-08" }),
  ev({ id: 5, title: "<script>alert(1)</script>", startAt: "2026-11-09T10:00", endAt: null }),
];

const now = () => new Date("2026-11-02T20:00:00Z"); // JST 2026-11-03
const app = createApp({ repository: () => createMemoryRepository(events), now });
const get = (path: string) => app.request(path);

describe("都道府県一覧 /", () => {
  it("データがある県だけ表示する", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/kagawa"');
    expect(html).toContain("香川県");
    expect(html).toContain('href="/tokushima"');
    expect(html).not.toContain("愛媛県");
  });

  it("MCP エンドポイントと Claude への登録方法を出す", async () => {
    const html = await (await app.request("https://hub.example/")).text();
    expect(html).toContain("<code>https://hub.example/mcp</code>");
    expect(html).toContain('data-copy="https://hub.example/mcp"');
    expect(html).toContain('href="https://claude.ai/settings/connectors"');
    const command = "claude mcp add --transport http kids-event-hub https://hub.example/mcp";
    expect(html).toContain(`<code>${command}</code>`);
    expect(html).toContain(`data-copy="${command}"`);
  });

  it("コネクタの名前は自由で、URL 欄には下の URL を貼ると案内する", async () => {
    const html = await (await get("/")).text();
    expect(html).toContain("名前は好きなもので構いません");
    expect(html).toContain("URL 欄に、下の URL を貼り付けて追加する");
    expect(html).not.toContain("名前に「こどもイベントさがし」");
  });

  it("コピーボタンを動かすスクリプトを出す", async () => {
    const html = await (await get("/")).text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    expect(script).toContain("navigator.clipboard.writeText");
    expect(script).toContain("data-copy");
  });
});

describe("フッター", () => {
  it.each(["/", "/kagawa", "/events/1"])("%s に GitHub リポジトリへのリンクを出す", async (path) => {
    const html = await (await get(path)).text();
    expect(html).toMatch(/<footer[\s\S]*href="https:\/\/github\.com\/hashibadaiki\/kids-event-hub-open"[\s\S]*<\/footer>/);
  });
});

describe("一覧 /:pref, /:pref/:date", () => {
  it("/kagawa/2026-11-08 はその日に開催中のイベントだけ", async () => {
    const res = await get("/kagawa/2026-11-08");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("おはなし会");
    expect(html).toContain("秋のスタンプラリー");
    expect(html).not.toContain("親子工作教室");
    expect(html).not.toContain("阿波の子ども祭り");
    expect(html).toContain('href="/events/1"');
  });

  it("/kagawa?from&to で範囲指定、age で対象年齢を絞る", async () => {
    const html = await (await get("/kagawa?from=2026-11-01&to=2026-11-30&age=8")).text();
    expect(html).toContain("親子工作教室");
    expect(html).toContain("秋のスタンプラリー"); // 年齢不明は残す
    expect(html).not.toContain("おはなし会"); // 3〜6 歳
  });

  it("開始日時の早い順に並ぶ", async () => {
    const html = await (await get("/kagawa?from=2026-11-01&to=2026-11-30")).text();
    const order = ["秋のスタンプラリー", "おはなし会", "親子工作教室"].map((t) => html.indexOf(t));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("絞り込みフォームに現在の条件が入っている", async () => {
    const html = await (await get("/kagawa?from=2026-11-01&to=2026-11-30&age=8")).text();
    expect(html).toContain('action="/kagawa"');
    expect(html).toContain('value="2026-11-01"');
    expect(html).toContain('value="2026-11-30"');
    expect(html).toMatch(/<option[^>]*value="8"[^>]*selected/);
  });

  it("q で施設名・キーワードを絞り込む", async () => {
    const all = await (await get("/kagawa?from=2026-11-01&to=2026-11-30")).text();
    expect(all).toContain("親子工作教室");
    const html = await (await get(`/kagawa?from=2026-11-01&to=2026-11-30&q=${encodeURIComponent("児童館")}`)).text();
    expect(html).toContain("親子工作教室");
    expect(html).not.toContain("おはなし会");
    expect(html).not.toContain("秋のスタンプラリー");
  });

  it("フォームに施設・キーワード欄があり、現在の検索語が入っている", async () => {
    const html = await (await get(`/kagawa?q=${encodeURIComponent("図書館")}`)).text();
    expect(html).toMatch(/<input[^>]*type="search"[^>]*name="q"[^>]*value="図書館"/);
    expect(html).toContain("施設・キーワード");
  });

  it("検索語は見出しに出し、日付ショートカットにも引き継ぐ", async () => {
    const html = await (await get(`/kagawa?q=${encodeURIComponent("図書館")}`)).text();
    expect(html).toMatch(/<h1>[^<]*「図書館」/);
    expect(html).toContain('href="/kagawa/2026-11-03?q=%E5%9B%B3%E6%9B%B8%E9%A4%A8"');
  });

  it("検索語はエスケープされる", async () => {
    const html = await (await get(`/kagawa?q=${encodeURIComponent('"><script>x</script>')}`)).text();
    expect(html).not.toContain("<script>x</script>");
  });

  it("日付の制約はスクリプトが付け、JavaScript なしでは送信を止めない", async () => {
    const html = await (await get("/kagawa?from=2026-11-01&to=2026-11-30")).text();
    expect(html).not.toMatch(/<input[^>]*name="to"[^>]*(min|max)=/);
    expect(html).toMatch(/<form[^>]*class="filter"[^>]*data-max-days="92"[^>]*data-today="2026-11-03"/);
  });

  it("日付の入力を送信前に検証するスクリプトを出す", async () => {
    const html = await (await get("/kagawa")).text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    expect(script).toContain("setCustomValidity");
    expect(script).toContain("「いつまで」は「いつから」");
    expect(script).toContain("期間は92日以内");
    expect(script).toContain("日付を正しく入力");
  });

  it("該当なしのときはメッセージを出す", async () => {
    const html = await (await get("/kagawa/2027-01-01")).text();
    expect(html).toContain("見つかりませんでした");
  });

  it("タイトルや本文はエスケープされる", async () => {
    const html = await (await get("/kagawa/2026-11-09")).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("モバイル向けの viewport と OGP・タイトルを出す", async () => {
    const html = await (await get("/kagawa/2026-11-08")).text();
    expect(html).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1"');
    expect(html).toMatch(/<title>香川県 2026年11月8日\(日\)の子どもイベント/);
    expect(html).toContain('property="og:title"');
    expect(html).toContain('property="og:description"');
    expect(html).toContain('property="og:url" content="http://localhost/kagawa/2026-11-08"');
    expect(html).toContain('rel="canonical" href="http://localhost/kagawa/2026-11-08"');
  });

  it("不明な県・不正な日付は 404、不正なクエリは 400", async () => {
    expect((await get("/atlantis")).status).toBe(404);
    expect((await get("/kagawa/2026-02-30")).status).toBe(404);
    expect((await get("/kagawa?age=abc")).status).toBe(400);
    expect((await get("/kagawa?from=2026-11-10&to=2026-11-01")).status).toBe(400);
    expect((await get(`/kagawa?q=${"a".repeat(101)}`)).status).toBe(400);
  });
});

describe("詳細 /events/:id", () => {
  it("元 URL へのリンクを出す", async () => {
    const res = await get("/events/1");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("おはなし会");
    expect(html).toContain("中央図書館");
    expect(html).toContain("3〜6歳（保護者同伴）");
    expect(html).toContain("無料");
    expect(html).toContain('href="https://example.jp/event/1"');
    expect(html).toContain("掲載元のページ");
    expect(html).toContain('property="og:type" content="article"');
  });

  it("PDF 由来なら PDF へのリンクとして出す", async () => {
    const html = await (await get("/events/2")).text();
    expect(html).toContain('href="https://example.jp/flyer.pdf"');
    expect(html).toContain("PDF チラシ");
  });

  it("県の一覧に戻るリンク", async () => {
    const html = await (await get("/events/1")).text();
    expect(html).toContain('href="/kagawa/2026-11-08"');
  });

  it("上部の「一覧に戻る」は前のページがなければ県・開催日の一覧へ移動する", async () => {
    const html = await (await get("/events/1")).text();
    const back = html.match(/<a[^>]*class="back"[^>]*>([^<]*)<\/a>/);
    expect(back?.[0]).toContain('href="/kagawa/2026-11-08"');
    expect(back?.[1]).toContain("一覧に戻る");
    expect(html.indexOf('class="back"')).toBeLessThan(html.indexOf("<h1>"));
  });

  it("自サイトの一覧から来たときだけ履歴を戻るスクリプトを出す", async () => {
    const html = await (await get("/events/1")).text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    expect(script).toContain("history.back()");
    expect(script).toContain("document.referrer");
    expect(script).toContain("location.origin");
    expect(script).toContain("/events/");
  });

  it("県が分からないイベントの「一覧に戻る」はトップへ", async () => {
    const app = createApp({
      repository: () => createMemoryRepository([ev({ id: 7, prefecture: "不明" })]),
      now,
    });
    const html = await (await app.request("/events/7")).text();
    expect(html).toMatch(/<a[^>]*class="back"[^>]*href="\/"|<a[^>]*href="\/"[^>]*class="back"/);
  });

  it("施設のイベント一覧へのリンク", async () => {
    const html = await (await get("/events/1")).text();
    expect(html).toContain(`href="/kagawa?q=${encodeURIComponent("中央図書館")}"`);
    expect(html).toContain("この施設のイベント一覧へ");
  });

  it("会場が不明・検索語の上限より長いなら施設のリンクは出さない", async () => {
    const app = createApp({
      repository: () => createMemoryRepository([ev({ id: 8, venue: null }), ev({ id: 9, venue: "館".repeat(101) })]),
      now,
    });
    for (const id of [8, 9]) {
      const html = await (await app.request(`/events/${id}`)).text();
      expect(html).not.toContain("この施設のイベント一覧へ");
    }
  });

  it("存在しない ID は 404", async () => {
    expect((await get("/events/999")).status).toBe(404);
    expect((await get("/events/abc")).status).toBe(404);
  });
});

describe("既存ルート", () => {
  it("/healthz は県名と衝突しない", async () => {
    const res = await get("/healthz");
    expect(await res.json()).toEqual({ ok: true });
  });
});
