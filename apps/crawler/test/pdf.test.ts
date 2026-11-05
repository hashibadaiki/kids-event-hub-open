import { describe, it, expect, vi } from "vitest";
import flyerDataUrl from "./fixtures/flyer.pdf?inline";
import calendarDataUrl from "./fixtures/calendar.pdf?inline";
import { extractPdf, findPdfLinks, MAX_PDF_LINKS, toBase64 } from "../src/extract/pdf";
import { toEventRow } from "../src/crawl/normalize";
import type { ClaudeClient } from "../src/claude";

const base64Of = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(",") + 1);
const bytesOf = (dataUrl: string) => Uint8Array.from(atob(base64Of(dataUrl)), (c) => c.charCodeAt(0));

function claudeReturning(events: unknown[]) {
  const callTool = vi.fn<ClaudeClient["callTool"]>(async () => ({ events }));
  return { callTool } satisfies ClaudeClient;
}

const ctx = { prefecture: "香川県", sourceUrl: "https://example.jp/dayori.pdf", referenceDate: new Date("2026-11-03T00:00:00Z") };

describe("toBase64", () => {
  it("バイト列を base64 にする（大きなファイルでも壊れない）", () => {
    const flyer = bytesOf(flyerDataUrl);
    expect(toBase64(flyer)).toBe(base64Of(flyerDataUrl));
    expect(toBase64(new Uint8Array([0, 255, 128]))).toBe("AP+A");
  });
});

