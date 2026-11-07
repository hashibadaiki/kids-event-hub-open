import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { createMemoryRepository, type EventRecord } from "../src/repository";
import { MCP_TOOLS, PROTOCOL_VERSION } from "../src/mcp/tools";

const ev = (over: Partial<EventRecord> & { id: number }): EventRecord => ({
  title: "おはなし会",
  summary: "絵本の読み聞かせ",
  startAt: "2026-11-07T10:00",
  endAt: "2026-11-07T11:00",
  allDay: false,
  prefecture: "香川県",
  city: "高松市",
  venue: "中央図書館",
  ageMin: 3,
  ageMax: 6,
  withParent: true,
  ageText: "3〜6歳（保護者同伴）",
  priceFree: true,
  priceText: "無料",
  categories: ["storytelling"],
  sourceUrl: `https://example.jp/event/${over.id}`,
  ...over,
});

// 2026-11-03(火) 時点。今週末 = 11/7(土)〜11/8(日)
const EVENTS: EventRecord[] = [
  ev({ id: 1 }),
  ev({ id: 2, title: "親子工作教室", startAt: "2026-11-08T13:00", endAt: null, venue: "サンメッセ香川", ageMin: 6, ageMax: 12, ageText: null, withParent: null, priceFree: false, priceText: "材料費300円", categories: ["craft"], sourceUrl: "https://example.jp/flyer.pdf" }),
  ev({ id: 3, title: "秋のスタンプラリー", startAt: "2026-11-01", endAt: "2026-11-30", allDay: true, summary: null, venue: null, city: "丸亀市", ageMin: null, ageMax: null, ageText: null, withParent: null, priceFree: null, priceText: null, categories: [] }),
  ev({ id: 4, title: "阿波の子ども祭り", prefecture: "徳島県", startAt: "2026-11-08" }),
  ev({ id: 5, title: "来週のおはなし会", startAt: "2026-11-14T10:00", endAt: null }),
];

const now = () => new Date("2026-11-02T20:00:00Z"); // JST 2026-11-03 05:00
const app = createApp({ repository: () => createMemoryRepository(EVENTS), now });
const ORIGIN = "https://kids-event-hub.example";

let seq = 0;
async function rpc(method: string, params?: unknown, opts: { notification?: boolean } = {}) {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (params !== undefined) body.params = params;
  if (!opts.notification) body.id = ++seq;
  return app.request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
}

async function call(name: string, args: unknown) {
  const res = await rpc("tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  const json = (await res.json()) as {
    result: { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Record<string, unknown> };
  };
  return json.result;
}

type SearchResult = {
  query: Record<string, unknown>;
  today: string;
  count: number;
  truncated: boolean;
  events: Record<string, unknown>[];
};

describe("MCP: プロトコル（Streamable HTTP、JSON 応答のみ・ステートレス）", () => {
  it("initialize: サーバー情報と tools capability を返す", async () => {
    const res = await rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    const json = (await res.json()) as { jsonrpc: string; id: number; result: Record<string, unknown> };
    expect(json.jsonrpc).toBe("2.0");
    expect(json.id).toBe(seq);
    expect(json.result).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "kids-event-hub" },
    });
    // 今日の日付（JST）を伝える。「今週末」をクライアント側で日付にできるように
    expect(json.result.instructions).toContain("2026-11-03");
  });

  it("initialize: 知らないプロトコル版なら自分の版を返す。対応している古い版はそのまま返す", async () => {
    const r1 = (await (await rpc("initialize", { protocolVersion: "1999-01-01", capabilities: {} })).json()) as {
      result: { protocolVersion: string };
    };
    expect(r1.result.protocolVersion).toBe(PROTOCOL_VERSION);
    const r2 = (await (await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {} })).json()) as {
      result: { protocolVersion: string };
    };
    expect(r2.result.protocolVersion).toBe("2025-03-26");
  });

  it("通知（id なし）は 202 で本文なし", async () => {
    const res = await rpc("notifications/initialized", undefined, { notification: true });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("ping は空の result", async () => {
    expect(await (await rpc("ping")).json()).toEqual({ jsonrpc: "2.0", id: seq, result: {} });
  });

  it("知らないメソッドは -32601", async () => {
    const json = (await (await rpc("resources/list")).json()) as { error: { code: number } };
    expect(json.error.code).toBe(-32601);
  });

  it("壊れた JSON は -32700、JSON-RPC でないものは -32600", async () => {
    const bad = await app.request(`${ORIGIN}/mcp`, { method: "POST", body: "{", headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: number } }).error.code).toBe(-32700);
    const notRpc = await app.request(`${ORIGIN}/mcp`, { method: "POST", body: JSON.stringify([1, 2]), headers: { "content-type": "application/json" } });
    expect(notRpc.status).toBe(400);
    expect(((await notRpc.json()) as { error: { code: number } }).error.code).toBe(-32600);
  });

  it("GET（SSE ストリーム）は提供しないので 405", async () => {
    const res = await app.request(`${ORIGIN}/mcp`, { method: "GET", headers: { accept: "text/event-stream" } });
    expect(res.status).toBe(405);
  });
});

