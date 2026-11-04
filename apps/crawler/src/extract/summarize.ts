import type { ClaudeClient } from "../claude";
import type { RawEvent } from "./types";

export const SUMMARY_BATCH_SIZE = 20;
export const SUMMARY_MAX_CHARS = 100;
const DESCRIPTION_MAX_CHARS = 1_000;

const SYSTEM = [
  "あなたは子供向けイベントの紹介文を書く担当です。",
  "各イベントの説明文を、本文を転載せずに 100 文字以内の自分の言葉で要約してください。",
  "説明文に書かれている事実だけを使い、推測で補わないでください。",
].join("\n");

const TOOL = {
  name: "record_summaries",
  description: "各イベントの要約を記録する",
  inputSchema: {
    type: "object",
    properties: {
      summaries: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer", description: "イベントの番号（[ ] の中の数字）" },
            summary: { type: "string", description: "100 文字以内の要約（転載しない）" },
          },
          required: ["index", "summary"],
        },
      },
    },
    required: ["summaries"],
  },
};

export async function summarizeEvents(raws: RawEvent[], claude: ClaudeClient): Promise<RawEvent[]> {
  const out = raws.map((r) => ({ ...r }));
  const targets = out.map((r, i) => ({ r, i })).filter(({ r }) => !r.summary && r.description?.trim());

  for (let start = 0; start < targets.length; start += SUMMARY_BATCH_SIZE) {
    const batch = targets.slice(start, start + SUMMARY_BATCH_SIZE);
    const prompt = batch
      .map(({ r }, n) => `[${start + n}] ${r.title}\n${r.description!.replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_MAX_CHARS)}`)
      .join("\n\n");
    const res = (await claude.callTool({ system: SYSTEM, prompt, tool: TOOL })) as {
      summaries?: { index?: unknown; summary?: unknown }[];
    };
    for (const item of Array.isArray(res?.summaries) ? res.summaries : []) {
      const target = typeof item.index === "number" ? targets[item.index] : undefined;
      if (!target || !batch.includes(target) || typeof item.summary !== "string" || !item.summary.trim()) continue;
      target.r.summary = item.summary.trim().slice(0, SUMMARY_MAX_CHARS);
    }
  }
  return out;
}
