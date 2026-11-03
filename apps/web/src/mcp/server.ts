import { todayJst } from "../search";
import {
  callTool,
  hasTool,
  MCP_TOOLS,
  PROTOCOL_VERSION,
  SERVER_INFO,
  SUPPORTED_PROTOCOL_VERSIONS,
  type ToolContext,
} from "./tools";

/**
 * MCP（Streamable HTTP トランスポート）の最小実装。
 * - ステートレス: セッション ID を発行せず、POST 1 回に JSON 1 つで応答する（SSE は使わない）
 * - 提供するのは tools（search_events / get_event）だけ
 * SDK を使わないのは、Workers 上で依存を増やさずに済み、やりとりをテストで固定しやすいため
 */

type JsonRpcId = string | number | null;
type JsonRpcRequest = { jsonrpc: "2.0"; id?: JsonRpcId; method: string; params?: unknown };

export type McpResponse = { status: number; body?: unknown };

const error = (id: JsonRpcId, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const result = (id: JsonRpcId, value: unknown) => ({ jsonrpc: "2.0", id, result: value });

const isRequest = (v: unknown): v is JsonRpcRequest =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  (v as JsonRpcRequest).jsonrpc === "2.0" &&
  typeof (v as JsonRpcRequest).method === "string";

const instructions = (now: Date) =>
  `日本の子供向けイベント（自治体・公共施設の催しなど）を都道府県と日付で探すサーバーです。今日は ${todayJst(now)}（JST）です。` +
  "「今週末」「来月」などは JST の日付範囲に直して search_events に渡してください。" +
  "掲載内容は自動抽出のため誤りがありえます。回答では掲載元（source_url）での確認を促してください。";

/** POST /mcp の本文（JSON テキスト）を処理する */
export async function handleMcp(text: string, ctx: ToolContext): Promise<McpResponse> {
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return { status: 400, body: error(null, -32700, "Parse error") };
  }
  if (!isRequest(message)) return { status: 400, body: error(null, -32600, "Invalid Request") };

  // 通知（id なし）と、クライアントからの応答は受け取るだけ
  if (message.id === undefined) return { status: 202 };
  const id = message.id;
  const params = (typeof message.params === "object" && message.params !== null ? message.params : {}) as Record<string, unknown>;

  switch (message.method) {
    case "initialize": {
      const requested = params.protocolVersion;
      const protocolVersion =
        typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION;
      return {
        status: 200,
        body: result(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: instructions(ctx.now),
        }),
      };
    }
    case "ping":
      return { status: 200, body: result(id, {}) };
    case "tools/list":
      return { status: 200, body: result(id, { tools: MCP_TOOLS }) };
    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string" || !hasTool(name)) {
        return { status: 200, body: error(id, -32602, `Unknown tool: ${String(name)}`) };
      }
      try {
        return { status: 200, body: result(id, await callTool(name, params.arguments, ctx)) };
      } catch (e) {
        console.error("mcp tools/call failed", name, e);
        return { status: 200, body: error(id, -32603, "Internal error") };
      }
    }
    default:
      return { status: 200, body: error(id, -32601, `Method not found: ${message.method}`) };
  }
}
