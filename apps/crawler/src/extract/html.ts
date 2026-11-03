import type { ClaudeClient } from "../claude";
import type { ExtractionConfig } from "./config";
import { absoluteUrl, stripTags } from "./text";
import type { RawEvent } from "./types";

/** Claude に渡す本文の上限（文字数）。長いページは先頭から切る */
export const MAX_PROMPT_CHARS = 30_000;

export function htmlToText(html: string): string {
  return stripTags(html.replace(/<(br|\/p|\/li|\/tr|\/h\d|\/div)\b[^>]*>/gi, "$& "));
}

const SYSTEM = [
  "あなたは自治体・公共施設のウェブページから、子供向けイベントの情報を抜き出す担当です。",
  "ページに書かれている事実だけを使い、推測で補わないでください。書かれていない項目は省略します。",
  "イベントではないお知らせ（休館日・募集終了の告知など）は含めません。",
  "summary は本文を転載せず、100 文字以内の自分の言葉で要約してください。",
].join("\n");

const TOOL = {
  name: "record_events",
  description: "ページから見つけたイベントを記録する",
  inputSchema: {
    type: "object",
    properties: {
      events: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "イベント名" },
            date_text: { type: "string", description: "開催日時の記述（ページの表記のまま。例: 11月15日（日）午後2時～4時）" },
            venue: { type: "string", description: "会場" },
            age_text: { type: "string", description: "対象年齢・学年の記述（表記のまま）" },
            price_text: { type: "string", description: "参加費・料金の記述（表記のまま）" },
            summary: { type: "string", description: "100 文字以内の要約（転載しない）" },
            url: { type: "string", description: "イベント個別ページへのリンク（あれば）" },
          },
          required: ["title", "date_text"],
        },
      },
    },
    required: ["events"],
  },
};

type Item = Partial<Record<"title" | "date_text" | "venue" | "age_text" | "price_text" | "summary" | "url", unknown>>;
const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** 抽出設定の指示・ヒントを足したシステムプロンプト */
export function systemPrompt(config: ExtractionConfig = {}): string {
  const extra: string[] = [];
  if (config.instructions) extra.push("", "このページについての指示:", config.instructions);
  if (config.hints?.length) extra.push("", "ヒント:", ...config.hints.map((h) => `- ${h}`));
  return [SYSTEM, ...extra].join("\n");
}

/** セレクタに一致した要素のテキストを集める（Workers の HTMLRewriter）。どれにも一致しない・不正なセレクタなら null */
export async function selectText(html: string, selectors: string[]): Promise<string | null> {
  const parts: string[][] = [];
  for (const selector of selectors) {
    let current: string[] | null = null;
    try {
      await new HTMLRewriter()
        .on(selector, {
          element() {
            current = [];
            parts.push(current);
          },
          text(t) {
            current?.push(t.text);
          },
        })
        .transform(new Response(html))
        .text();
    } catch {
      // 不正なセレクタは飛ばす
    }
  }
  const text = parts.map((p) => htmlToText(p.join(""))).filter(Boolean).join("\n");
  return text || null;
}

/** HTML の本文テキストを Claude に渡して構造化する（LLM 抽出）。config は収集元ごとの抽出設定 */
export async function extractHtml(
  html: string,
  pageUrl: string,
  claude: ClaudeClient,
  config: ExtractionConfig = {},
): Promise<RawEvent[]> {
  const selected = config.selectors?.length ? await selectText(html, config.selectors) : null;
  const text = (selected ?? htmlToText(html)).slice(0, MAX_PROMPT_CHARS);
  const prompt = `ページの URL: ${pageUrl}\n\n--- ページ本文（テキスト）---\n${text}`;
  const out = (await claude.callTool({ system: systemPrompt(config), prompt, tool: TOOL })) as { events?: Item[] };
  const events: RawEvent[] = [];
  for (const item of Array.isArray(out?.events) ? out.events : []) {
    const title = s(item.title);
    if (!title) continue;
    events.push({
      title,
      dateText: s(item.date_text),
      venue: s(item.venue),
      ageText: s(item.age_text),
      priceText: s(item.price_text),
      summary: s(item.summary),
      url: absoluteUrl(s(item.url), pageUrl),
    });
  }
  return events;
}
