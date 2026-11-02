import { describe, expect, it } from "vitest";
import { normalizeDate } from "../src/normalize/date";

const ref = new Date("2026-10-01T00:00:00+09:00");

describe("normalizeDate", () => {
  it("月日と曜日（年は基準日から補う）", () => {
    expect(normalizeDate("11月8日（土）", { referenceDate: ref })).toEqual({
      start: "2026-11-08",
      end: "2026-11-08",
      allDay: true,
      recurrence: null,
    });
  });

  it("全角数字・全角括弧でも読める", () => {
    expect(normalizeDate("１１月８日（土）", { referenceDate: ref })?.start).toBe("2026-11-08");
  });

  it("基準日より大きく過去の月は翌年とみなす", () => {
    expect(normalizeDate("1月10日", { referenceDate: ref })?.start).toBe("2027-01-10");
  });

  it("和暦（令和）", () => {
    expect(normalizeDate("令和8年11月8日", { referenceDate: ref })?.start).toBe("2026-11-08");
    expect(normalizeDate("令和元年5月1日", { referenceDate: ref })?.start).toBe("2019-05-01");
  });

  it("西暦の年月日とスラッシュ区切り", () => {
    expect(normalizeDate("2026年12月24日", { referenceDate: ref })?.start).toBe("2026-12-24");
    expect(normalizeDate("2026/12/24", { referenceDate: ref })?.start).toBe("2026-12-24");
    expect(normalizeDate("2026.12.24", { referenceDate: ref })?.start).toBe("2026-12-24");
  });

  it("スラッシュの範囲（〜）", () => {
    expect(normalizeDate("11/8〜11/10", { referenceDate: ref })).toEqual({
      start: "2026-11-08",
      end: "2026-11-10",
      allDay: true,
      recurrence: null,
    });
  });

  it("範囲の終わりが月だけ省略・年またぎ", () => {
    expect(normalizeDate("11月8日～10日", { referenceDate: ref })?.end).toBe("2026-11-10");
    expect(normalizeDate("12月28日(月)~1月3日(日)", { referenceDate: ref })).toMatchObject({
      start: "2026-12-28",
      end: "2027-01-03",
    });
  });

  it("時刻つき（24 時間表記・時分・午前午後）", () => {
    expect(normalizeDate("11月8日（土）10:00〜12:00", { referenceDate: ref })).toEqual({
      start: "2026-11-08T10:00",
      end: "2026-11-08T12:00",
      allDay: false,
      recurrence: null,
    });
    expect(normalizeDate("11月8日 午後1時30分～午後3時", { referenceDate: ref })).toMatchObject({
      start: "2026-11-08T13:30",
      end: "2026-11-08T15:00",
    });
    expect(normalizeDate("11月8日 10時から", { referenceDate: ref })).toMatchObject({
      start: "2026-11-08T10:00",
      end: "2026-11-08T10:00",
      allDay: false,
    });
  });

  it("毎週の繰り返し（期間なし）", () => {
    expect(normalizeDate("毎週土曜", { referenceDate: ref })).toEqual({
      start: null,
      end: null,
      allDay: true,
      recurrence: { freq: "weekly", weekdays: [6] },
    });
    expect(normalizeDate("毎週土・日曜日", { referenceDate: ref })?.recurrence).toEqual({
      freq: "weekly",
      weekdays: [0, 6],
    });
  });

  it("毎週の繰り返し（期間・時刻あり）", () => {
    expect(normalizeDate("11月1日〜11月29日の毎週日曜 14:00〜15:00", { referenceDate: ref })).toEqual({
      start: "2026-11-01T14:00",
      end: "2026-11-29T15:00",
      allDay: false,
      recurrence: { freq: "weekly", weekdays: [0] },
    });
  });

  it("存在しない日付や読めない文字列は null", () => {
    expect(normalizeDate("2月30日", { referenceDate: ref })).toBeNull();
    expect(normalizeDate("近日開催", { referenceDate: ref })).toBeNull();
    expect(normalizeDate("", { referenceDate: ref })).toBeNull();
  });
});
