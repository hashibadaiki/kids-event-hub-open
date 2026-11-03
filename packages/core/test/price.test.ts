import { describe, expect, it } from "vitest";
import { normalizePrice } from "../src/normalize/price";

describe("normalizePrice", () => {
  it("無料", () => {
    expect(normalizePrice("無料")).toEqual({ free: true, items: [], minYen: 0, maxYen: 0 });
    expect(normalizePrice("参加費：0円")).toMatchObject({ free: true, minYen: 0, maxYen: 0 });
  });

  it("区分ごとの料金", () => {
    expect(normalizePrice("大人500円・子供300円")).toEqual({
      free: false,
      items: [
        { label: "大人", yen: 500 },
        { label: "子供", yen: 300 },
      ],
      minYen: 300,
      maxYen: 500,
    });
  });

  it("カンマ・全角数字・円の前置き", () => {
    expect(normalizePrice("参加費 １，２００円")).toEqual({
      free: false,
      items: [{ label: "参加費", yen: 1200 }],
      minYen: 1200,
      maxYen: 1200,
    });
  });

  it("一部無料の区分", () => {
    expect(normalizePrice("大人300円、中学生以下無料")).toEqual({
      free: false,
      items: [
        { label: "大人", yen: 300 },
        { label: "中学生以下", yen: 0 },
      ],
      minYen: 0,
      maxYen: 300,
    });
  });

  it("入場無料でも材料費があれば有料扱い", () => {
    expect(normalizePrice("入場無料（材料費200円）")).toMatchObject({ free: false, minYen: 0, maxYen: 200 });
  });

  it("金額不明の有料", () => {
    expect(normalizePrice("参加費あり")).toEqual({ free: false, items: [], minYen: null, maxYen: null });
    expect(normalizePrice("有料")).toMatchObject({ free: false });
  });

  it("読めないものは不明", () => {
    expect(normalizePrice("詳細はお問い合わせください")).toEqual({ free: null, items: [], minYen: null, maxYen: null });
  });
});
