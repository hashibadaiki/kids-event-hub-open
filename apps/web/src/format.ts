import type { EventRecord } from "./repository";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

const parts = (date: string) => {
  const [y, m, d] = date.slice(0, 10).split("-").map(Number);
  return { y, m, d, w: WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] };
};
const time = (s: string) => (s.length > 10 ? s.slice(11, 16) : "");

/** `2026-11-08` → `2026年11月8日(日)` */
export function formatDateLong(date: string): string {
  const { y, m, d, w } = parts(date);
  return `${y}年${m}月${d}日(${w})`;
}

/** `2026-11-08` → `11月8日(日)` */
export function formatDateShort(date: string): string {
  const { m, d, w } = parts(date);
  return `${m}月${d}日(${w})`;
}

/** 検索範囲の見出し */
export function formatRange(from: string, to: string): string {
  return from === to ? formatDateLong(from) : `${formatDateLong(from)}〜${formatDateLong(to)}`;
}

/** イベントの日時。例: `11月8日(日) 10:00〜11:00`、`11月1日(日)〜11月30日(月)` */
export function formatWhen(e: Pick<EventRecord, "startAt" | "endAt">): string {
  const start = `${formatDateShort(e.startAt)}${time(e.startAt) && " " + time(e.startAt)}`;
  if (!e.endAt) return start;
  const sameDay = e.endAt.slice(0, 10) === e.startAt.slice(0, 10);
  if (sameDay) return time(e.endAt) ? `${start}〜${time(e.endAt)}` : start;
  return `${start}〜${formatDateShort(e.endAt)}${time(e.endAt) && " " + time(e.endAt)}`;
}

/** 対象年齢の表示。元の表記を優先 */
export function formatAge(e: Pick<EventRecord, "ageText" | "ageMin" | "ageMax" | "withParent">): string | null {
  if (e.ageText) return e.ageText;
  if (e.ageMin === null && e.ageMax === null) return null;
  const range =
    e.ageMin !== null && e.ageMax !== null
      ? e.ageMin === e.ageMax
        ? `${e.ageMin}歳`
        : `${e.ageMin}〜${e.ageMax}歳`
      : e.ageMin !== null
        ? `${e.ageMin}歳以上`
        : `${e.ageMax}歳以下`;
  return e.withParent ? `${range}（保護者同伴）` : range;
}

/** 料金の表示。元の表記を優先 */
export function formatPrice(e: Pick<EventRecord, "priceText" | "priceFree">): string | null {
  if (e.priceText) return e.priceText;
  if (e.priceFree === true) return "無料";
  return null;
}

/** 元 URL が PDF か（PDF チラシ由来の判定） */
export function isPdfUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}
