import { absoluteUrl, decodeEntities, stripTags } from "../extract/text";

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
}

const NEXT_LABELS = new Set(["次へ", "次のページ", "次のページへ", "next"]);

const linkHref = (tag: string, pageUrl: string) => {
  const href = decodeEntities(attr(tag, "href")?.trim() ?? "");
  if (href.startsWith("#") || /^javascript:/i.test(href)) return null;
  return absoluteUrl(href, pageUrl);
};

const normalizeLabel = (inner: string) =>
  stripTags(inner)
    .replace(/&(raquo|rsaquo|gt);/gi, "")
    .replace(/[\s>＞»›≫→▶▸]/g, "")
    .toLowerCase();

/** 一覧ページの「次のページ」の絶対 URL。rel="next" の a / link を優先し、なければ「次へ」などの文言のリンク。なければ null */
export function findNextPageLink(html: string, pageUrl: string): string | null {
  for (const m of html.matchAll(/<(?:a|link)\b[^>]*>/gi)) {
    const rel = attr(m[0], "rel");
    if (!rel || !rel.toLowerCase().split(/\s+/).includes("next")) continue;
    const href = linkHref(m[0], pageUrl);
    if (href) return href;
  }
  for (const m of html.matchAll(/(<a\b[^>]*>)([\s\S]*?)<\/a>/gi)) {
    if (!NEXT_LABELS.has(normalizeLabel(m[2]!))) continue;
    const href = linkHref(m[1]!, pageUrl);
    if (href) return href;
  }
  return null;
}