describe("extractPdf", () => {
  it("PDF をそのまま Claude に渡し、1 枚に載った複数のイベントを取り出す", async () => {
    const claude = claudeReturning([
      {
        title: "親子でつくろう！紙コップ工作",
        dates: ["2026年11月15日（日）"],
        time_text: "10:00〜12:00",
        venue: "みどり市こどもセンター 2階 工作室",
        city: "みどり市",
        age_text: "3歳〜小学生（保護者同伴）",
        price_text: "無料",
        apply_text: "11月1日から電話で受付（先着20組）",
        summary: "紙コップを使った親子工作",
      },
      {
        title: "星空観察会",
        dates: ["2026年11月21日（土）", "2026年11月28日（土）"],
        time_text: "18:30〜20:00",
        venue: "みどり市こどもセンター 屋上",
        age_text: "小学生以上",
        price_text: "100円",
        apply_text: "不要（当日直接）",
        summary: "望遠鏡で星を観察",
      },
    ]);
    const raws = await extractPdf(bytesOf(flyerDataUrl), "https://example.jp/dayori.pdf", claude);

    const args = claude.callTool.mock.calls[0]![0];
    expect(args.document).toEqual({ mediaType: "application/pdf", base64: base64Of(flyerDataUrl) });
    expect(args.system).toContain("転載");

    expect(raws.map((r) => [r.title, r.dateText])).toEqual([
      ["親子でつくろう！紙コップ工作", "2026年11月15日（日） 10:00〜12:00"],
      ["星空観察会", "2026年11月21日（土） 18:30〜20:00"],
      ["星空観察会", "2026年11月28日（土） 18:30〜20:00"],
    ]);
    expect(raws[0]).toMatchObject({
      venue: "みどり市こどもセンター 2階 工作室",
      city: "みどり市",
      ageText: "3歳〜小学生（保護者同伴）",
      priceText: "無料",
      applyText: "11月1日から電話で受付（先着20組）",
      summary: "紙コップを使った親子工作",
      url: "https://example.jp/dayori.pdf",
    });

    const rows = raws.map((r) => toEventRow(r, ctx));
    expect(rows.map((r) => r && [r.startAt, r.endAt])).toEqual([
      ["2026-11-15T10:00", "2026-11-15T12:00"],
      ["2026-11-21T18:30", "2026-11-21T20:00"],
      ["2026-11-28T18:30", "2026-11-28T20:00"],
    ]);
    expect(rows[0]).toMatchObject({ ageMin: 3, withParent: true, priceFree: true, applyText: "11月1日から電話で受付（先着20組）", sourceUrl: "https://example.jp/dayori.pdf" });
    expect(rows[1]!.dedupKey).not.toBe(rows[2]!.dedupKey);
  });

  it("月間カレンダー形式は年月を補った日付ごとのイベントになる", async () => {
    const claude = claudeReturning([
      { title: "おはなし会", dates: ["2026年12月4日", "2026年12月11日", "2026年12月18日", "2026年12月25日"], time_text: "15:30〜16:00", venue: "児童コーナー", age_text: "0歳〜未就学児", price_text: "無料", apply_text: "申込不要" },
      { title: "クリスマス工作", dates: ["2026年12月19日（土）"], time_text: "14:00〜15:30", price_text: "材料費200円" },
    ]);
    const raws = await extractPdf(bytesOf(calendarDataUrl), "https://example.jp/cal.pdf", claude);
    expect(claude.callTool.mock.calls[0]![0].system).toContain("カレンダー");
    const rows = raws.map((r) => toEventRow(r, ctx)!);
    expect(rows.map((r) => [r.title, r.startAt])).toEqual([
      ["おはなし会", "2026-12-04T15:30"],
      ["おはなし会", "2026-12-11T15:30"],
      ["おはなし会", "2026-12-18T15:30"],
      ["おはなし会", "2026-12-25T15:30"],
      ["クリスマス工作", "2026-12-19T14:00"],
    ]);
    expect(new Set(rows.map((r) => r.dedupKey)).size).toBe(5);
  });

  it("連続した期間（展示など）は 1 日ずつに展開せず、開始〜終了の 1 件になる", async () => {
    const claude = claudeReturning([
      { title: "後期展", dates: ["令和8年10月13日(火)～令和9年4月9日(金)"], time_text: "9:00～17:00", venue: "埋蔵文化財センター" },
    ]);
    const raws = await extractPdf(bytesOf(flyerDataUrl), "https://example.jp/tenji.pdf", claude);

    const system = claude.callTool.mock.calls[0]![0].system;
    expect(system).toContain("開始～終了を 1 要素");
    expect(system).toContain("1 日ずつに展開しない");
    expect(system).not.toContain("開催日を 1 日ずつ");

    expect(raws).toHaveLength(1);
    expect(raws[0]).toMatchObject({ title: "後期展", dateText: "令和8年10月13日(火)～令和9年4月9日(金) 9:00～17:00", venue: "埋蔵文化財センター" });
    const row = toEventRow(raws[0]!, ctx)!;
    expect([row.startAt, row.endAt, row.allDay]).toEqual(["2026-10-13T09:00", "2027-04-09T17:00", false]);
  });

  it("タイトルのない項目は捨て、日付のない項目は日付なしの候補として残す（正規化で落ちる）", async () => {
    const claude = claudeReturning([{ title: " ", dates: ["2026年11月1日"] }, { title: "日程未定の講座" }, "壊れた値"]);
    const raws = await extractPdf(new Uint8Array([37, 80, 68, 70]), "https://example.jp/a.pdf", claude);
    expect(raws).toEqual([expect.objectContaining({ title: "日程未定の講座", dateText: null })]);
    expect(toEventRow(raws[0]!, ctx)).toBeNull();
  });
});

describe("findPdfLinks", () => {
  const html = `
    <a href="/files/dayori-11.pdf">11月号（PDF）</a>
    <a href="files/dayori-12.PDF?v=2">12月号</a>
    <a href="https://example.jp/files/dayori-11.pdf#page=2">11月号 2ページ目</a>
    <a href="https://other.example.com/flyer.pdf">他サイト</a>
    <a href="/event/list.html">一覧</a>
    <a href='/docs/cal.pdf'>カレンダー</a>`;

  it("同じホストの PDF へのリンクを絶対 URL で重複なく返す", () => {
    expect(findPdfLinks(html, "https://example.jp/kodomo/")).toEqual([
      "https://example.jp/files/dayori-11.pdf",
      "https://example.jp/kodomo/files/dayori-12.PDF?v=2",
      "https://example.jp/docs/cal.pdf",
    ]);
  });

  it(`多すぎるときは先頭の ${MAX_PDF_LINKS} 件まで`, () => {
    const many = Array.from({ length: MAX_PDF_LINKS + 3 }, (_, i) => `<a href="/f/${i}.pdf">${i}</a>`).join("");
    expect(findPdfLinks(many, "https://example.jp/")).toHaveLength(MAX_PDF_LINKS);
  });
});
