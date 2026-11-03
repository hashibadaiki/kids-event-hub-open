/** Claude API（Messages API）の最小クライアント。tool を強制して構造化した出力だけを受け取る */

export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };

export type DocumentInput = { mediaType: "application/pdf"; base64: string };

export type ClaudeClient = {
  callTool(args: { system: string; prompt: string; tool: ToolSpec; maxTokens?: number; document?: DocumentInput }): Promise<unknown>;
};

/** 既定のモデル。環境変数 CLAUDE_MODEL で上書きできる */
export const DEFAULT_MODEL = "claude-sonnet-5-5";
const API_URL = "https://api.anthropic.com/v1/messages";

export function createClaudeClient(opts: { apiKey: string; model?: string; fetch?: typeof fetch }): ClaudeClient {
  const doFetch = opts.fetch ?? fetch;
  const model = opts.model ?? DEFAULT_MODEL;
  return {
    async callTool({ system, prompt, tool, maxTokens = 8192, document }) {
      const content = document
        ? [
            { type: "document", source: { type: "base64", media_type: document.mediaType, data: document.base64 } },
            { type: "text", text: prompt },
          ]
        : prompt;
      const res = await doFetch(API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system,
          tools: [{ name: tool.name, description: tool.description, input_schema: tool.inputSchema }],
          tool_choice: { type: "tool", name: tool.name },
          messages: [{ role: "user", content }],
        }),
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        throw new Error(`Claude API がエラーを返しました（HTTP ${res.status}）: ${detail}`);
      }
      const body = (await res.json()) as { content?: { type: string; name?: string; input?: unknown }[] };
      const use = body.content?.find((c) => c.type === "tool_use" && c.name === tool.name);
      if (!use) throw new Error("Claude API の応答に tool_use がありません");
      return use.input;
    },
  };
}
