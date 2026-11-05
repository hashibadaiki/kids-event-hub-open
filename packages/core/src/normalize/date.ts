import { toHalfWidth } from "./text";

export type Recurrence = { freq: "weekly"; weekdays: number[] };

/** 書かれた曜日と解釈した日付の曜日が合わなかったときの扱い。前後 1 か月で曜日が合う月に直した（corrected）か、日付なしにした（dropped） */
export type WeekdayMismatch = "corrected" | "dropped";

/**
 * 正規化した日付。日時は JST のローカル表記。
 * - 終日: "YYYY-MM-DD"
 * - 時刻あり: "YYYY-MM-DDTHH:mm"
 * 「毎週土曜」のように期間が書かれていない繰り返しは start / end が null になる。
 */
export type NormalizedDate = {
  start: string | null;
  end: string | null;
  allDay: boolean;
  recurrence: Recurrence | null;
  weekdayMismatch?: WeekdayMismatch;
};

export type NormalizeDateOptions = {
  /** 年が省略されたときの基準日（通常は取得日時）。既定は現在時刻 */
  referenceDate?: Date;
};

type Ymd = { y: number; m: number; d: number };

const ERA_OFFSET: Record<string, number> = { 令和: 2018, 平成: 1988 };
const WEEKDAYS = "日月火水木金土";
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
/** 年省略時、基準日よりこれ以上前なら翌年とみなす */
const PAST_TOLERANCE_DAYS = 180;

const DATE_RE =
  /(?:(?:(令和|平成)(\d{1,2})年|(\d{4})年)\s*)?(\d{1,2})月\s*(\d{1,2})日|(\d{4})[/.](\d{1,2})[/.](\d{1,2})|(\d{1,2})\/(\d{1,2})/g;
const TIME_RE = /(午前|午後)?\s*(\d{1,2})(?::(\d{2})|時(?:\s*(\d{1,2})分|(半))?)/g;
const RANGE_SEP_RE = /^\s*(?:\([^)]*\))?\s*(?:~|-|から)\s*$/;
const DAY_ONLY_END_RE = /^\s*(?:\([^)]*\))?\s*(?:~|-|から)\s*(\d{1,2})日/;
const WEEKLY_RE = /毎週\s*((?:[日月火水木金土](?:曜日?)?\s*[・、,と]?\s*)+)/;
const WRITTEN_WEEKDAY_RE = /^\s*\(?\s*([日月火水木金土])(?:曜日?)?(?=[)・\s]|$)/;

export function normalizeDate(text: string, options: NormalizeDateOptions = {}): NormalizedDate | null {
  const s = toHalfWidth(text).replace(/元年/g, "1年");
  if (!s) return null;
  const ref = jstYmd(options.referenceDate ?? new Date());

  const recurrence = parseWeekly(s);

  const matches = [...s.matchAll(DATE_RE)];
  let startYmd: Ymd | null = null;
  let endYmd: Ymd | null = null;
  let weekdayMismatch: WeekdayMismatch | undefined;
  let rest = s;

  if (matches.length > 0) {
    const first = matches[0]!;
    const firstEndIdx = first.index! + first[0].length;
    const startExplicit = toExplicitYmd(first);
    startYmd = withYear(startExplicit, ref);
    if (!startYmd) return null;

    const written = writtenWeekday(s.slice(firstEndIdx));
    if (written !== null && weekdayOf(startYmd) !== written) {
      const corrected = adjacentMonthWithWeekday(startYmd, written);
      if (!corrected) return { start: null, end: null, allDay: true, recurrence, weekdayMismatch: "dropped" };
      startYmd = corrected;
      weekdayMismatch = "corrected";
    }

    const second = matches[1];
    const between = second ? s.slice(firstEndIdx, second.index) : "";
    if (second && RANGE_SEP_RE.test(between)) {
      const endExplicit = toExplicitYmd(second);
      endYmd = endExplicit.y !== null ? asValid(endExplicit as Ymd) : rollForward(endExplicit, startYmd);
      if (!endYmd) return null;
    } else {
      const dayOnly = DAY_ONLY_END_RE.exec(s.slice(firstEndIdx));
      if (dayOnly) {
        endYmd = rollForward({ y: null, m: startYmd.m, d: Number(dayOnly[1]) }, startYmd);
        if (!endYmd) return null;
      }
    }
    // 時刻を探すときに日付の数字を拾わないよう、日付部分を取り除く
    rest = s.replace(DATE_RE, " ");
  } else if (!recurrence) {
    return null;
  }

  const times = parseTimes(rest);
  const startTime = times[0] ?? null;
  let endTime = times[1] ?? startTime;
  if (startTime && endTime && times[1] && endTime < startTime && Number(endTime.slice(0, 2)) < 12) {
    // 「午後1時～3時」のように後半の午前/午後が省略された場合
    endTime = `${pad(Number(endTime.slice(0, 2)) + 12)}${endTime.slice(2)}`;
  }

  const startDate = startYmd ? formatYmd(startYmd) : null;
  const endDate = endYmd ? formatYmd(endYmd) : startDate;
  return {
    start: startDate && startTime ? `${startDate}T${startTime}` : startDate,
    end: endDate && endTime ? `${endDate}T${endTime}` : endDate,
    allDay: startTime === null,
    recurrence,
    ...(weekdayMismatch && { weekdayMismatch }),
  };
}

