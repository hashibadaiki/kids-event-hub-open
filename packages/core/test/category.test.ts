import { describe, expect, it } from "vitest";
import { CATEGORIES, classifyCategory } from "../src/normalize/category";

describe("classifyCategory", () => {
  it("単一カテゴリ", () => {
    expect(classifyCategory("親子で木工工作教室")).toEqual(["craft"]);
    expect(classifyCategory("絵本の読み聞かせ会")).toEqual(["storytelling"]);
    expect(classifyCategory("ヒーローショー")).toEqual(["show"]);
    expect(classifyCategory("キッズサッカー体験")).toEqual(["sports"]);
    expect(classifyCategory("里山で昆虫観察")).toEqual(["nature"]);
  });

  it("複数カテゴリはヒット数の多い順", () => {
    expect(classifyCategory("森の自然観察と木の実でクラフト", "落ち葉や木の実を使って工作します")).toEqual([
      "nature",
      "craft",
    ]);
  });

  it("説明文も見る", () => {
    expect(classifyCategory("おはなし会", "絵本や紙芝居を楽しもう")).toEqual(["storytelling"]);
  });

  it("どれにも当たらなければ other", () => {
    expect(classifyCategory("説明会")).toEqual(["other"]);
  });

  it("カテゴリには日本語ラベルがある", () => {
    expect(CATEGORIES.craft.label).toBe("工作");
    expect(Object.keys(CATEGORIES)).toContain("other");
  });
});
