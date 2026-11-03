import { decodeEntities, stripTags } from "./text";
import type { RawEvent } from "./types";

/**
 * RSS 2.0 / RSS 1.0 / Atom の記事を候補にする。
 * pubDate は掲載日で開催日ではないので使わず、タイトルと本文から日付を読む（dateText）
 */
export function extractRss(xml: string): RawEvent[] {
  const items = [...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  const out: RawEvent[] = [];
  for (const item of items) {
    const title = text(tag(item, "title"));
    if (!title) continue;
    const description = text(tag(item, "description") ?? tag(item, "summary") ?? tag(item, "content")) || null;
    out.push({
      title,
      dateText: description ? `${title} ${description}` : title,
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

/** CDATA を外し、エンティティを戻してから（中の HTML の）タグを落とす */
function text(raw: string | null): string {
  if (raw === null) return "";
  const unwrapped = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const decoded = /<!\[CDATA\[/.test(raw) ? unwrapped : decodeEntities(unwrapped);
  return stripTags(decoded);
}

function link(item: string): string | null {
  const rss = tag(item, "link");
  if (rss && rss.trim()) return text(rss);
  const atom = /<link\b[^>]*?(?:rel=["']alternate["'][^>]*?)?href=["']([^"']+)["']/i.exec(item);
  return atom ? decodeEntities(atom[1]!) : null;
}
