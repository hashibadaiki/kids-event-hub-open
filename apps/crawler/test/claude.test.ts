import { describe, it, expect, vi } from "vitest";
import { createClaudeClient, type ClaudeClient } from "../src/claude";
import { extractHtml, htmlToText } from "../src/extract/html";
import html from "./fixtures/page.html?raw";

describe("createClaudeClient", () => {
  it("Messages API に tool を強制して呼び、tool_use の input を返す", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ content: [{ type: "tool_use", name: "record", input: { ok: 1 } }] }),
    );
    const client = createClaudeClient({ apiKey: "test-key", model: "test-model", fetch: fetchMock });
    const out = await client.callTool({
      system: "sys",
      prompt: "hello",
      tool: { name: "record", description: "d", inputSchema: { type: "object" } },
    });
    expect(out).toEqual({ ok: 1 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = new Headers(init!.headers);
    expect(headers.get("x-api-key")).toBe("test-key");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({
      model: "test-model",
      system: "sys",
      tool_choice: { type: "tool", name: "record" },
      tools: [{ name: "record", description: "d", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "hello" }],
    });
  });

  it("エラー応答は例外にする（キーはメッセージに含めない）", async () => {
    const client = createClaudeClient({
      apiKey: "secret-key",
      model: "m",
      fetch: async () => new Response('{"error":{"message":"bad"}}', { status: 400 }),
    });
    const p = client.callTool({ system: "", prompt: "", tool: { name: "t", description: "", inputSchema: {} } });
    await expect(p).rejects.toThrow(/400/);
    await expect(p).rejects.not.toThrow(/secret-key/);
  });

  it("tool_use がなければ例外", async () => {
    const client = createClaudeClient({ apiKey: "k", model: "m", fetch: async () => Response.json({ content: [{ type: "text", text: "no" }] }) });
    await expect(client.callTool({ system: "", prompt: "", tool: { name: "t", description: "", inputSchema: {} } })).rejects.toThrow(/tool_use/);
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
});
