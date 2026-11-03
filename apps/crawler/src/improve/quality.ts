import { isDuplicate } from "@kids-event-hub/core";
import { toEventRow, type EventRow } from "../crawl/normalize";
import type { RawEvent } from "../extract/types";

/** これを下回ったら改善ジョブを起動する */
export const QUALITY_THRESHOLD = 0.7;
/** 自動採用に必要な改善幅（スコアの差。+10pt） */
export const AUTO_ADOPT_GAIN = 0.1;
/** これ未満の改善幅は誤差とみなして却下する。これ以上 AUTO_ADOPT_GAIN 未満は人間の確認に回す */
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

export type AdoptionDecision = "adopted" | "pending" | "rejected";

/**
 * 新旧のスコアを比べて採否を決める。
 * +AUTO_ADOPT_GAIN 以上かつ正しく取れていたイベントを落とさない → 自動採用、MIN_GAIN 以上のそれ以外 → 人間の確認、残り → 却下
 */
export function decideAdoption(
  baseline: { score: number; extracted: number },
  candidate: { score: number; extracted: number },
  opts: { lost?: number; minGain?: number; autoAdoptGain?: number; minExtractedRatio?: number } = {},
): { decision: AdoptionDecision; reason: string } {
  const minGain = opts.minGain ?? MIN_GAIN;
  const autoGain = opts.autoAdoptGain ?? AUTO_ADOPT_GAIN;
  const ratio = opts.minExtractedRatio ?? MIN_EXTRACTED_RATIO;
  const lost = opts.lost ?? 0;
  const scores = `スコア ${baseline.score} → ${candidate.score}`;
  if (candidate.extracted < baseline.extracted * ratio) {
    return { decision: "rejected", reason: `${scores}。抽出件数が ${baseline.extracted} → ${candidate.extracted} 件に減ったため採用しない` };
  }
  // 浮動小数の誤差で閾値ちょうどを落とさないよう丸めて比べる
  const gain = round(candidate.score - baseline.score);
  if (gain < minGain) {
    return { decision: "rejected", reason: `${scores}。改善幅が ${minGain} 未満のため採用しない` };
  }
  if (lost > 0) {
    return { decision: "pending", reason: `${scores}。旧版で正しく取れていたイベントを ${lost} 件落とすため、人間の確認に回す` };
  }
  if (gain < autoGain) {
    return { decision: "pending", reason: `${scores}。改善幅が ${autoGain} 未満のため、人間の確認に回す` };
  }
  return { decision: "adopted", reason: `${scores}（抽出件数 ${baseline.extracted} → ${candidate.extracted}）` };
}

/** 旧版でタイトル・日付・会場がそろって取れていたイベントのうち、新版で見つからないものの数 */
export function lostEvents(baseline: RawEvent[], candidate: RawEvent[], ctx: Ctx): number {
  const after = candidate.map((r) => toEventRow(r, ctx)).filter((r): r is EventRow => r !== null);
  let lost = 0;
  for (const raw of baseline) {
    const row = toEventRow(raw, ctx);
    if (!row || !has(raw.title) || !has(raw.venue)) continue;
    const c = { title: row.title, start: row.startAt, venue: row.venue };
    if (!after.some((a) => a.dedupKey === row.dedupKey || isDuplicate({ title: a.title, start: a.startAt, venue: a.venue }, c))) lost++;
  }
  return lost;
}
