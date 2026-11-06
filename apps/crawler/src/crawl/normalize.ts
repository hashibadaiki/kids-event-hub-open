import {
  classifyCategory,
  normalizeAge,
  normalizeDate,
  normalizeForCompare,
  normalizePrice,
} from "@kids-event-hub/core";
import type { events } from "@kids-event-hub/db";
import type { RawEvent } from "../extract/types";

export type EventRow = Omit<typeof events.$inferInsert, "id" | "sourceId" | "crawlRunId" | "createdAt" | "updatedAt">;

/** 重複キー: 都道府県 + 開催日 + 比較用に正規化したタイトル + 比較用に正規化した会場 */
export function dedupKeyOf(prefecture: string, startAt: string, title: string, venue: string | null): string {
  return `${prefecture}|${startAt.slice(0, 10)}|${normalizeForCompare(title)}|${normalizeForCompare(venue ?? "")}`;
}

/**
 * 抽出した候補を events の行にする（packages/core の正規化を通す）。
 * 開始日が決まらない候補（「毎週土曜」だけ・日付の記載なし）は保存できないので null
 */
export function toEventRow(
  raw: RawEvent,
  ctx: { prefecture: string; sourceUrl: string; referenceDate: Date },
): EventRow | null {
  const title = raw.title.trim();
  if (!title) return null;

  let startAt = raw.start ?? null;
  let endAt = raw.end ?? null;
  let allDay = raw.allDay ?? false;
  let recurrence = null;
  if (!startAt && raw.dateText) {
    const d = normalizeDate(raw.dateText, { referenceDate: ctx.referenceDate });
    if (d) ({ start: startAt, end: endAt, allDay, recurrence } = d);
  }
  if (!startAt) return null;

  const context = [raw.dateText, raw.description].filter(Boolean).join(" ");
  const age = normalizeAge(raw.ageText ?? context);
  const price = normalizePrice(raw.priceText ?? context);
  const priceFree = raw.priceFree ?? price.free;

  return {
    title,
    summary: raw.summary ?? null,
    startAt,
    endAt: endAt && endAt !== startAt ? endAt : null,
    allDay,
    recurrence,
    prefecture: ctx.prefecture,
    city: raw.city ?? null,
    venue: raw.venue ?? null,
    ageMin: age.minAge,
    ageMax: age.maxAge,
    withParent: age.withParent,
    ageText: raw.ageText ?? null,
    priceFree,
    priceMinYen: price.minYen ?? (priceFree ? 0 : null),
    priceMaxYen: price.maxYen ?? (priceFree ? 0 : null),
    priceText: raw.priceText ?? null,
    applyText: raw.applyText ?? null,
    categories: classifyCategory(title, raw.description ?? ""),
    sourceUrl: raw.url ?? ctx.sourceUrl,
    dedupKey: dedupKeyOf(ctx.prefecture, startAt, title, raw.venue ?? null),
  };
}
