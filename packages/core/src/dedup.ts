import { toHalfWidth } from "./normalize/text";

export type DedupCandidate = {
  title: string;
  /** "YYYY-MM-DD" または "YYYY-MM-DDTHH:mm"。不明なら null */
  start: string | null;
  venue?: string | null;
};

export const TITLE_THRESHOLD = 0.6;
export const VENUE_THRESHOLD = 0.5;
/** 片方がもう片方を含むときの類似度（「〜教室」と「〜教室 第2回」など） */
const CONTAINS_SCORE = 0.9;
const MIN_CONTAINS_LENGTH = 4;

/** 比較用に、全角・大小文字・空白・記号の差をなくす */
export function normalizeForCompare(text: string): string {
  return toHalfWidth(text)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

/** 文字 bigram の Dice 係数（0〜1）。片方がもう片方を含む場合は高めに扱う */
export function titleSimilarity(a: string, b: string): number {
  return similarity(normalizeForCompare(a), normalizeForCompare(b));
}

/**
 * 同じイベントかどうか。開始日が同じ・タイトルが近い・場所が近い（片方不明なら問わない）のすべてを満たすとき true。
 */
export function isDuplicate(a: DedupCandidate, b: DedupCandidate): boolean {
  if (!a.start || !b.start || a.start.slice(0, 10) !== b.start.slice(0, 10)) return false;
  if (titleSimilarity(a.title, b.title) < TITLE_THRESHOLD) return false;
  if (a.venue && b.venue) {
    return similarity(normalizeForCompare(a.venue), normalizeForCompare(b.venue)) >= VENUE_THRESHOLD;
  }
  return true;
}

/** 先に出たものを残して重複を取り除く */
export function dedupe<T extends DedupCandidate>(events: readonly T[]): T[] {
  const kept: T[] = [];
  for (const e of events) {
    if (!kept.some((k) => isDuplicate(k, e))) kept.push(e);
  }
  return kept;
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const dice = bigramDice(a, b);
  if (short.length >= MIN_CONTAINS_LENGTH && long.includes(short)) return Math.max(dice, CONTAINS_SCORE);
  return dice;
}

function bigramDice(a: string, b: string): number {
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (ba.length === 0 || bb.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const g of ba) counts.set(g, (counts.get(g) ?? 0) + 1);
  let common = 0;
  for (const g of bb) {
    const c = counts.get(g) ?? 0;
    if (c > 0) {
      common++;
      counts.set(g, c - 1);
    }
  }
  return (2 * common) / (ba.length + bb.length);
}

function bigrams(s: string): string[] {
  const chars = [...s];
  if (chars.length === 1) return chars;
  const out: string[] = [];
  for (let i = 0; i < chars.length - 1; i++) out.push(chars[i]! + chars[i + 1]!);
  return out;
}