function writtenWeekday(after: string): number | null {
  const m = WRITTEN_WEEKDAY_RE.exec(after);
  return m ? WEEKDAYS.indexOf(m[1]!) : null;
}

/** 前後 1 か月の同じ日のうち、曜日が合うものが 1 つだけならそれを返す（0 または複数なら決められない） */
function adjacentMonthWithWeekday(start: Ymd, weekday: number): Ymd | null {
  const candidates = [-1, 1]
    .map((delta) => asValid(shiftMonth(start, delta)))
    .filter((c): c is Ymd => c !== null && weekdayOf(c) === weekday);
  return candidates.length === 1 ? candidates[0]! : null;
}

function shiftMonth(p: Ymd, delta: number): Ymd {
  const m = p.m + delta;
  if (m < 1) return { y: p.y - 1, m: 12, d: p.d };
  if (m > 12) return { y: p.y + 1, m: 1, d: p.d };
  return { ...p, m };
}

function weekdayOf(p: Ymd): number {
  return new Date(toUtc(p)).getUTCDay();
}

type PartialYmd = { y: number | null; m: number; d: number };

function toExplicitYmd(m: RegExpMatchArray): PartialYmd {
  if (m[4] !== undefined) {
    let y: number | null = null;
    if (m[1] !== undefined) y = ERA_OFFSET[m[1]]! + Number(m[2]);
    else if (m[3] !== undefined) y = Number(m[3]);
    return { y, m: Number(m[4]), d: Number(m[5]) };
  }
  if (m[6] !== undefined) return { y: Number(m[6]), m: Number(m[7]), d: Number(m[8]) };
  return { y: null, m: Number(m[9]), d: Number(m[10]) };
}

/** 年が無ければ基準日の年で補い、基準日より大きく過去なら翌年にする */
function withYear(p: PartialYmd, ref: Ymd): Ymd | null {
  if (p.y !== null) return asValid({ y: p.y, m: p.m, d: p.d });
  const candidate = asValid({ y: ref.y, m: p.m, d: p.d }) ?? asValid({ y: ref.y + 1, m: p.m, d: p.d });
  if (!candidate) return null;
  if (daysBetween(candidate, ref) > PAST_TOLERANCE_DAYS) return asValid({ ...candidate, y: candidate.y + 1 });
  return candidate;
}

/** 範囲の終わり: 年が無ければ開始と同じ年、開始より前なら翌年 */
function rollForward(p: PartialYmd, start: Ymd): Ymd | null {
  const same = asValid({ y: start.y, m: p.m, d: p.d });
  if (same && toUtc(same) >= toUtc(start)) return same;
  return asValid({ y: start.y + 1, m: p.m, d: p.d });
}

function parseTimes(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(TIME_RE)) {
    let h = Number(m[2]);
    const min = m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? Number(m[4]) : m[5] ? 30 : 0;
    if (m[1] === "午後" && h < 12) h += 12;
    if (m[1] === "午前" && h === 12) h = 0;
    if (h > 24 || min > 59) continue;
    out.push(`${pad(h)}:${pad(min)}`);
  }
  return out;
}

function parseWeekly(s: string): Recurrence | null {
  const m = WEEKLY_RE.exec(s);
  if (!m) return null;
  const days = new Set<number>();
  for (const ch of m[1]!.replace(/曜日?/g, "")) {
    const i = WEEKDAYS.indexOf(ch);
    if (i >= 0) days.add(i);
  }
  if (days.size === 0) return null;
  return { freq: "weekly", weekdays: [...days].sort((a, b) => a - b) };
}

function jstYmd(date: Date): Ymd {
  const j = new Date(date.getTime() + JST_OFFSET_MS);
  return { y: j.getUTCFullYear(), m: j.getUTCMonth() + 1, d: j.getUTCDate() };
}

function asValid(p: Ymd): Ymd | null {
  const t = new Date(toUtc(p));
  if (t.getUTCFullYear() !== p.y || t.getUTCMonth() + 1 !== p.m || t.getUTCDate() !== p.d) return null;
  return p;
}

function toUtc(p: Ymd): number {
  return Date.UTC(p.y, p.m - 1, p.d);
}

function daysBetween(a: Ymd, ref: Ymd): number {
  return (toUtc(ref) - toUtc(a)) / 86_400_000;
}

function formatYmd(p: Ymd): string {
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
