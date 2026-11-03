import { isDuplicate } from "@kids-event-hub/core";
import { toEventRow, type EventRow } from "../crawl/normalize";
import type { RawEvent } from "../extract/types";

/** これを下回ったら改善ジョブを起動する */
export const QUALITY_THRESHOLD = 0.7;
/** 採用に必要な最小の改善幅（スコアの差） */
export const MIN_GAIN = 0.02;
/** 候補の抽出件数が旧版のこの割合を下回ったら採用しない */
export const MIN_EXTRACTED_RATIO = 0.8;

/** 各指標の重み（合計 1）。率が高いほど良い指標と、低いほど良い指標（重複率・欠損率）がある */
export const WEIGHTS = { dateRate: 0.35, venueRate: 0.15, ageRate: 0.15, duplicateRate: 0.15, missingRate: 0.2 } as const;

export type QualityReport = {
  /** 抽出した候補の数（分母） */
  extracted: number;
  /** 日付取得率: 開始日を決められた候補 / 候補 */
  dateRate: number;
  /** 場所取得率: 会場がある候補 / 候補 */
  venueRate: number;
  /** 対象年齢取得率: 年齢の表記がある・正規化で取れた候補 / 候補 */
  ageRate: number;
  /** 重複率: 日付が取れた候補のうち、同じ抽出内の他の候補と重複するもの */
  duplicateRate: number;
  /** 必須項目（タイトル・日付・会場）のどれかが欠けている候補 / 候補 */
  missingRate: number;
  /** 0〜1。重み付きの合計 */
  score: number;
};

type Ctx = { prefecture: string; sourceUrl: string; referenceDate: Date };

const round = (n: number) => Math.round(n * 1000) / 1000;
const has = (v: string | null | undefined) => typeof v === "string" && v.trim() !== "";

/** 抽出結果を採点する（固定データでテストできる純粋関数） */
export function scoreExtraction(raws: RawEvent[], ctx: Ctx): QualityReport {
  const n = raws.length;
  if (n === 0) return { extracted: 0, dateRate: 0, venueRate: 0, ageRate: 0, duplicateRate: 0, missingRate: 0, score: 0 };

  const rows = raws.map((r) => toEventRow(r, ctx));
  let dated = 0;
  let withVenue = 0;
  let withAge = 0;
  let missing = 0;
  let duplicates = 0;
  const kept: EventRow[] = [];
  raws.forEach((raw, i) => {
    const row = rows[i];
    if (row) dated++;
    if (has(raw.venue)) withVenue++;
    if (has(raw.ageText) || (row && (row.ageMin != null || row.ageMax != null))) withAge++;
    if (!has(raw.title) || !row || !has(raw.venue)) missing++;
    if (row) {
      const c = { title: row.title, start: row.startAt, venue: row.venue };
      if (kept.some((k) => k.dedupKey === row.dedupKey || isDuplicate({ title: k.title, start: k.startAt, venue: k.venue }, c))) duplicates++;
      else kept.push(row);
    }
  });

  const r = {
    dateRate: dated / n,
    venueRate: withVenue / n,
    ageRate: withAge / n,
    duplicateRate: dated === 0 ? 0 : duplicates / dated,
    missingRate: missing / n,
  };
  const score =
    WEIGHTS.dateRate * r.dateRate +
    WEIGHTS.venueRate * r.venueRate +
    WEIGHTS.ageRate * r.ageRate +
    WEIGHTS.duplicateRate * (1 - r.duplicateRate) +
    WEIGHTS.missingRate * (1 - r.missingRate);
  return {
    extracted: n,
    dateRate: round(r.dateRate),
    venueRate: round(r.venueRate),
    ageRate: round(r.ageRate),
    duplicateRate: round(r.duplicateRate),
    missingRate: round(r.missingRate),
    score: round(score),
  };
}

/** 改善ジョブを起動するか。採点できなかった（null）は対象外 */
export function needsImprovement(score: number | null | undefined, threshold = QUALITY_THRESHOLD): boolean {
  return typeof score === "number" && score < threshold;
}

/** 新旧のスコアを比べて採否を決める。良くなった場合だけ採用する */
export function decideAdoption(
  baseline: { score: number; extracted: number },
  candidate: { score: number; extracted: number },
  opts: { minGain?: number; minExtractedRatio?: number } = {},
): { adopt: boolean; reason: string } {
  const minGain = opts.minGain ?? MIN_GAIN;
  const ratio = opts.minExtractedRatio ?? MIN_EXTRACTED_RATIO;
  const scores = `スコア ${baseline.score} → ${candidate.score}`;
  if (candidate.extracted < baseline.extracted * ratio) {
    return { adopt: false, reason: `${scores}。抽出件数が ${baseline.extracted} → ${candidate.extracted} 件に減ったため採用しない` };
  }
  // 浮動小数の誤差で 0.02 ちょうどを落とさないよう丸めて比べる
  if (round(candidate.score - baseline.score) < minGain) {
    return { adopt: false, reason: `${scores}。改善幅が ${minGain} 未満のため採用しない` };
  }
  return { adopt: true, reason: `${scores}（抽出件数 ${baseline.extracted} → ${candidate.extracted}）` };
}
