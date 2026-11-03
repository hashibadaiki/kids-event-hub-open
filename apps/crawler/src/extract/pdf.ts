import type { ClaudeClient } from "../claude";
import { absoluteUrl } from "./text";
import type { RawEvent } from "./types";

export const MAX_PDF_LINKS = 10;

const SYSTEM = [
  "あなたは自治体・公共施設の PDF（チラシ・広報誌・月間カレンダー）から、子供向けイベントの情報を抜き出す担当です。",
  "PDF に書かれている事実だけを使い、推測で補わないでください。書かれていない項目は省略します。",
  "1 枚に複数のイベントが載っていれば、すべて別々に記録します。イベントではないお知らせ（休館日など）は含めません。",
  "dates には開催日を 1 日ずつ「2026年11月15日」の形で入れます。年や月が見出しにしか書かれていなければ見出しから補います。",
  "月間カレンダー形式では、カレンダーのマス目と凡例・説明を突き合わせて、イベントが行われる日をすべて列挙します。",
  "summary は本文を転載せず、100 文字以内の自分の言葉で要約してください。",
].join("\n");

const TOOL = {
  name: "record_events",
  description: "PDF から見つけたイベントを記録する",
  inputSchema: {
    type: "object",
    properties: {
      events: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "イベント名" },
            dates: { type: "array", items: { type: "string" }, description: "開催日（1 日ずつ。例: 2026年11月15日（日））" },
            time_text: { type: "string", description: "開催時間の記述（表記のまま。例: 10:00〜12:00）" },
            venue: { type: "string", description: "会場" },
            city: { type: "string", description: "市町村" },
            age_text: { type: "string", description: "対象年齢・学年の記述（表記のまま）" },
            price_text: { type: "string", description: "参加費・料金の記述（表記のまま）" },
            apply_text: { type: "string", description: "申込方法・申込期間の記述（表記のまま。不要ならその旨）" },
            summary: { type: "string", description: "100 文字以内の要約（転載しない）" },
          },
          required: ["title", "dates"],
        },
      },
    },
    required: ["events"],
  },
};

type Item = Partial<Record<"title" | "dates" | "time_text" | "venue" | "city" | "age_text" | "price_text" | "apply_text" | "summary", unknown>>;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export async function extractPdf(bytes: Uint8Array, pdfUrl: string, claude: ClaudeClient): Promise<RawEvent[]> {
  const out = (await claude.callTool({
    system: SYSTEM,
    prompt: `PDF の URL: ${pdfUrl}\nこの PDF に載っている子供向けイベントをすべて記録してください。`,
    tool: TOOL,
    document: { mediaType: "application/pdf", base64: toBase64(bytes) },
  })) as { events?: unknown };

  const events: RawEvent[] = [];
  for (const item of Array.isArray(out?.events) ? (out.events as unknown[]) : []) {
    if (typeof item !== "object" || item === null) continue;
    const it = item as Item;
    const title = str(it.title);
    if (!title) continue;
    const time = str(it.time_text);
    const base: RawEvent = {
      title,
      venue: str(it.venue),
      city: str(it.city),
      ageText: str(it.age_text),
      priceText: str(it.price_text),
      applyText: str(it.apply_text),
      summary: str(it.summary),
      url: pdfUrl,
    };
    const dates = (Array.isArray(it.dates) ? it.dates : []).map(str).filter((d): d is string => d !== null);
    if (dates.length === 0) {
      events.push({ ...base, dateText: null });
      continue;
    }
    for (const d of dates) events.push({ ...base, dateText: time ? `${d} ${time}` : d });
  }
  return events;
}

export function findPdfLinks(html: string, pageUrl: string): string[] {
  const host = new URL(pageUrl).host;
  const links: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const abs = absoluteUrl((m[1] ?? m[2] ?? m[3] ?? "").trim(), pageUrl);
    if (!abs) continue;
    const u = new URL(abs);
    u.hash = "";
    if (u.host !== host || !u.pathname.toLowerCase().endsWith(".pdf")) continue;
    if (!links.includes(u.href)) links.push(u.href);
    if (links.length >= MAX_PDF_LINKS) break;
  }
  return links;
}
