import { toHalfWidth } from "./text";

export type PriceItem = { label: string | null; yen: number };

/**
 * 正規化した料金。
 * - free: 全区分無料なら true、費用がかかるなら false、読み取れなければ null
 * - items: 区分ごとの金額（無料の区分は 0 円）。書かれた順
 * - minYen / maxYen: 金額が分かるときの最小・最大
 */
export type NormalizedPrice = {
  free: boolean | null;
  items: PriceItem[];
  minYen: number | null;
  maxYen: number | null;
};

const LABEL = String.raw`([^\s\d,、・/()「」:;。]*?)`;
const YEN_RE = new RegExp(String.raw`${LABEL}\s*:?\s*(\d{1,3}(?:,\d{3})+|\d+)\s*円`, "g");
const FREE_ITEM_RE = new RegExp(String.raw`${LABEL}\s*:?\s*無料`, "g");
const PAID_RE = /有料|費あり|料金あり|実費|自己負担/;

export function normalizePrice(text: string): NormalizedPrice {
  const s = toHalfWidth(text);
  const found: { index: number; item: PriceItem }[] = [];

  for (const m of s.matchAll(YEN_RE)) {
    found.push({ index: m.index!, item: { label: m[1] || null, yen: Number(m[2]!.replace(/,/g, "")) } });
  }
  for (const m of s.matchAll(FREE_ITEM_RE)) {
    if (m[1]) found.push({ index: m.index!, item: { label: m[1], yen: 0 } });
  }
  const items = found.sort((a, b) => a.index - b.index).map((f) => f.item);

  let free: boolean | null = null;
  if (items.some((i) => i.yen > 0) || PAID_RE.test(s)) free = false;
  else if (items.length > 0 || s.includes("無料")) free = true;

  if (items.length > 0) {
    const yens = items.map((i) => i.yen);
    return { free, items, minYen: Math.min(...yens), maxYen: Math.max(...yens) };
  }
  return { free, items, minYen: free ? 0 : null, maxYen: free ? 0 : null };
}
