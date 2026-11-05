import { describe, it, expect, vi } from "vitest";
import { createClaudeClient, type ClaudeClient } from "../src/claude";
import { extractHtml, fetchedDateText, htmlToText } from "../src/extract/html";
import html from "./fixtures/page.html?raw";

describe("createClaudeClient", () => {
  const schema = {
    type: "object",
    properties: {
      events: { type: "array", items: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
    },
    required: ["events"],
  };
  const tool = { name: "record", description: "イベントを記録する", inputSchema: schema };
  const textReply = (text: string, extra: Record<string, unknown> = {}) =>
    Response.json({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text }], ...extra });

  it("ツールを強制せず、構造化出力（JSON Schema）で受け取った JSON を返す", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => textReply('{"events":[{"title":"工作"}]}'));
    const client = createClaudeClient({ apiKey: "test-key", model: "test-model", fetch: fetchMock });
    const out = await client.callTool({ system: "sys", prompt: "hello", tool });
    expect(out).toEqual({ events: [{ title: "工作" }] });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = new Headers(init!.headers);
    expect(headers.get("x-api-key")).toBe("test-key");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    const body = JSON.parse(init!.body as string);
    expect(body.tool_choice).toBeUndefined();
    expect(body.tools).toBeUndefined();
    expect(body).toMatchObject({ model: "test-model", messages: [{ role: "user", content: "hello" }] });
    expect(body.system).toContain("sys");
    expect(body.system).toContain("イベントを記録する");
    expect(body.output_config.format).toEqual({
      type: "json_schema",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          events: {
            type: "array",
            items: { type: "object", additionalProperties: false, properties: { title: { type: "string" } }, required: ["title"] },
          },
        },
        required: ["events"],
      },
    });
  });

  it("PDF は document ブロック（base64）として本文より前に渡す", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => textReply('{"events":[]}'));
    const client = createClaudeClient({ apiKey: "k", model: "m", fetch: fetchMock });
    await client.callTool({ system: "sys", prompt: "読んで", tool, document: { mediaType: "application/pdf", base64: "JVBERi0=" } });
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } },
          { type: "text", text: "読んで" },
        ],
      },
    ]);
  });

  it("エラー応答は例外にする（キーはメッセージに含めない）", async () => {
    const client = createClaudeClient({
      apiKey: "secret-key",
      model: "m",
      fetch: async () => new Response('{"error":{"message":"bad"}}', { status: 400 }),
    });
    const p = client.callTool({ system: "", prompt: "", tool });
    await expect(p).rejects.toThrow(/400/);
    await expect(p).rejects.not.toThrow(/secret-key/);
  });

  it("拒否・出力の打ち切り・JSON として読めない応答は例外", async () => {
    const call = (res: Response) => createClaudeClient({ apiKey: "k", model: "m", fetch: async () => res.clone() }).callTool({ system: "", prompt: "", tool });
    await expect(call(textReply("", { stop_reason: "refusal" }))).rejects.toThrow(/拒否/);
    await expect(call(textReply('{"events":[', { stop_reason: "max_tokens" }))).rejects.toThrow(/max_tokens/);
    await expect(call(textReply("not json"))).rejects.toThrow(/JSON/);
    await expect(call(Response.json({ stop_reason: "end_turn", content: [] }))).rejects.toThrow(/JSON/);
  });
});

describe("htmlToText", () => {
  it("script / style / コメントを除き、タグを落として空白を詰める", () => {
    const text = htmlToText(html);
    expect(text).toContain("11月のイベント");
    expect(text).toContain("親子リトミック 11月10日（火） 10:30～11:15");
    expect(text).not.toContain("tracking");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("comment");
  });
});

describe("extractHtml", () => {
  it("本文テキストを Claude に渡し、返ってきたイベントを候補にする", async () => {
    const callTool = vi.fn(async () => ({
      events: [
        {
          title: "親子リトミック",
          date_text: "11月10日（火） 10:30～11:15",
          venue: "多目的室",
          age_text: "1～3歳と保護者",
          price_text: "無料",
          summary: "音楽に合わせて親子で体を動かします",
          url: "/ev/1",
        },
        { title: "", date_text: "11月1日" },
      ],
    }));
    const claude: ClaudeClient = { callTool };
    const events = await extractHtml(html, "https://example.jp/events/", claude);
    expect(events).toEqual([
      {
        title: "親子リトミック",
        dateText: "11月10日（火） 10:30～11:15",
        venue: "多目的室",
        city: null,
        ageText: "1～3歳と保護者",
        priceText: "無料",
        summary: "音楽に合わせて親子で体を動かします",
        url: "https://example.jp/ev/1",
      },
    ]);
    const args = (callTool.mock.calls[0] as unknown as [{ prompt: string; tool: { name: string } }])[0];
    expect(args.prompt).toContain("工作教室「どんぐりごま」");
    expect(args.prompt).not.toContain("<li>");
    expect(args.tool.name).toBe("record_events");
  });

  it("extra_dates の分だけ候補を増やし（1 日 1 件）、city を入れる", async () => {
    const callTool = vi.fn(async () => ({
      events: [
        {
          title: "こどもプログラミング相談室",
          date_text: "令和8年12月6日 第1日曜日 9時00分～11時00分",
          extra_dates: ["令和8年12月20日 第3日曜日 9時00分～11時00分", ""],
          venue: "大橋記念図書館 2階 展示室",
          city: "坂出市",
        },
      ],
    }));
    const events = await extractHtml(html, "https://example.jp/events/", { callTool });
    expect(events.map((e) => e.dateText)).toEqual(["令和8年12月6日 第1日曜日 9時00分～11時00分", "令和8年12月20日 第3日曜日 9時00分～11時00分"]);
    expect(events.map((e) => [e.title, e.venue, e.city])).toEqual(
      Array.from({ length: 2 }, () => ["こどもプログラミング相談室", "大橋記念図書館 2階 展示室", "坂出市"]),
    );
  });

  it("取得日（JST）をプロンプトに入れ、省略された月・年を見出し・取得日・曜日から補うよう指示する", async () => {
    const callTool = vi.fn(async () => ({ events: [] }));
    await extractHtml(html, "https://example.jp/events/", { callTool }, {}, new Date("2026-11-04T18:30:00Z"));
    const first = (callTool.mock.calls[0] as unknown as [{ system: string; prompt: string }])[0];
    expect(first.prompt).toContain("取得日: 2026年11月5日（木）");
    expect(first.system).toContain("取得日");
    expect(first.system).toContain("曜日");
    expect(first.system).toContain("extra_dates");

    await extractHtml(html, "https://example.jp/events/", { callTool });
    const second = (callTool.mock.calls[1] as unknown as [{ prompt: string }])[0];
    expect(second.prompt).toMatch(/取得日: \d{4}年\d{1,2}月\d{1,2}日（[日月火水木金土]）/);
  });
});

describe("fetchedDateText", () => {
  it("JST の年月日と曜日にする（UTC の日付境界をまたぐ）", () => {
    expect(fetchedDateText(new Date("2026-11-04T15:00:00Z"))).toBe("2026年11月5日（木）");
    expect(fetchedDateText(new Date("2026-11-04T14:59:59Z"))).toBe("2026年11月4日（水）");
  });
});