describe("MCP: ツール定義", () => {
  it("検索 2 つと運用の集計 1 つだけを出す（書き込み系はない）", async () => {
    const json = (await (await rpc("tools/list")).json()) as { result: { tools: { name: string }[] } };
    expect(json.result.tools.map((t) => t.name)).toEqual(["search_events", "get_event", "get_dashboard", "get_health"]);
    expect(json.result.tools).toEqual(MCP_TOOLS);
  });

  it("どのツールも読み取り専用の注釈を持つ", () => {
    for (const t of MCP_TOOLS) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    }
  });

  // ツール定義（クライアントに見える契約）が意図せず変わらないように固定する
  it("search_events の入力スキーマ", () => {
    const t = MCP_TOOLS.find((t) => t.name === "search_events")!;
    expect(t.inputSchema).toEqual({
      type: "object",
      properties: {
        prefecture: { type: "string", description: expect.any(String) },
        from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: expect.any(String) },
        to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: expect.any(String) },
        age: { type: "integer", minimum: 0, maximum: 18, description: expect.any(String) },
        keyword: { type: "string", maxLength: 100, description: expect.any(String) },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20, description: expect.any(String) },
      },
      required: ["prefecture"],
      additionalProperties: false,
    });
    expect(t.outputSchema).toMatchObject({
      type: "object",
      required: ["query", "today", "count", "truncated", "events"],
    });
  });

  it("get_event の入力スキーマ", () => {
    const t = MCP_TOOLS.find((t) => t.name === "get_event")!;
    expect(t.inputSchema).toEqual({
      type: "object",
      properties: { id: { type: "integer", minimum: 1, description: expect.any(String) } },
      required: ["id"],
      additionalProperties: false,
    });
    expect(t.outputSchema).toMatchObject({ type: "object", required: expect.arrayContaining(["id", "title", "start_at", "url", "source_url"]) });
  });
});

