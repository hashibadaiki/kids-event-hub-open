import { jstLocal } from "./time";
import type { RawEvent } from "./types";

/** iCalendar（RFC 5545）の VEVENT を取り出す。TZID 付き・浮動時刻は JST とみなす */
export function extractIcal(text: string): RawEvent[] {
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const out: RawEvent[] = [];
  let cur: Map<string, { params: string; value: string }> | null = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      cur = new Map();
    } else if (line === "END:VEVENT") {
      if (cur) {
        const e = toRawEvent(cur);
        if (e) out.push(e);
      }
      cur = null;
    } else if (cur) {
      const m = /^([A-Za-z-]+)((?:;[^:]*)?):(.*)$/.exec(line);
      if (m && !cur.has(m[1]!.toUpperCase())) cur.set(m[1]!.toUpperCase(), { params: m[2]!, value: m[3]! });
    }
  }
  return out;
}

function toRawEvent(props: Map<string, { params: string; value: string }>): RawEvent | null {
  const text = (key: string) => {
    const v = props.get(key)?.value;
    return v ? unescape(v).trim() || null : null;
  };
  const title = text("SUMMARY");
  if (!title) return null;
  const start = parseDate(props.get("DTSTART"));
  let end = parseDate(props.get("DTEND"));
  if (start?.allDay && end?.allDay) {
    // 終日の DTEND は排他的（翌日）。1 日だけなら end なし
    const last = addDays(end.at, -1);
    end = last > start.at ? { at: last, allDay: true } : null;
  }
  return {
    title,
    start: start?.at ?? null,
    end: end?.at ?? null,
    allDay: start?.allDay ?? false,
    dateText: null,
    venue: text("LOCATION"),
    description: text("DESCRIPTION"),
    url: text("URL"),
  };
}

function parseDate(p: { params: string; value: string } | undefined): { at: string; allDay: boolean } | null {
  if (!p) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(p.value.trim());
  if (!m) return null;
  const ymd = `${m[1]}-${m[2]}-${m[3]}`;
  if (!m[4]) return { at: ymd, allDay: true };
  if (m[7]) return { at: jstLocal(new Date(`${ymd}T${m[4]}:${m[5]}:${m[6]}Z`)), allDay: false };
  return { at: `${ymd}T${m[4]}:${m[5]}`, allDay: false };
}

function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function unescape(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}
