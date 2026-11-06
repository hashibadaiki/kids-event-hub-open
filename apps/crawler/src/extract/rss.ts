import { decodeEntities, stripTags } from "./text";
import type { RawEvent } from "./types";

/**
 * RSS 2.0 / RSS 1.0 / Atom の記事を候補にする。
 * pubDate は掲載日で開催日ではないので使わず、タイトルと本文から日付を読む（dateText）。
 * 本文は content:encoded（全文）を description（抜粋のことがある）より優先する
 */
export function extractRss(xml: string): RawEvent[] {
  const items = [...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  const out: RawEvent[] = [];
  for (const item of items) {
    const title = text(tag(item, "title"));
    if (!title) continue;
    const body = tag(item, "content:encoded") ?? tag(item, "description") ?? tag(item, "summary") ?? tag(item, "content");
    const description = text(body) || null;
    const dateBody = eventDateText(body);
    out.push({
      title,
      dateText: dateBody ? `${title} ${dateBody}` : title,
      description,
      url: link(item),
    });
  }
  return out;
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  return m ? m[1]! : null;
}

function html(raw: string): string {
  const unwrapped = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  return /<!\[CDATA\[/.test(raw) ? unwrapped : decodeEntities(unwrapped);
}

function text(raw: string | null): string {
  return raw === null ? "" : stripTags(html(raw));
}

const BULLET = "[\\s【〔［\\[(（■□●○◆◇・*]*";
const LABEL_END = "(?:[】〕］\\])）:：]|\\s|$)";
const DATE_LABEL_RE = new RegExp(`^${BULLET}(日時|開催日時?|日程|日にち|期日|会期|期間|とき|時間)${LABEL_END}`);
const APPLY_LABEL_RE = new RegExp(`^${BULLET}(申込|申し込み|受付|応募|募集|締切|締め切り)`);
const APPLY_PERIOD_RE = /(申込|申し込み|受付|応募|募集)(期間|期限|期日|開始|締切|締め切り)/;
const LABEL_ONLY_RE = new RegExp(`^${BULLET}[^0-9０-９]{1,8}?[】〕］\\])）:：\\s]*$`);
const MONTH_DAY_RE = /[0-9０-９]{1,2}\s*[月/／]\s*[0-9０-９]{1,2}/;

/**
 * 正規化は最初の日付を開始日にするが、長い本文では申込期間が開催日より前に書かれていることがある。
 * そのため月日を含む「日時」などの見出しの行があればそれだけを、なければ申込・受付の行を除いた本文を返す。
 * 除くと月日が残らないとき（1 行の本文など）は本文をそのまま返す
 */
function eventDateText(raw: string | null): string {
  if (raw === null) return "";
  const lines = joinLabelLines(
    html(raw)
      .split(/<(?:br|\/p|\/li|\/tr|\/th|\/td|\/dt|\/dd|\/h\d|\/div)\b[^>]*>|\n/i)
      .map(stripTags)
      .filter(Boolean),
  );
  const labeled = lines.filter((l) => DATE_LABEL_RE.test(l)).join(" ");
  if (MONTH_DAY_RE.test(labeled)) return labeled;
  const withoutApply = lines.filter((l) => !APPLY_LABEL_RE.test(l) && !APPLY_PERIOD_RE.test(l)).join(" ");
  return MONTH_DAY_RE.test(withoutApply) ? withoutApply : lines.join(" ");
}

function joinLabelLines(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1];
    if (next !== undefined && LABEL_ONLY_RE.test(line) && (DATE_LABEL_RE.test(line) || APPLY_LABEL_RE.test(line))) {
      out.push(`${line} ${next}`);
      i++;
    } else {
      out.push(line);
    }
  }
  return out;
}

function link(item: string): string | null {
  const rss = tag(item, "link");
  if (rss && rss.trim()) return text(rss);
  const atom = /<link\b[^>]*?(?:rel=["']alternate["'][^>]*?)?href=["']([^"']+)["']/i.exec(item);
  return atom ? decodeEntities(atom[1]!) : null;
}
