import { describe, expect, it } from "vitest";
import { dedupe, isDuplicate, titleSimilarity } from "../src/dedup";

const base = { title: "親子木工教室〜クリスマスリースを作ろう〜", start: "2026-12-05T10:00", venue: "高松市こども未来館" };

describe("titleSimilarity", () => {
  it("同一は 1、無関係は低い", () => {
    expect(titleSimilarity("読み聞かせ会", "読み聞かせ会")).toBe(1);
    expect(titleSimilarity("読み聞かせ会", "サッカー教室")).toBeLessThan(0.2);
  });
  it("全角・空白・記号の差は無視", () => {
    expect(titleSimilarity("【親子】木工 教室", "親子木工教室")).toBe(1);
  });
});

describe("isDuplicate", () => {
  it("表記ゆれのある同じイベント", () => {
    expect(
      isDuplicate(base, { title: "【親子】木工教室 クリスマスリースをつくろう", start: "2026-12-05", venue: "こども未来館" }),
    ).toBe(true);
  });

  it("日付が違えば別物", () => {
    expect(isDuplicate(base, { ...base, start: "2026-12-06T10:00" })).toBe(false);
  });

  it("場所が明らかに違えば別物", () => {
    expect(isDuplicate(base, { ...base, venue: "丸亀市民体育館" })).toBe(false);
  });

  it("場所が片方不明ならタイトルと日付で判定", () => {
    expect(isDuplicate(base, { ...base, venue: null })).toBe(true);
  });

  it("タイトルが違えば別物", () => {
    expect(isDuplicate(base, { ...base, title: "絵本の読み聞かせ会" })).toBe(false);
  });

  it("開始日が不明なものは重複と判定しない", () => {
    expect(isDuplicate({ ...base, start: null }, { ...base, start: null })).toBe(false);
  });
});

describe("dedupe", () => {
  it("先に出たものを残して重複を落とす", () => {
    const events = [
      { id: 1, ...base },
      { id: 2, title: "絵本の読み聞かせ会", start: "2026-12-05", venue: "高松市図書館" },
      { id: 3, title: "親子木工教室 クリスマスリースを作ろう", start: "2026-12-05", venue: "こども未来館" },
    ];
    expect(dedupe(events).map((e) => e.id)).toEqual([1, 2]);
  });
});
