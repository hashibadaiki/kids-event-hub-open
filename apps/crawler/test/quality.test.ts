import { describe, it, expect } from "vitest";
import { scoreExtraction, decideAdoption, lostEvents, newEvents, needsImprovement, QUALITY_THRESHOLD } from "../src/improve/quality";
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
    expect(q.weekdayMismatches).toBe(0);
  });

  it("すべて揃っていれば 1、何も抽出できなければ 0", () => {
    const perfect = scoreExtraction([{ title: "工作教室", dateText: "11月15日", venue: "公民館", ageText: "5歳以上" }], ctx);
    expect(perfect.score).toBe(1);
    const empty = scoreExtraction([], ctx);
    expect(empty).toMatchObject({ extracted: 0, score: 0, dateRate: 0, missingRate: 0, weekdayMismatches: 0 });
  });

  it("書かれた曜日と合わない日付の件数（前後の月に直した・日付なしにした）を数える", () => {
    const q = scoreExtraction(
      [
        { title: "はじめての森でおさんぽ！", dateText: "12月7日(土)", venue: "公園" },
        { title: "工作教室", dateText: "11月7日(火)", venue: "公民館" },
        { title: "おはなし会", dateText: "11月20日（金）", venue: "図書館" },
      ],
      ctx,
    );
    expect(q.weekdayMismatches).toBe(2);
    // 日付なしにした 1 件は日付取得率を下げる（直した 1 件は 11/7 として数える）
    expect(q.dateRate).toBeCloseTo(2 / 3, 3);
  });

  it("年齢は表記がなくても正規化で取れていれば取得とみなす", () => {
    const q = scoreExtraction([{ title: "親子リトミック（3歳から）", dateText: "11月15日", venue: "公民館", description: "対象は3歳以上" }], ctx);
    expect(q.ageRate).toBe(1);
  });

  it("同じ日・同じタイトルでも会場がはっきり違えば重複に数えない", () => {
    const q = scoreExtraction(
      [
        { title: "おはなし会", dateText: "12月12日", venue: "瀬戸町図書館" },
        { title: "おはなし会", dateText: "12月12日", venue: "御津図書館" },
      ],
      ctx,
    );
    expect(q.duplicateRate).toBe(0);
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

  it("+0.10 以上に上がり、正しく取れていたイベントを落とさなければ自動採用する", () => {
    expect(decideAdoption(base, { score: 0.6, extracted: 10 }).decision).toBe("adopted");
    expect(decideAdoption(base, { score: 0.9, extracted: 10 }, { lost: 0 }).decision).toBe("adopted");
  });

  it("上がったが +0.10 未満なら人間の確認に回す（pending）", () => {
    const d = decideAdoption(base, { score: 0.55, extracted: 10 });
    expect(d.decision).toBe("pending");
    expect(d.reason).toContain("人間");
    expect(decideAdoption(base, { score: 0.52, extracted: 10 }).decision).toBe("pending");
  });

  it("+0.10 以上でも、正しく取れていたイベントを落とすなら人間の確認に回す", () => {
    const d = decideAdoption(base, { score: 0.9, extracted: 10 }, { lost: 1 });
    expect(d.decision).toBe("pending");
    expect(d.reason).toContain("1 件");
  });

  it("+0.10 以上でも、子供向けでない項目を新たに拾うなら人間の確認に回す", () => {
    const d = decideAdoption(base, { score: 0.9, extracted: 10 }, { offTarget: 2 });
    expect(d.decision).toBe("pending");
    expect(d.reason).toContain("子供向けでない");
    expect(d.reason).toContain("2 件");
  });

  it("改善幅が小さい・下がった場合は却下する", () => {
    expect(decideAdoption(base, { score: 0.51, extracted: 10 }).decision).toBe("rejected");
    expect(decideAdoption(base, { score: 0.4, extracted: 10 }).decision).toBe("rejected");
  });

  it("スコアが上がっても抽出件数が大きく減った場合は却下する（取りこぼしで率だけ良く見えるのを防ぐ）", () => {
    const d = decideAdoption(base, { score: 1, extracted: 7 });
    expect(d.decision).toBe("rejected");
    expect(d.reason).toContain("件数");
    expect(decideAdoption(base, { score: 1, extracted: 8 }).decision).toBe("adopted");
  });

  it("理由を残す", () => {
    expect(decideAdoption(base, { score: 0.6, extracted: 10 }).reason).toMatch(/0\.5.*0\.6/);
  });
});

describe("newEvents", () => {
  const ctx = { prefecture: "香川県", sourceUrl: "https://example.jp/", referenceDate: new Date("2026-11-03T00:00:00Z") };
  const a = { title: "親子リトミック", dateText: "11月10日 10:30", venue: "多目的室" };
  const b = { title: "プレゼントキャンペーン", dateText: "11月1日" };

  it("旧版になかった項目を返す（表記ゆれ程度は同じとみなす）", () => {
    expect(newEvents([a], [a, b], ctx)).toEqual([b]);
    expect(newEvents([a], [{ ...a, title: "親子リトミック（要予約）" }], ctx)).toEqual([]);
  });

  it("日付が取れない項目はタイトルで比べる", () => {
    const undated = { title: "工作教室", dateText: "日付不明" };
    expect(newEvents([undated], [undated], ctx)).toEqual([]);
    expect(newEvents([], [undated], ctx)).toEqual([undated]);
  });
});

describe("lostEvents", () => {
  const ctx = { prefecture: "香川県", sourceUrl: "https://example.jp/", referenceDate: new Date("2026-11-03T00:00:00Z") };
  const ok = { title: "親子リトミック", dateText: "11月10日 10:30", venue: "多目的室" };
  const ok2 = { title: "工作教室", dateText: "11月15日 14:00", venue: "工作室" };

  it("旧版で正しく取れていた（タイトル・日付・会場がそろった）イベントが新版にない数を返す", () => {
    expect(lostEvents([ok, ok2], [ok, ok2], ctx)).toBe(0);
    expect(lostEvents([ok, ok2], [ok], ctx)).toBe(1);
    expect(lostEvents([ok, ok2], [], ctx)).toBe(2);
  });

  it("旧版で欠けていたイベントは数えない", () => {
    expect(lostEvents([ok, { title: "日付なし", dateText: "未定", venue: "ホール" }, { title: "会場なし", dateText: "11月20日" }], [ok], ctx)).toBe(0);
  });

  it("表記ゆれ程度の違いは同じイベントとみなす", () => {
    expect(lostEvents([ok], [{ ...ok, title: "親子リトミック（要予約）" }], ctx)).toBe(0);
  });
});
