import { describe, it, expect } from "vitest";
import { scoreExtraction, decideAdoption, needsImprovement, QUALITY_THRESHOLD } from "../src/improve/quality";
import type { RawEvent } from "../src/extract/types";

const ctx = { prefecture: "香川県", sourceUrl: "https://example.jp/events/", referenceDate: new Date("2026-11-03T00:00:00Z") };

// 固定データ: 4 件中、日付 3 件・会場 2 件・年齢 1 件。2 件目と 3 件目は同じイベント（重複）
const raws: RawEvent[] = [
  { title: "工作教室", dateText: "11月15日 午後2時", venue: "中央公民館", ageText: "小学生" },
  { title: "おはなし会", dateText: "11月20日", venue: "図書館" },
  { title: "おはなし会", dateText: "11月20日" },
  { title: "休館のお知らせ", dateText: "工事のため" },
];

describe("scoreExtraction", () => {
  it("日付・場所・年齢の取得率、重複率、必須項目の欠損率を計算する", () => {
    const q = scoreExtraction(raws, ctx);
    expect(q.extracted).toBe(4);
    expect(q.dateRate).toBe(0.75);
    expect(q.venueRate).toBe(0.5);
    expect(q.ageRate).toBe(0.25);
    // 日付が取れた 3 件のうち 1 件が重複
    expect(q.duplicateRate).toBeCloseTo(1 / 3, 3);
    // 必須（タイトル・日付・会場）のどれかが欠けている: 3 件目（会場）・4 件目（日付・会場）
    expect(q.missingRate).toBe(0.5);
    // 0.35*0.75 + 0.15*0.5 + 0.15*0.25 + 0.15*(1-1/3) + 0.2*(1-0.5)
    expect(q.score).toBeCloseTo(0.575, 3);
  });

  it("すべて揃っていれば 1、何も抽出できなければ 0", () => {
    const perfect = scoreExtraction([{ title: "工作教室", dateText: "11月15日", venue: "公民館", ageText: "5歳以上" }], ctx);
    expect(perfect.score).toBe(1);
    const empty = scoreExtraction([], ctx);
    expect(empty).toMatchObject({ extracted: 0, score: 0, dateRate: 0, missingRate: 0 });
  });

  it("年齢は表記がなくても正規化で取れていれば取得とみなす", () => {
    const q = scoreExtraction([{ title: "親子リトミック（3歳から）", dateText: "11月15日", venue: "公民館", description: "対象は3歳以上" }], ctx);
    expect(q.ageRate).toBe(1);
  });
});

describe("needsImprovement", () => {
  it(`閾値（${QUALITY_THRESHOLD}）を下回ったら改善ジョブを起動する`, () => {
    expect(QUALITY_THRESHOLD).toBe(0.7);
    expect(needsImprovement(0.69)).toBe(true);
    expect(needsImprovement(0.7)).toBe(false);
    expect(needsImprovement(null)).toBe(false); // 採点できなかった（取得失敗など）は対象外
  });
});

describe("decideAdoption", () => {
  const base = { score: 0.5, extracted: 10 };

  it("スコアが最小改善幅以上に上がったら採用する", () => {
    expect(decideAdoption(base, { score: 0.6, extracted: 10 })).toMatchObject({ adopt: true });
    expect(decideAdoption(base, { score: 0.52, extracted: 10 })).toMatchObject({ adopt: true });
  });

  it("改善幅が小さい・下がった場合は採用しない", () => {
    expect(decideAdoption(base, { score: 0.51, extracted: 10 })).toMatchObject({ adopt: false });
    expect(decideAdoption(base, { score: 0.4, extracted: 10 })).toMatchObject({ adopt: false });
  });

  it("スコアが上がっても抽出件数が大きく減った場合は採用しない（取りこぼしで率だけ良く見えるのを防ぐ）", () => {
    const d = decideAdoption(base, { score: 1, extracted: 7 });
    expect(d.adopt).toBe(false);
    expect(d.reason).toContain("件数");
    expect(decideAdoption(base, { score: 1, extracted: 8 }).adopt).toBe(true);
  });

  it("理由を残す", () => {
    expect(decideAdoption(base, { score: 0.6, extracted: 10 }).reason).toMatch(/0\.5.*0\.6/);
  });
});
