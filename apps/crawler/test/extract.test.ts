import { describe, it, expect } from "vitest";
import jsonldHtml from "./fixtures/jsonld.html?raw";
import ics from "./fixtures/events.ics?raw";
import rss from "./fixtures/rss.xml?raw";
import atom from "./fixtures/atom.xml?raw";
import { extractJsonLd } from "../src/extract/jsonld";
import { extractIcal } from "../src/extract/ical";
import { extractRss } from "../src/extract/rss";

describe("extractJsonLd", () => {
  it("schema.org の Event（サブタイプ・@graph・配列を含む）を取り出す", () => {
    const events = extractJsonLd(jsonldHtml, "https://example.jp/list/");
    expect(events).toEqual([
      {
        title: "親子で木工教室",
        start: "2026-11-08T10:00",
        end: "2026-11-08T12:00",
        allDay: false,
        dateText: null,
        venue: "こども未来館 工作室",
        city: "高松市",
        description: "木の端材を使って小物入れを作ります。",
        url: "https://example.jp/events/123",
        ageText: "5~12歳",
        priceText: "500円",
        priceFree: false,
      },
      {
        title: "おはなし会",
        start: "2026-11-14",
        end: null,
        allDay: true,
        dateText: null,
        venue: "中央図書館",
        city: null,
        description: null,
        url: null,
        ageText: null,
        priceText: null,
        priceFree: true,
      },
      expect.objectContaining({ title: "日付なし", start: null }),
    ]);
  });

  it("UTC の日時は JST に直す", () => {
    const html = `<script type="application/ld+json">{"@type":"Event","name":"a","startDate":"2026-11-30T23:00:00Z"}</script>`;
    expect(extractJsonLd(html, "https://a.jp/")[0]).toMatchObject({ start: "2026-12-01T08:00", allDay: false });
  });

  it("JSON-LD がなければ空", () => {
    expect(extractJsonLd("<html></html>", "https://a.jp/")).toEqual([]);
  });
});

describe("extractIcal", () => {
  it("VEVENT を取り出し、折り返し・エスケープ・終日・UTC を扱う", () => {
    expect(extractIcal(ics)).toEqual([
      {
        title: "星空観察会",
        start: "2026-11-21T18:30",
        end: "2026-11-21T20:00",
        allDay: false,
        dateText: null,
        venue: "さぬきこどもの国",
        description: "望遠鏡で月と土星を見ます。小学生以上, 無料; C:\\x",
        url: "https://example.jp/ev/1",
      },
      {
        // DTEND は排他的なので前日まで
        title: "冬休みこども工作ひろば",
        start: "2026-12-26",
        end: "2026-12-27",
        allDay: true,
        dateText: null,
        venue: null,
        description: null,
        url: null,
      },
      expect.objectContaining({ title: "UTC の予定", start: "2026-12-01T10:00", end: null }),
    ]);
  });
});

describe("extractRss", () => {
  it("RSS 2.0 の item を、本文から日付を読む候補にする（pubDate は開催日ではない）", () => {
    expect(extractRss(rss)).toEqual([
      {
        title: "【11月23日（月・祝）】科学実験ショー",
        dateText: "【11月23日（月・祝）】科学実験ショー 午後1時30分から。参加費無料。対象：小学生",
        description: "午後1時30分から。参加費無料。対象：小学生",
        url: "https://example.jp/news/10",
      },
      {
        title: "休館日のお知らせ & 工事",
        dateText: "休館日のお知らせ & 工事 館内工事のため休館します。",
        description: "館内工事のため休館します。",
        url: "https://example.jp/news/11",
      },
    ]);
  });

  it("Atom の entry も扱う", () => {
    expect(extractRss(atom)).toEqual([
      {
        title: "12/5 リトミック教室",
        dateText: "12/5 リトミック教室 1歳から3歳の親子 10:00～11:00",
        description: "1歳から3歳の親子 10:00～11:00",
        url: "https://example.jp/a/1",
      },
    ]);
  });
});
