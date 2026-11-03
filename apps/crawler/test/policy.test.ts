import { describe, it, expect, vi } from "vitest";
import html from "./fixtures/page.html?raw";
import { findPolicyLinks, assessPolicy } from "../src/crawl/policy";
import type { ClaudeClient } from "../src/claude";

const allowed = { allowed: true, crawlDelaySec: null, rule: null };

describe("findPolicyLinks", () => {
  it("同じサイト内の利用規約・サイトポリシー・著作権のリンクを探す", () => {
    expect(findPolicyLinks(html, "https://example.jp/events/")).toEqual([
      "https://example.jp/policy/",
      "https://example.jp/copyright.html",
    ]);
  });
});

describe("assessPolicy", () => {
  const claudeReturning = (...answers: object[]): ClaudeClient & { callTool: ReturnType<typeof vi.fn> } => {
    const callTool = vi.fn();
    for (const a of answers) callTool.mockResolvedValueOnce(a);
    return { callTool };
  };

  it("robots.txt で禁止なら Claude を呼ばずに ng", async () => {
    const claude = claudeReturning();
    const r = await assessPolicy(
      { robotsUrl: "https://a.jp/robots.txt", robots: { allowed: false, crawlDelaySec: null, rule: "Disallow: /" }, pages: [] },
      claude,
    );
    expect(r.proposed).toBe("ng");
    expect(r.note).toContain("Disallow: /");
    expect(claude.callTool).not.toHaveBeenCalled();
  });

  it("規約に自動取得の明確な禁止があれば ng", async () => {
    const claude = claudeReturning({ automated_access: "prohibited", summary: "ロボットによる自動取得を禁止" });
    const r = await assessPolicy(
      { robotsUrl: "https://a.jp/robots.txt", robots: allowed, pages: [{ url: "https://a.jp/policy", text: "..." }] },
      claude,
    );
    expect(r.proposed).toBe("ng");
    expect(r.note).toContain("https://a.jp/policy");
    expect(r.note).toContain("ロボットによる自動取得を禁止");
  });

  it("「無断転載禁止」程度の曖昧な記述は caution、記述なしは ok", async () => {
    const claude = claudeReturning(
      { automated_access: "none", summary: "リンクは自由" },
      { automated_access: "ambiguous", summary: "無断転載禁止の一般的な注意書き" },
    );
    const r = await assessPolicy(
      {
        robotsUrl: "https://a.jp/robots.txt",
        robots: { allowed: true, crawlDelaySec: 10, rule: null },
        pages: [
          { url: "https://a.jp/link", text: "x" },
          { url: "https://a.jp/copyright", text: "y" },
        ],
      },
      claude,
    );
    expect(r.proposed).toBe("caution");
    expect(r.note).toContain("Crawl-delay 10");

    const ok = await assessPolicy(
      { robotsUrl: "https://a.jp/robots.txt", robots: allowed, pages: [{ url: "https://a.jp/link", text: "x" }] },
      claudeReturning({ automated_access: "none", summary: "自動取得の記述なし" }),
    );
    expect(ok.proposed).toBe("ok");
  });

  it("規約ページが見つからない・Claude がないときは caution（オーナーが確認）", async () => {
    const r = await assessPolicy({ robotsUrl: "https://a.jp/robots.txt", robots: allowed, pages: [] }, null);
    expect(r.proposed).toBe("caution");
    expect(r.note).toContain("規約ページが見つからない");
    const noClaude = await assessPolicy(
      { robotsUrl: "https://a.jp/robots.txt", robots: allowed, pages: [{ url: "https://a.jp/p", text: "x" }] },
      null,
    );
    expect(noClaude.proposed).toBe("caution");
  });
});
