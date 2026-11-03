/** robots.txt のグループ（User-agent ごとの規則） */
type Rule = { allow: boolean; path: string };
type Group = { agents: string[]; rules: Rule[]; crawlDelaySec: number | null };
export type Robots = { groups: Group[] };

export type RobotsCheck = {
  allowed: boolean;
  /** Crawl-delay（秒）。指定なしは null */
  crawlDelaySec: number | null;
  /** 禁止の根拠になった行（例: "Disallow: /private/"） */
  rule: string | null;
};

/** robots.txt を読む（RFC 9309 の範囲で。Sitemap などは無視） */
export function parseRobots(text: string): Robots {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();

    if (key === "user-agent") {
      // 連続する User-agent 行は同じグループ
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelaySec: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      if (value) current.rules.push({ allow: key === "allow", path: value });
    } else if (key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelaySec = n;
    }
  }
  return { groups };
}

/**
 * path（クエリを含んでよい）を userAgent で取得してよいか。
 * 自分の UA の名前を含むグループがあればそれを、なければ `*` を使う。規則は最長一致で、同じ長さなら Allow。
 */
export function checkRobots(robots: Robots | null, path: string, userAgent: string): RobotsCheck {
  if (!robots) return { allowed: true, crawlDelaySec: null, rule: null };
  const ua = userAgent.toLowerCase();
  const own = robots.groups.filter((g) => g.agents.some((a) => a !== "*" && ua.includes(a)));
  const groups = own.length > 0 ? own : robots.groups.filter((g) => g.agents.includes("*"));
  if (groups.length === 0) return { allowed: true, crawlDelaySec: null, rule: null };

  const rules = groups.flatMap((g) => g.rules);
  const crawlDelaySec = groups.map((g) => g.crawlDelaySec).find((d) => d !== null) ?? null;

  let best: Rule | null = null;
  for (const r of rules) {
    if (!matches(r.path, path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  if (!best || best.allow) return { allowed: true, crawlDelaySec, rule: null };
  return { allowed: false, crawlDelaySec, rule: `Disallow: ${best.path}` };
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${re}${anchored ? "$" : ""}`).test(path);
}
