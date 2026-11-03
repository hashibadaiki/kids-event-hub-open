const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** Date → JST の "YYYY-MM-DDTHH:mm" */
export function jstLocal(date: Date): string {
  return new Date(date.getTime() + JST_OFFSET_MS).toISOString().slice(0, 16);
}

/**
 * ISO 8601 の日付 / 日時を JST ローカル表記にする。
 * 日付だけなら allDay。オフセットのない日時は JST とみなす。読めなければ null
 */
export function isoToJst(value: unknown): { at: string; allDay: boolean } | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dateOnly) return { at: s, allDay: true };
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (!m) return null;
  if (!m[4]) return { at: `${m[1]}T${m[2]}:${m[3]}`, allDay: false };
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : { at: jstLocal(d), allDay: false };
}
