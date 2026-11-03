import { jsonLdBlocks } from "../crawl/detect";
import { absoluteUrl, stripTags } from "./text";
import { isoToJst } from "./time";
import type { RawEvent } from "./types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? stripTags(v) : null);

/** HTML 内の JSON-LD から schema.org の Event（ChildrensEvent など *Event を含む）を取り出す */
export function extractJsonLd(html: string, pageUrl: string): RawEvent[] {
  const out: RawEvent[] = [];
  for (const block of jsonLdBlocks(html)) {
    let data: unknown;
    try {
      data = JSON.parse(block);
    } catch {
      continue; // 壊れた JSON-LD は無視
    }
    for (const node of walk(data)) {
      const e = toRawEvent(node, pageUrl);
      if (e) out.push(e);
    }
  }
  return out;
}

function* walk(v: unknown): Generator<Obj> {
  if (Array.isArray(v)) {
    for (const x of v) yield* walk(x);
  } else if (isObj(v)) {
    if (isEvent(v)) yield v;
    if (v["@graph"]) yield* walk(v["@graph"]);
  }
}

function isEvent(o: Obj): boolean {
  const t = o["@type"];
  const types = Array.isArray(t) ? t : [t];
  return types.some((x) => typeof x === "string" && /Event$/.test(x));
}

function toRawEvent(o: Obj, pageUrl: string): RawEvent | null {
  const title = str(o.name);
  if (!title) return null;
  const start = isoToJst(o.startDate);
  const end = isoToJst(o.endDate);
  const { venue, city } = location(o.location);
  const price = offers(o.offers);
  const free = o.isAccessibleForFree === true || o.isAccessibleForFree === "true" ? true : price.free;
  return {
    title,
    start: start?.at ?? null,
    end: end?.at ?? null,
    allDay: start?.allDay ?? false,
    dateText: null,
    venue,
    city,
    description: str(o.description),
    url: absoluteUrl(typeof o.url === "string" ? o.url : null, pageUrl),
    ageText: ageRange(o.typicalAgeRange),
    priceText: price.text,
    priceFree: free,
  };
}

function location(v: unknown): { venue: string | null; city: string | null } {
  const first = Array.isArray(v) ? v[0] : v;
  if (typeof first === "string") return { venue: str(first), city: null };
  if (!isObj(first)) return { venue: null, city: null };
  const address = first.address;
  const city = isObj(address) ? str(address.addressLocality) : null;
  return { venue: str(first.name) ?? (typeof address === "string" ? str(address) : null), city };
}

function offers(v: unknown): { text: string | null; free: boolean | null } {
  const list = (Array.isArray(v) ? v : [v]).filter(isObj);
  const prices = list.map((o) => Number(o.price)).filter((n) => Number.isFinite(n));
  if (prices.length === 0) return { text: null, free: null };
  if (prices.every((p) => p === 0)) return { text: "無料", free: true };
  return { text: prices.map((p) => (p === 0 ? "無料" : `${p}円`)).join("、"), free: false };
}

/** typicalAgeRange: "5-12" / "5-" → normalizeAge が読める表記に */
function ageRange(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})?\s*$/.exec(v);
  if (!m) return str(v);
  return m[2] ? `${m[1]}~${m[2]}歳` : `${m[1]}歳以上`;
}
