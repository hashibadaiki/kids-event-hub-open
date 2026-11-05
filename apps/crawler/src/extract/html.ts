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
  "開催日の月や年が省略されていれば、ページの見出し（「11月のイベントカレンダー」など）と取得日から補います。曜日が書かれていれば、それと合う月を選びます。前後の月へのリンク（「12月 >」など）の月と取り違えないでください。",
  "同じイベントが複数の日に開催されるときは、1 回目を date_text に、2 回目以降を extra_dates に 1 日ずつ入れます。連続した期間（展示など）は date_text に「11月10日～11月26日」のように範囲で書きます。",
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
            extra_dates: { type: "array", items: { type: "string" }, description: "同じイベントの 2 回目以降の開催日時（表記のまま。1 要素に 1 回分）" },
            venue: { type: "string", description: "会場" },
            city: { type: "string", description: "市町村（ページに書かれていれば）" },
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

type Item = Partial<Record<"title" | "date_text" | "extra_dates" | "venue" | "city" | "age_text" | "price_text" | "summary" | "url", unknown>>;
const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

const WEEKDAYS = "日月火水木金土";
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** プロンプトに入れる取得日（JST）。例: 2026年11月5日（木） */
export function fetchedDateText(date: Date): string {
  const j = new Date(date.getTime() + JST_OFFSET_MS);
  return `${j.getUTCFullYear()}年${j.getUTCMonth() + 1}月${j.getUTCDate()}日（${WEEKDAYS[j.getUTCDay()]}）`;
}

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

/**
 * HTML の本文テキストを Claude に渡して構造化する（LLM 抽出）。config は収集元ごとの抽出設定。
 * referenceDate は取得日（月・年が省略された日付を補う基準）。複数の開催日は日付ごとに 1 件にする
 */
export async function extractHtml(
  html: string,
  pageUrl: string,
  claude: ClaudeClient,
  config: ExtractionConfig = {},
  referenceDate: Date = new Date(),
): Promise<RawEvent[]> {
  const selected = config.selectors?.length ? await selectText(html, config.selectors) : null;
  const text = (selected ?? htmlToText(html)).slice(0, MAX_PROMPT_CHARS);
  const prompt = `ページの URL: ${pageUrl}\n取得日: ${fetchedDateText(referenceDate)}\n\n--- ページ本文（テキスト）---\n${text}`;
  const out = (await claude.callTool({ system: systemPrompt(config), prompt, tool: TOOL })) as { events?: Item[] };
  const events: RawEvent[] = [];
  for (const item of Array.isArray(out?.events) ? out.events : []) {
    const title = s(item.title);
    if (!title) continue;
    const base: RawEvent = {
      title,
      venue: s(item.venue),
      city: s(item.city),
      ageText: s(item.age_text),
      priceText: s(item.price_text),
      summary: s(item.summary),
      url: absoluteUrl(s(item.url), pageUrl),
    };
    const extra = Array.isArray(item.extra_dates) ? item.extra_dates.map(s) : [];
    const dates = [s(item.date_text), ...extra].filter((d): d is string => d !== null);
    if (dates.length === 0) {
      events.push({ ...base, dateText: null });
      continue;
    }
    for (const d of dates) events.push({ ...base, dateText: d });
  }
  return events;
}
