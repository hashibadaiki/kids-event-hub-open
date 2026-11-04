import { absoluteUrl, decodeEntities } from "../extract/text";

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
}

/** 一覧ページの「次のページ」（rel="next" の a / link）の絶対 URL。なければ null */
export function findNextPageLink(html: string, pageUrl: string): string | null {
  for (const m of html.matchAll(/<(?:a|link)\b[^>]*>/gi)) {
    const rel = attr(m[0], "rel");
    if (!rel || !rel.toLowerCase().split(/\s+/).includes("next")) continue;
    const href = absoluteUrl(decodeEntities(attr(m[0], "href")?.trim() ?? ""), pageUrl);
    if (href) return href;
  }
  return null;
}
