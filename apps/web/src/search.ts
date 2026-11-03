import { prefectureBySlug } from "./prefectures";

/** 一覧の検索条件。from / to は JST の `YYYY-MM-DD`（両端含む） */
export type SearchQuery = {
  prefecture: string; // events.prefecture と同じ正式名（例: 香川県）
  slug: string; // URL 用（例: kagawa）
  from: string;
  to: string;
  age?: number;
  /** タイトル・概要・会場・市町村の部分一致。空白区切りは AND */
  keyword?: string;
};

export type ParseResult =
  | { ok: true; query: SearchQuery }
  | { ok: false; status: 400 | 404; reason: string };

export const DEFAULT_RANGE_DAYS = 30;
export const MAX_RANGE_DAYS = 92;
export const MAX_AGE = 18;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
const JST_OFFSET_MS = 9 * 3_600_000;

const toUtc = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** 実在する `YYYY-MM-DD` か */
export function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  return fromUtc(toUtc(s)) === s;
}

export const addDays = (date: string, days: number) => fromUtc(toUtc(date) + days * DAY_MS);
export const todayJst = (now: Date) => fromUtc(now.getTime() + JST_OFFSET_MS);
const daysBetween = (from: string, to: string) => Math.round((toUtc(to) - toUtc(from)) / DAY_MS);

/**
 * URL → 検索条件。
 * - `/:pref/:date` はその 1 日
 * - `/:pref?from=&to=` は範囲。未指定は今日から 30 日間
 * - `age` は対象年齢（0〜18 の整数）
 */
export function parseSearch(input: {
  prefecture: string;
  date?: string;
  params: URLSearchParams;
  now: Date;
}): ParseResult {
  const pref = prefectureBySlug(input.prefecture);
  if (!pref) return { ok: false, status: 404, reason: "unknown-prefecture" };

  const param = (k: string) => input.params.get(k) || undefined; // 空文字は未指定

  let age: number | undefined;
  const ageParam = param("age");
  if (ageParam !== undefined) {
    if (!/^\d+$/.test(ageParam) || Number(ageParam) > MAX_AGE) {
      return { ok: false, status: 400, reason: "invalid-age" };
    }
    age = Number(ageParam);
  }

  let from: string;
  let to: string;
  if (input.date !== undefined) {
    if (!isValidDate(input.date)) return { ok: false, status: 404, reason: "invalid-date" };
    from = to = input.date;
  } else {
    const f = param("from");
    const t = param("to");
    if ((f && !isValidDate(f)) || (t && !isValidDate(t))) {
      return { ok: false, status: 400, reason: "invalid-date" };
    }
    from = f ?? todayJst(input.now);
    to = t ?? addDays(from, DEFAULT_RANGE_DAYS);
    if (from > to) return { ok: false, status: 400, reason: "invalid-range" };
    if (daysBetween(from, to) > MAX_RANGE_DAYS) return { ok: false, status: 400, reason: "range-too-long" };
  }

  const query: SearchQuery = { prefecture: pref.name, slug: pref.slug, from, to };
  if (age !== undefined) query.age = age;
  return { ok: true, query };
}

/** 検索条件 → 固定 URL（canonical） */
export function searchPath(q: Pick<SearchQuery, "slug" | "from" | "to" | "age">): string {
  const params = new URLSearchParams();
  let path = `/${q.slug}`;
  if (q.from === q.to) {
    path += `/${q.from}`;
  } else {
    params.set("from", q.from);
    params.set("to", q.to);
  }
  if (q.age !== undefined) params.set("age", String(q.age));
  const s = params.toString();
  return s ? `${path}?${s}` : path;
}

/** キーワード → 検索語（全角・半角の空白で分割） */
export const keywordTerms = (keyword: string | undefined): string[] =>
  (keyword ?? "").split(/[\s\u3000]+/).filter((t) => t.length > 0);

/** SQLite の LIKE と同じく ASCII だけ大文字小文字を区別しない */
const foldAscii = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

type Matchable = {
  title: string;
  summary: string | null;
  venue: string | null;
  city: string | null;
  prefecture: string;
  startAt: string;
  endAt: string | null;
  ageMin: number | null;
  ageMax: number | null;
};

/**
 * イベントが条件に合うか。
 * - 期間 [from, to] と開催期間が重なる: `start_at < to の翌日 AND coalesce(end_at, start_at) >= from`
 * - 対象年齢: 範囲に入る、または年齢の記載がない（不明なものは落とさない）
 * - キーワード: 各語がタイトル・概要・会場・市町村のどれかに含まれる
 * D1 実装の SQL もこの条件に合わせる
 */
export function matchesQuery<T extends Matchable>(e: T, q: SearchQuery): boolean {
  if (e.prefecture !== q.prefecture) return false;
  if (!(e.startAt < addDays(q.to, 1) && (e.endAt ?? e.startAt).slice(0, 10) >= q.from)) return false;
  if (q.age !== undefined) {
    if (e.ageMin !== null && e.ageMin > q.age) return false;
    if (e.ageMax !== null && e.ageMax < q.age) return false;
  }
  const terms = keywordTerms(q.keyword);
  if (terms.length > 0) {
    const haystack = [e.title, e.summary, e.venue, e.city].map((f) => foldAscii(f ?? ""));
    if (!terms.every((t) => haystack.some((h) => h.includes(foldAscii(t))))) return false;
  }
  return true;
}
