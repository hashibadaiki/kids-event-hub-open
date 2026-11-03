import { toHalfWidth } from "./text";

/**
 * 正規化した対象年齢（満年齢、両端を含む）。null は「制限なし / 不明」。
 * withParent は親子・保護者同伴の参加を想定したイベントかどうか。
 */
export type NormalizedAge = {
  minAge: number | null;
  maxAge: number | null;
  withParent: boolean;
};

type Span = { min: number; max: number };

const grade = (from: number, to: number): Span => ({ min: from + 5, max: to + 6 });

/** 学年・区分の語と年齢の対応。小学 N 年生は N+5〜N+6 歳とする */
const TERMS: Record<string, Span> = {
  未就学児: { min: 0, max: 6 },
  未就学: { min: 0, max: 6 },
  乳幼児: { min: 0, max: 6 },
  乳児: { min: 0, max: 1 },
  幼児: { min: 1, max: 6 },
  年少: { min: 3, max: 4 },
  年中: { min: 4, max: 5 },
  年長: { min: 5, max: 6 },
  低学年: grade(1, 3),
  中学年: grade(3, 4),
  高学年: grade(4, 6),
  小学生: grade(1, 6),
  中学生: { min: 12, max: 15 },
  高校生: { min: 15, max: 18 },
};

const TOKEN_RE = new RegExp(
  [
    String.raw`小学校?\s*(\d)\s*~\s*(\d)\s*年生?`,
    String.raw`小学校?\s*(\d)\s*年生?`,
    String.raw`小(\d)`,
    String.raw`(\d{1,2})\s*~\s*(\d{1,2})\s*歳`,
    String.raw`(\d{1,2})\s*歳`,
    Object.keys(TERMS)
      .sort((a, b) => b.length - a.length)
      .join("|"),
  ].join("|"),
  "g",
);
const LOWER_BOUND_RE = /^\s*(?:以上|から|~\s*$)/;
const UPPER_BOUND_RE = /^\s*(?:以下|まで)/;
const PARENT_RE = /親子|保護者|家族|同伴/;

export function normalizeAge(text: string): NormalizedAge {
  const s = toHalfWidth(text);
  const withParent = PARENT_RE.test(s);
  const tokens = [...s.matchAll(TOKEN_RE)].map((m) => ({ span: toSpan(m), end: m.index! + m[0].length }));

  if (tokens.length === 0) return { minAge: null, maxAge: null, withParent };
  if (tokens.length >= 2) {
    return { minAge: tokens[0]!.span.min, maxAge: tokens[tokens.length - 1]!.span.max, withParent };
  }
  const { span, end } = tokens[0]!;
  const after = s.slice(end);
  if (LOWER_BOUND_RE.test(after)) return { minAge: span.min, maxAge: null, withParent };
  if (UPPER_BOUND_RE.test(after)) return { minAge: 0, maxAge: span.max, withParent };
  return { minAge: span.min, maxAge: span.max, withParent };
}

function toSpan(m: RegExpMatchArray): Span {
  if (m[1] !== undefined) return grade(Number(m[1]), Number(m[2]));
  if (m[3] !== undefined) return grade(Number(m[3]), Number(m[3]));
  if (m[4] !== undefined) return grade(Number(m[4]), Number(m[4]));
  if (m[5] !== undefined) return { min: Number(m[5]), max: Number(m[6]) };
  if (m[7] !== undefined) return { min: Number(m[7]), max: Number(m[7]) };
  return TERMS[m[0]]!;
}
