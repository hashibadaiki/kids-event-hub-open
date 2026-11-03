import { describe, it, expect, vi } from "vitest";
import { summarizeEvents, SUMMARY_BATCH_SIZE } from "../src/extract/summarize";
import type { ClaudeClient } from "../src/claude";
import type { RawEvent } from "../src/extract/types";

const raw = (title: string, extra: Partial<RawEvent> = {}): RawEvent => ({ title, start: "2026-11-20", ...extra });

describe("summarizeEvents", () => {
  it("要約がなく説明文がある候補だけを Claude に渡し、index で要約を戻す", async () => {
    const callTool = vi.fn(async () => ({ summaries: [{ index: 0, summary: "工作の要約" }, { index: 1, summary: "観察会の要約" }] }));
    const out = await summarizeEvents(
      [
        raw("工作教室", { description: "紙コップで工作します" }),
        raw("説明なし"),
        raw("要約済み", { description: "x", summary: "既存の要約" }),
        raw("観察会", { description: "望遠鏡で星を見ます" }),
      ],
      { callTool },
    );
    expect(out.map((r) => r.summary ?? null)).toEqual(["工作の要約", null, "既存の要約", "観察会の要約"]);
    expect(callTool).toHaveBeenCalledTimes(1);
    const prompt = (callTool.mock.calls[0] as unknown as [{ prompt: string }])[0].prompt;
    expect(prompt).toContain("紙コップで工作します");
    expect(prompt).not.toContain("既存の要約");
  });

  it("件数が多いときは分けて呼ぶ", async () => {
    const claude: ClaudeClient = {
      callTool: vi.fn(async ({ prompt }: { prompt: string }) => ({
        summaries: [...prompt.matchAll(/\[(\d+)\]/g)].map((m) => ({ index: Number(m[1]), summary: `要約${m[1]}` })),
      })),
    };
    const many = Array.from({ length: SUMMARY_BATCH_SIZE + 5 }, (_, i) => raw(`e${i}`, { description: `説明${i}` }));
    const out = await summarizeEvents(many, claude);
    expect(claude.callTool).toHaveBeenCalledTimes(2);
    expect(out.every((r) => typeof r.summary === "string")).toBe(true);
  });

  it("100 文字を超える要約は切り詰め、範囲外の index は無視する", async () => {
    const claude: ClaudeClient = {
      callTool: vi.fn(async () => ({ summaries: [{ index: 0, summary: "あ".repeat(150) }, { index: 9, summary: "x" }] })),
    };
    const out = await summarizeEvents([raw("a", { description: "説明" })], claude);
    expect(out[0]!.summary!.length).toBeLessThanOrEqual(100);
  });

  it("要約の対象がなければ Claude を呼ばない", async () => {
    const claude: ClaudeClient = { callTool: vi.fn() };
    await summarizeEvents([raw("a")], claude);
    expect(claude.callTool).not.toHaveBeenCalled();
  });
});
