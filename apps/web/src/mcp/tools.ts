import type { EventRecord, EventRepository } from "../repository";
import { parseSearch, todayJst, type SearchQuery } from "../search";
import { PREFECTURES, type Prefecture } from "../prefectures";
import { formatAge, formatPrice, formatWhen, isPdfUrl } from "../format";

/**
 * MCP のツール定義と実装。検索のみ（書き込み系のツールは出さない。#10 の決定事項）
 * ここにある定義がクライアント（Claude など）から見える契約なので、変えるときはテストも合わせて変える
 */

export const PROTOCOL_VERSION = "2025-06-18";
export const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION, "2025-03-26"];
export const SERVER_INFO = { name: "kids-event-hub", title: "子供向けイベント検索", version: "0.1.0" };

export const DEFAULT_TOOL_LIMIT = 20;
export const MAX_TOOL_LIMIT = 50;
export const MAX_KEYWORD_LENGTH = 100;

type JsonSchema = Record<string, unknown>;

export type McpTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  annotations: { readOnlyHint: true; destructiveHint: false; idempotentHint: true; openWorldHint: false };
};

const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const nullable = (type: string) => ({ type: [type, "null"] });

const eventSummaryProperties = {
  id: { type: "integer" },
  title: { type: "string" },
  summary: nullable("string"),
  start_at: { type: "string", description: "開始日時（JST）。`YYYY-MM-DD` または `YYYY-MM-DDTHH:mm`" },
  end_at: nullable("string"),
  when: { type: "string", description: "表示用の日時。例: 11月8日(日) 10:00〜11:00" },
  prefecture: { type: "string" },
  city: nullable("string"),
  venue: nullable("string"),
  age: { ...nullable("string"), description: "対象年齢の表記。不明なら null" },
  price: { ...nullable("string"), description: "料金の表記。不明なら null" },
  categories: { type: "array", items: { type: "string" } },
  url: { type: "string", description: "このサービスのイベント詳細ページ" },
  source_url: { type: "string", description: "掲載元のページまたは PDF チラシ" },
  from_pdf: { type: "boolean", description: "掲載元が PDF チラシか" },
};

const eventDetailProperties = {
  ...eventSummaryProperties,
  all_day: { type: "boolean" },
  age_min: nullable("integer"),
  age_max: nullable("integer"),
  with_parent: { ...nullable("boolean"), description: "保護者同伴が必要か。不明なら null" },
  price_free: { ...nullable("boolean"), description: "無料か。不明なら null" },
};

export const MCP_TOOLS: McpTool[] = [
  {
    name: "search_events",
    title: "子供向けイベントを探す",
    description:
      "都道府県と日付範囲（JST）で子供向けイベントを探す。自治体・公共施設のイベントページや PDF チラシから集めたもの。" +
      "期間中に開催しているイベントを開始日時の早い順に返す。「今週末」などは今日の日付（結果の today）から from / to に直して渡す。" +
      "詳しい内容は get_event で取る。回答では掲載元（source_url）を案内すること。",
    inputSchema: {
      type: "object",
      properties: {
        prefecture: { type: "string", description: "都道府県。「香川県」「香川」「kagawa」のどれでもよい" },
        from: { type: "string", pattern: DATE_PATTERN, description: "期間の開始日（JST、YYYY-MM-DD）。省略時は今日" },
        to: {
          type: "string",
          pattern: DATE_PATTERN,
          description: "期間の終了日（JST、YYYY-MM-DD、この日を含む）。省略時は from の 30 日後。期間は最大 92 日",
        },
        age: {
          type: "integer",
          minimum: 0,
          maximum: 18,
          description: "子供の年齢。対象年齢に入るイベントと、年齢の記載がないイベントを返す",
        },
        keyword: {
          type: "string",
          maxLength: MAX_KEYWORD_LENGTH,
          description: "タイトル・概要・会場・市町村の部分一致。空白区切りで AND。例: 「工作」「高松 図書館」",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_TOOL_LIMIT,
          default: DEFAULT_TOOL_LIMIT,
          description: "返す件数の上限",
        },
      },
      required: ["prefecture"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        query: {
          type: "object",
          description: "実際に使った検索条件",
          properties: {
            prefecture: { type: "string" },
            from: { type: "string" },
            to: { type: "string" },
            age: { type: "integer" },
            keyword: { type: "string" },
          },
          required: ["prefecture", "from", "to"],
        },
        today: { type: "string", description: "今日の日付（JST）" },
        count: { type: "integer", description: "events の件数" },
        truncated: { type: "boolean", description: "limit で打ち切った可能性があるか" },
        events: {
          type: "array",
          items: { type: "object", properties: eventSummaryProperties, required: Object.keys(eventSummaryProperties) },
        },
      },
      required: ["query", "today", "count", "truncated", "events"],
    },
    annotations: READ_ONLY,
  },
  {
    name: "get_event",
    title: "イベントの詳細",
    description: "search_events で見つけたイベントの id から、日時・会場・対象年齢・料金・掲載元などの詳細を返す。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer", minimum: 1, description: "search_events の結果の id" } },
      required: ["id"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: eventDetailProperties,
      required: Object.keys(eventDetailProperties),
    },
    annotations: READ_ONLY,
  },
];

export type ToolContext = {
  repository: EventRepository;
  now: Date;
  /** 詳細ページの URL を作るためのオリジン（例: https://kids-event-hub.example） */
  origin: string;
};

export type ToolResult =
  | { isError?: false; structuredContent: Record<string, unknown>; content: { type: "text"; text: string }[] }
  | { isError: true; content: { type: "text"; text: string }[] };

