import { describe, expect, it } from "vitest";
import { normalizeAge } from "../src/normalize/age";

describe("normalizeAge", () => {
  it("歳〜学年", () => {
    expect(normalizeAge("3歳〜小学生")).toEqual({ minAge: 3, maxAge: 12, withParent: false });
  });

  it("未就学児・乳幼児", () => {
    expect(normalizeAge("未就学児")).toEqual({ minAge: 0, maxAge: 6, withParent: false });
    expect(normalizeAge("乳幼児とその保護者")).toEqual({ minAge: 0, maxAge: 6, withParent: true });
  });

  it("親子", () => {
    expect(normalizeAge("親子")).toEqual({ minAge: null, maxAge: null, withParent: true });
    expect(normalizeAge("小学生とその保護者")).toEqual({ minAge: 6, maxAge: 12, withParent: true });
  });

  it("学年の範囲", () => {
    expect(normalizeAge("小学3〜6年生")).toEqual({ minAge: 8, maxAge: 12, withParent: false });
    expect(normalizeAge("小学1年生")).toEqual({ minAge: 6, maxAge: 7, withParent: false });
    expect(normalizeAge("小学校低学年")).toEqual({ minAge: 6, maxAge: 9, withParent: false });
    expect(normalizeAge("小学校高学年")).toEqual({ minAge: 9, maxAge: 12, withParent: false });
    expect(normalizeAge("小学生〜中学生")).toEqual({ minAge: 6, maxAge: 15, withParent: false });
  });

  it("以上・以下", () => {
    expect(normalizeAge("5歳以上")).toEqual({ minAge: 5, maxAge: null, withParent: false });
    expect(normalizeAge("小学生以下")).toEqual({ minAge: 0, maxAge: 12, withParent: false });
    expect(normalizeAge("中学生以上")).toEqual({ minAge: 12, maxAge: null, withParent: false });
    expect(normalizeAge("０歳から")).toEqual({ minAge: 0, maxAge: null, withParent: false });
  });

  it("歳の範囲", () => {
    expect(normalizeAge("4～6歳")).toEqual({ minAge: 4, maxAge: 6, withParent: false });
    expect(normalizeAge("3歳から6歳まで")).toEqual({ minAge: 3, maxAge: 6, withParent: false });
  });

  it("制限なしは null", () => {
    expect(normalizeAge("どなたでも")).toEqual({ minAge: null, maxAge: null, withParent: false });
  });
});
