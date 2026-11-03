import { describe, it, expect } from "vitest";
import { parseSearch, matchesQuery, searchPath, addDays, todayJst } from "../src/search";
import type { EventRecord } from "../src/repository";

const now = new Date("2026-11-02T20:00:00Z"); // JST 2026-11-03 05:00

describe("todayJst / addDays", () => {
  it("JST の日付を返す", () => {
    expect(todayJst(now)).toBe("2026-11-03");
  });
  it("月・年またぎで日付を足す", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("parseSearch: URL → 検索条件", () => {
  it("/kagawa/2026-11-08 は 1 日だけの範囲", () => {
    const r = parseSearch({ prefecture: "kagawa", date: "2026-11-08", params: new URLSearchParams(), now });
    expect(r).toEqual({ ok: true, query: { prefecture: "香川県", slug: "kagawa", from: "2026-11-08", to: "2026-11-08" } });
  });

  it("/kagawa?from=...&to=... は日付範囲", () => {
    const r = parseSearch({
      prefecture: "kagawa",
      params: new URLSearchParams("from=2026-11-01&to=2026-11-30"),
      now,
    });
    expect(r).toEqual({ ok: true, query: { prefecture: "香川県", slug: "kagawa", from: "2026-11-01", to: "2026-11-30" } });
  });

  it("from / to がなければ今日から 30 日間", () => {
    const r = parseSearch({ prefecture: "kagawa", params: new URLSearchParams(), now });
    expect(r).toMatchObject({ ok: true, query: { from: "2026-11-03", to: "2026-12-03" } });
  });

  it("from だけなら from から 30 日間、to だけなら今日から to まで", () => {
    expect(parseSearch({ prefecture: "kagawa", params: new URLSearchParams("from=2026-12-01"), now })).toMatchObject({
      ok: true,
      query: { from: "2026-12-01", to: "2026-12-31" },
    });
    expect(parseSearch({ prefecture: "kagawa", params: new URLSearchParams("to=2026-11-10"), now })).toMatchObject({
      ok: true,
      query: { from: "2026-11-03", to: "2026-11-10" },
    });
  });

  it("空文字のパラメータは未指定として扱う（フォーム送信）", () => {
    const r = parseSearch({ prefecture: "kagawa", params: new URLSearchParams("from=&to=&age="), now });
    expect(r).toMatchObject({ ok: true, query: { from: "2026-11-03", to: "2026-12-03" } });
    expect(r.ok && r.query.age).toBeUndefined();
  });

  it("対象年齢 age を整数で受ける", () => {
    const r = parseSearch({ prefecture: "kagawa", date: "2026-11-08", params: new URLSearchParams("age=5"), now });
    expect(r).toMatchObject({ ok: true, query: { age: 5 } });
  });

  it.each(["-1", "19", "3.5", "abc"])("age=%s は不正", (age) => {
    const r = parseSearch({ prefecture: "kagawa", params: new URLSearchParams({ age }), now });
    expect(r).toEqual({ ok: false, status: 400, reason: "invalid-age" });
  });

  it("知らない都道府県は 404", () => {
    expect(parseSearch({ prefecture: "atlantis", params: new URLSearchParams(), now })).toEqual({
      ok: false,
      status: 404,
      reason: "unknown-prefecture",
    });
  });

  it.each(["2026-13-01", "2026-02-30", "20261108", "2026-1-8"])("日付 %s は不正", (date) => {
    expect(parseSearch({ prefecture: "kagawa", date, params: new URLSearchParams(), now })).toEqual({
      ok: false,
      status: 404,
      reason: "invalid-date",
    });
    expect(parseSearch({ prefecture: "kagawa", params: new URLSearchParams({ from: date }), now })).toEqual({
      ok: false,
      status: 400,
      reason: "invalid-date",
    });
  });

  it("from > to は不正", () => {
    expect(
      parseSearch({ prefecture: "kagawa", params: new URLSearchParams("from=2026-11-10&to=2026-11-01"), now }),
    ).toEqual({ ok: false, status: 400, reason: "invalid-range" });
  });

  it("範囲は最大 92 日", () => {
    expect(
      parseSearch({ prefecture: "kagawa", params: new URLSearchParams("from=2026-11-01&to=2027-01-31"), now }),
    ).toMatchObject({ ok: true });
    expect(
      parseSearch({ prefecture: "kagawa", params: new URLSearchParams("from=2026-11-01&to=2027-02-02"), now }),
    ).toEqual({ ok: false, status: 400, reason: "range-too-long" });
  });
});

describe("searchPath: 検索条件 → 固定 URL", () => {
  it("1 日なら /県/日付", () => {
    expect(searchPath({ slug: "kagawa", from: "2026-11-08", to: "2026-11-08" })).toBe("/kagawa/2026-11-08");
    expect(searchPath({ slug: "kagawa", from: "2026-11-08", to: "2026-11-08", age: 5 })).toBe(
      "/kagawa/2026-11-08?age=5",
    );
  });
  it("範囲なら /県?from=&to=", () => {
    expect(searchPath({ slug: "kagawa", from: "2026-11-01", to: "2026-11-30", age: 0 })).toBe(
      "/kagawa?from=2026-11-01&to=2026-11-30&age=0",
    );
  });
});

const base: EventRecord = {
  id: 1,
  title: "おはなし会",
  summary: null,
  startAt: "2026-11-08T10:00",
  endAt: null,
  allDay: false,
  prefecture: "香川県",
  city: "高松市",
  venue: "中央図書館",
  ageMin: null,
  ageMax: null,
  withParent: null,
  ageText: null,
  priceFree: null,
  priceText: null,
  categories: [],
  sourceUrl: "https://example.jp/event",
};
const q = { prefecture: "香川県", slug: "kagawa", from: "2026-11-08", to: "2026-11-08" };

describe("matchesQuery: 絞り込み", () => {
  it("都道府県が違えば除外", () => {
    expect(matchesQuery(base, q)).toBe(true);
    expect(matchesQuery({ ...base, prefecture: "徳島県" }, q)).toBe(false);
  });

  it("範囲内に開催日が重なるものだけ", () => {
    expect(matchesQuery({ ...base, startAt: "2026-11-07T23:00" }, q)).toBe(false);
    expect(matchesQuery({ ...base, startAt: "2026-11-09" }, q)).toBe(false);
    expect(matchesQuery({ ...base, startAt: "2026-11-08", allDay: true }, q)).toBe(true);
    // 期間イベント: 前から続いていて当日も開催中
    expect(matchesQuery({ ...base, startAt: "2026-11-01", endAt: "2026-11-10" }, q)).toBe(true);
    expect(matchesQuery({ ...base, startAt: "2026-11-01", endAt: "2026-11-07" }, q)).toBe(false);
    expect(matchesQuery({ ...base, startAt: "2026-11-01T10:00", endAt: "2026-11-08T12:00" }, q)).toBe(true);
  });

  it("対象年齢: 範囲に入るもの・年齢不明のものを残す", () => {
    const q5 = { ...q, age: 5 };
    expect(matchesQuery(base, q5)).toBe(true);
    expect(matchesQuery({ ...base, ageMin: 3, ageMax: 6 }, q5)).toBe(true);
    expect(matchesQuery({ ...base, ageMin: 6 }, q5)).toBe(false);
    expect(matchesQuery({ ...base, ageMax: 4 }, q5)).toBe(false);
    expect(matchesQuery({ ...base, ageMin: 5, ageMax: 5 }, q5)).toBe(true);
  });
});
