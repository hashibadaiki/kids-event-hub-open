import type { ClaudeClient } from "../claude";
import { absoluteUrl, decodeEntities, stripTags } from "../extract/text";
import type { PolicyStatus } from "../sources/file";
import { fetchDocument, FetchError, USER_AGENT } from "./fetch";
import { checkRobots, parseRobots, type RobotsCheck } from "./robots";
import { htmlToText } from "../extract/html";

const POLICY_LINK_RE = /利用規約|ご利用(?:にあたって|について)|サイト(?:の)?(?:ポリシー|利用|について)|このサイトについて|著作権|リンク(?:について|・)|免責|terms|policy/i;

/** ページ内のリンクから、同じサイトの利用規約・サイトポリシー・著作権のページを探す */
export function findPolicyLinks(html: string, pageUrl: string): string[] {
  const origin = new URL(pageUrl).origin;
  const found: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = stripTags(m[2]!);
    if (!POLICY_LINK_RE.test(label)) continue;
    const url = absoluteUrl(decodeEntities(m[1]!), pageUrl);
    if (!url || new URL(url).origin !== origin) continue;
    const clean = url.replace(/#.*$/, "");
    if (!found.includes(clean)) found.push(clean);
  }
  return found;
}

export type PolicyAssessment = {
  /** 提案。確定はオーナーが sources.yaml の policy に書く */
  proposed: PolicyStatus;
  /** policy_note に入れる根拠（URL と要約） */
  note: string;
  findings: { url: string; automatedAccess: "prohibited" | "ambiguous" | "none"; summary: string }[];
};

const SYSTEM = [
  "あなたはウェブサイトの利用規約・サイトポリシーを読み、クローラーによる自動取得についての記述を判定する担当です。",
  "prohibited: ロボット・クローラー・自動取得・スクレイピング等を明確に禁止している。",
  "ambiguous: 「無断転載禁止」など一般的な注意書きのみ、または対象が不明確。",
  "none: 自動取得や転載についての制限の記述がない。",
  "summary は該当箇所を 60 文字以内で要約してください（長く引用しない）。",
].join("\n");

const TOOL = {
  name: "report_policy",
  description: "自動取得についての記述の判定結果を記録する",
  inputSchema: {
    type: "object",
    properties: {
      automated_access: { type: "string", enum: ["prohibited", "ambiguous", "none"] },
      summary: { type: "string" },
    },
    required: ["automated_access", "summary"],
  },
};

/** 規約ページのテキストの上限（文字数） */
const MAX_POLICY_CHARS = 20_000;

/**
 * robots.txt の判定と規約ページの内容から policy_status を提案する。
 * - robots.txt で禁止 / 規約で明確に禁止 → ng
 * - 曖昧な記述がある / 規約ページが見つからない / Claude で読めない → caution
 * - それ以外 → ok
 */
export async function assessPolicy(
  input: { robotsUrl: string; robots: RobotsCheck; pages: { url: string; text: string }[] },
  claude: ClaudeClient | null,
): Promise<PolicyAssessment> {
  const robotsNote = input.robots.allowed
    ? `robots.txt（${input.robotsUrl}）: 禁止なし${input.robots.crawlDelaySec !== null ? `、Crawl-delay ${input.robots.crawlDelaySec}` : ""}`
    : `robots.txt（${input.robotsUrl}）: ${input.robots.rule}`;
  if (!input.robots.allowed) return { proposed: "ng", note: robotsNote, findings: [] };

  if (input.pages.length === 0) {
    return { proposed: "caution", note: `${robotsNote}。規約ページが見つからないため要確認`, findings: [] };
  }
  if (!claude) {
    return {
      proposed: "caution",
      note: `${robotsNote}。規約 ${input.pages.map((p) => p.url).join(" ")} は未判定（ANTHROPIC_API_KEY 未設定）`,
      findings: [],
    };
  }

  const findings: PolicyAssessment["findings"] = [];
  for (const page of input.pages) {
    const out = (await claude.callTool({
      system: SYSTEM,
      prompt: `URL: ${page.url}\n\n${page.text.slice(0, MAX_POLICY_CHARS)}`,
      tool: TOOL,
      maxTokens: 1024,
    })) as { automated_access?: string; summary?: string };
    const a = out?.automated_access;
    findings.push({
      url: page.url,
      automatedAccess: a === "prohibited" || a === "none" ? a : "ambiguous",
      summary: typeof out?.summary === "string" ? out.summary : "",
    });
  }
  const proposed: PolicyStatus = findings.some((f) => f.automatedAccess === "prohibited")
    ? "ng"
    : findings.some((f) => f.automatedAccess === "ambiguous")
      ? "caution"
      : "ok";
  const note = [robotsNote, ...findings.map((f) => `${f.url}: ${f.summary}`)].join("。");
  return { proposed, note, findings };
}

/** 確認する規約ページの数の上限 */
const MAX_POLICY_PAGES = 3;

/**
 * 収集元の URL について robots.txt と規約ページを取得し、policy_status を提案する（/add-source から使う）。
 * 書き込みはしない。確定はオーナーが sources.yaml の policy に書く
 */
export async function checkPolicy(
  pageUrl: string,
  deps: { fetch: typeof fetch; claude: ClaudeClient | null; sleep: (ms: number) => Promise<void> },
): Promise<PolicyAssessment & { robots: RobotsCheck; policyUrls: string[] }> {
  const url = new URL(pageUrl);
  const robotsUrl = `${url.origin}/robots.txt`;
  let robotsText: string | null = null;
  try {
    robotsText = (await fetchDocument(robotsUrl, { fetch: deps.fetch, maxBytes: 512 * 1024 })).text;
  } catch (e) {
    if (!(e instanceof FetchError && e.status !== null && e.status >= 400 && e.status < 500)) throw e;
  }
  const robots = checkRobots(robotsText === null ? null : parseRobots(robotsText), url.pathname + url.search, USER_AGENT);
  if (!robots.allowed) return { ...(await assessPolicy({ robotsUrl, robots, pages: [] }, null)), robots, policyUrls: [] };

  const delayMs = Math.max(robots.crawlDelaySec ?? 1, 1) * 1000;
  await deps.sleep(delayMs);
  const page = await fetchDocument(pageUrl, { fetch: deps.fetch });
  const policyUrls = findPolicyLinks(page.text, page.url).slice(0, MAX_POLICY_PAGES);
  const pages: { url: string; text: string }[] = [];
  for (const u of policyUrls) {
    await deps.sleep(delayMs);
    try {
      pages.push({ url: u, text: htmlToText((await fetchDocument(u, { fetch: deps.fetch })).text) });
    } catch {
      // 取れなかった規約ページは判定に使わない（note には出ないので、オーナーが確認する）
    }
  }
  return { ...(await assessPolicy({ robotsUrl, robots, pages }, deps.claude)), robots, policyUrls };
}