class ToolInputError extends Error {}

const ok = (data: Record<string, unknown>): ToolResult => ({
  structuredContent: data,
  content: [{ type: "text", text: JSON.stringify(data) }],
});
const fail = (message: string): ToolResult => ({ isError: true, content: [{ type: "text", text: message }] });

/** 正式名・県/府/都を除いた名前・ローマ字（大文字小文字は区別しない） */
export function resolvePrefecture(input: string): Prefecture | undefined {
  const s = input.trim();
  const lower = s.toLowerCase();
  return PREFECTURES.find(
    (p) => p.name === s || p.slug === lower || (p.name !== "北海道" && p.name.slice(0, -1) === s),
  );
}

function checkArgs(args: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new ToolInputError(`${key}: 使えない引数です（使えるのは ${allowed.join(", ")}）`);
  }
}

function optionalInteger(args: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new ToolInputError(`${key}: ${min}〜${max} の整数で指定してください`);
  }
  return v;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new ToolInputError(`${key}: 文字列で指定してください`);
  return v;
}

const PARSE_ERRORS: Record<string, string> = {
  "invalid-date": "from / to: 実在する日付を YYYY-MM-DD で指定してください",
  "invalid-range": "from: to より後の日付になっています",
  "range-too-long": "from / to: 期間は最大 92 日です",
};

function toSummary(e: EventRecord, origin: string) {
  return {
    id: e.id,
    title: e.title,
    summary: e.summary,
    start_at: e.startAt,
    end_at: e.endAt,
    when: formatWhen(e),
    prefecture: e.prefecture,
    city: e.city,
    venue: e.venue,
    age: formatAge(e),
    price: formatPrice(e),
    categories: e.categories,
    url: `${origin}/events/${e.id}`,
    source_url: e.sourceUrl,
    from_pdf: isPdfUrl(e.sourceUrl),
  };
}

function toDetail(e: EventRecord, origin: string) {
  return {
    ...toSummary(e, origin),
    all_day: e.allDay,
    age_min: e.ageMin,
    age_max: e.ageMax,
    with_parent: e.withParent,
    price_free: e.priceFree,
  };
}

async function searchEvents(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  checkArgs(args, ["prefecture", "from", "to", "age", "keyword", "limit"]);
  const prefInput = optionalString(args, "prefecture");
  if (prefInput === undefined) throw new ToolInputError("prefecture: 都道府県を指定してください（例: 香川県）");
  const pref = resolvePrefecture(prefInput);
  if (!pref) throw new ToolInputError(`prefecture: 「${prefInput}」は都道府県として認識できません（例: 香川県 / kagawa）`);
  const from = optionalString(args, "from");
  const to = optionalString(args, "to");
  if (from !== undefined && !new RegExp(DATE_PATTERN).test(from)) throw new ToolInputError("from: YYYY-MM-DD で指定してください");
  if (to !== undefined && !new RegExp(DATE_PATTERN).test(to)) throw new ToolInputError("to: YYYY-MM-DD で指定してください");
  const age = optionalInteger(args, "age", 0, 18);
  const limit = optionalInteger(args, "limit", 1, MAX_TOOL_LIMIT) ?? DEFAULT_TOOL_LIMIT;
  const keyword = optionalString(args, "keyword")?.trim();
  if (keyword !== undefined && keyword.length > MAX_KEYWORD_LENGTH) {
    throw new ToolInputError(`keyword: ${MAX_KEYWORD_LENGTH} 文字以内で指定してください`);
  }

  // 日付・年齢の解釈は検索サイトと同じ parseSearch を使う
  const params = new URLSearchParams();
  if (from !== undefined) params.set("from", from);
  if (to !== undefined) params.set("to", to);
  if (age !== undefined) params.set("age", String(age));
  const parsed = parseSearch({ prefecture: pref.slug, params, now: ctx.now });
  if (!parsed.ok) throw new ToolInputError(PARSE_ERRORS[parsed.reason] ?? parsed.reason);

  const query: SearchQuery = { ...parsed.query };
  if (keyword) query.keyword = keyword;
  // 1 件多く取って、打ち切ったかを判定する
  const rows = await ctx.repository.search(query, limit + 1);
  const events = rows.slice(0, limit).map((e) => toSummary(e, ctx.origin));

  const echo: Record<string, unknown> = { prefecture: query.prefecture, from: query.from, to: query.to };
  if (query.age !== undefined) echo.age = query.age;
  if (query.keyword !== undefined) echo.keyword = query.keyword;
  return ok({ query: echo, today: todayJst(ctx.now), count: events.length, truncated: rows.length > limit, events });
}

async function getEvent(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  checkArgs(args, ["id"]);
  const id = optionalInteger(args, "id", 1, Number.MAX_SAFE_INTEGER);
  if (id === undefined) throw new ToolInputError("id: イベントの id を指定してください");
  const event = await ctx.repository.findById(id);
  if (!event) return fail(`id ${id} のイベントは見つかりません`);
  return ok(toDetail(event, ctx.origin));
}

const HANDLERS: Record<string, (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>> = {
  search_events: searchEvents,
  get_event: getEvent,
};

export const hasTool = (name: string) => Object.hasOwn(HANDLERS, name);

/** ツールを実行する。入力の誤りは例外ではなく isError の結果にする（モデルが読んで直せるように） */
export async function callTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`unknown tool: ${name}`);
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) return fail("arguments: オブジェクトで指定してください");
  try {
    return await handler(args as Record<string, unknown>, ctx);
  } catch (e) {
    if (e instanceof ToolInputError) return fail(e.message);
    throw e;
  }
}