describe("MCP: search_events", () => {
  it("デモ: 「今週末の香川の子供向けイベント」= 香川県・11/7〜11/8", async () => {
    const r = await call("search_events", { prefecture: "香川", from: "2026-11-07", to: "2026-11-08" });
    expect(r.isError).toBeFalsy();
    const out = r.structuredContent as SearchResult;
    expect(out.query).toEqual({ prefecture: "香川県", from: "2026-11-07", to: "2026-11-08" });
    expect(out.today).toBe("2026-11-03");
    expect(out.count).toBe(3);
    expect(out.truncated).toBe(false);
    expect(out.events.map((e) => e.id)).toEqual([3, 1, 2]);
    expect(out.events[1]).toEqual({
      id: 1,
      title: "おはなし会",
      summary: "絵本の読み聞かせ",
      start_at: "2026-11-07T10:00",
      end_at: "2026-11-07T11:00",
      when: "11月7日(土) 10:00〜11:00",
      prefecture: "香川県",
      city: "高松市",
      venue: "中央図書館",
      age: "3〜6歳（保護者同伴）",
      price: "無料",
      categories: ["storytelling"],
      url: `${ORIGIN}/events/1`,
      source_url: "https://example.jp/event/1",
      from_pdf: false,
    });
    expect(out.events[2]).toMatchObject({ id: 2, age: "6〜12歳", price: "材料費300円", from_pdf: true });
    expect(out.events[0]).toMatchObject({ id: 3, age: null, price: null, venue: null, summary: null });
    // 互換のため text にも同じ JSON を入れる
    expect(r.content).toHaveLength(1);
    expect(r.content[0].type).toBe("text");
    expect(JSON.parse(r.content[0].text)).toEqual(out);
  });

  it("都道府県は正式名・略称・ローマ字のどれでもよい", async () => {
    for (const prefecture of ["香川県", "香川", "kagawa", "Kagawa"]) {
      const out = (await call("search_events", { prefecture, from: "2026-11-08", to: "2026-11-08" })).structuredContent as SearchResult;
      expect(out.query.prefecture).toBe("香川県");
    }
    const out = (await call("search_events", { prefecture: "東京", from: "2026-11-08", to: "2026-11-08" })).structuredContent as SearchResult;
    expect(out.query.prefecture).toBe("東京都");
  });

  it("日付の省略時は今日から 30 日間", async () => {
    const out = (await call("search_events", { prefecture: "香川県" })).structuredContent as SearchResult;
    expect(out.query).toMatchObject({ from: "2026-11-03", to: "2026-12-03" });
    expect(out.events.map((e) => e.id)).toEqual([3, 1, 2, 5]);
  });

  it("対象年齢とキーワードで絞り込む", async () => {
    const byAge = (await call("search_events", { prefecture: "香川県", from: "2026-11-07", to: "2026-11-08", age: 10 })).structuredContent as SearchResult;
    expect(byAge.query.age).toBe(10);
    expect(byAge.events.map((e) => e.id)).toEqual([3, 2]);
    const byKeyword = (await call("search_events", { prefecture: "香川県", keyword: "おはなし" })).structuredContent as SearchResult;
    expect(byKeyword.query.keyword).toBe("おはなし");
    expect(byKeyword.events.map((e) => e.id)).toEqual([1, 5]);
  });

  it("limit で件数を絞ると truncated になる", async () => {
    const out = (await call("search_events", { prefecture: "香川県", limit: 2 })).structuredContent as SearchResult;
    expect(out.events.map((e) => e.id)).toEqual([3, 1]);
    expect(out.count).toBe(2);
    expect(out.truncated).toBe(true);
  });

  it.each([
    [{}, "prefecture"],
    [{ prefecture: "アトランティス" }, "prefecture"],
    [{ prefecture: "香川県", from: "2026-02-30" }, "from"],
    [{ prefecture: "香川県", to: "11/8" }, "to"],
    [{ prefecture: "香川県", from: "2026-11-10", to: "2026-11-01" }, "from"],
    [{ prefecture: "香川県", from: "2026-11-01", to: "2027-03-01" }, "92"],
    [{ prefecture: "香川県", age: 19 }, "age"],
    [{ prefecture: "香川県", age: 3.5 }, "age"],
    [{ prefecture: "香川県", age: "5" }, "age"],
    [{ prefecture: "香川県", keyword: "あ".repeat(101) }, "keyword"],
    [{ prefecture: "香川県", limit: 0 }, "limit"],
    [{ prefecture: "香川県", limit: 51 }, "limit"],
    [{ prefecture: "香川県", city: "高松市" }, "city"],
  ])("不正な入力 %j はツールのエラー（isError）で理由を返す", async (args, mention) => {
    const r = await call("search_events", args);
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect(r.content[0].text).toContain(mention);
  });
});

describe("MCP: get_event", () => {
  it("イベントの全項目を返す", async () => {
    const r = await call("get_event", { id: 2 });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({
      id: 2,
      title: "親子工作教室",
      summary: "絵本の読み聞かせ",
      start_at: "2026-11-08T13:00",
      end_at: null,
      all_day: false,
      when: "11月8日(日) 13:00",
      prefecture: "香川県",
      city: "高松市",
      venue: "サンメッセ香川",
      age: "6〜12歳",
      age_min: 6,
      age_max: 12,
      with_parent: null,
      price: "材料費300円",
      price_free: false,
      categories: ["craft"],
      url: `${ORIGIN}/events/2`,
      source_url: "https://example.jp/flyer.pdf",
      from_pdf: true,
    });
    expect(JSON.parse(r.content[0].text)).toEqual(r.structuredContent);
  });

  it("ない id はエラー", async () => {
    const r = await call("get_event", { id: 999 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("999");
  });

  it.each([[{}], [{ id: "2" }], [{ id: 0 }], [{ id: 1.5 }], [{ id: 1, extra: true }]])("不正な入力 %j はエラー", async (args) => {
    expect((await call("get_event", args)).isError).toBe(true);
  });
});

describe("MCP: ツール呼び出しの誤り", () => {
  it("知らないツールは -32602", async () => {
    const json = (await (await rpc("tools/call", { name: "add_event", arguments: {} })).json()) as { error: { code: number; message: string } };
    expect(json.error.code).toBe(-32602);
    expect(json.error.message).toContain("add_event");
  });

  it("arguments が省略されても空のオブジェクトとして扱う", async () => {
    const r = await call("search_events", undefined);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("prefecture");
  });
});
