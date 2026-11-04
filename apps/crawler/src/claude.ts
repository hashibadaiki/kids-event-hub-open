/** Claude API（Messages API）の最小クライアント。構造化出力（JSON Schema）で決まった形の JSON だけを受け取る */

export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };

export type DocumentInput = { mediaType: "application/pdf"; base64: string };

export type ClaudeClient = {
  callTool(args: { system: string; prompt: string; tool: ToolSpec; maxTokens?: number; document?: DocumentInput }): Promise<unknown>;
};

/** 既定のモデル。環境変数 CLAUDE_MODEL で上書きできる */
export const DEFAULT_MODEL = "claude-sonnet-5-5";
const API_URL = "https://api.anthropic.com/v1/messages";

type MessagesResponse = { stop_reason?: string; content?: { type: string; text?: string }[] };

export function createClaudeClient(opts: { apiKey: string; model?: string; fetch?: typeof fetch }): ClaudeClient {
  const doFetch = opts.fetch ?? fetch;
  const model = opts.model ?? DEFAULT_MODEL;
  return {
    async callTool({ system, prompt, tool, maxTokens = 16000, document }) {
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
          system: `${system}\n\n出力: ${tool.description}`,
          output_config: { format: { type: "json_schema", schema: toStructuredSchema(tool.inputSchema) } },
          messages: [{ role: "user", content }],
        }),
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        throw new Error(`Claude API がエラーを返しました（HTTP ${res.status}）: ${detail}`);
      }
      const body = (await res.json()) as MessagesResponse;
      if (body.stop_reason === "refusal") throw new Error("Claude API が応答を拒否しました（stop_reason: refusal）");
      if (body.stop_reason === "max_tokens") throw new Error(`Claude API の出力が上限で打ち切られました（stop_reason: max_tokens, max_tokens: ${maxTokens}）`);
      const text = body.content?.find((c) => c.type === "text")?.text;
      try {
        return JSON.parse(text ?? "");
      } catch {
        throw new Error("Claude API の応答を JSON として読めませんでした");
      }
    },
  };
}

/** 構造化出力はすべてのオブジェクトに additionalProperties: false を求めるので付ける */
export function toStructuredSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toStructuredSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    out[k] = k === "properties" && v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).map(([name, s]) => [name, toStructuredSchema(s)]))
      : toStructuredSchema(v);
  }
  if (out.type === "object") out.additionalProperties = false;
  return out;
}
