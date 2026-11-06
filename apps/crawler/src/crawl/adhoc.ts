import type { CrawlAllOptions } from "./run";

export const CRAWL_DONE = "crawl-done";

export type AdhocEnv = { CRAWL_SOURCE_IDS?: string; CRAWL_FORCE?: string };

export function adhocOptionsFromEnv(env: AdhocEnv): CrawlAllOptions {
  const options: CrawlAllOptions = {};
  if (env.CRAWL_SOURCE_IDS) {
    const ids = env.CRAWL_SOURCE_IDS.split(",").map((s) => s.trim());
    if (!ids.every((s) => /^\d+$/.test(s))) throw new Error(`CRAWL_SOURCE_IDS が不正です: ${env.CRAWL_SOURCE_IDS}`);
    options.sourceIds = ids.map(Number);
  }
  if (env.CRAWL_FORCE === "1") options.force = true;
  return options;
}

export function parseCrawlProdArgs(argv: string[]): { vars: string[] } {
  const ids: string[] = [];
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") force = true;
    else if (arg === "--source") {
      const id = argv[++i];
      if (!id || !/^\d+$/.test(id)) throw new Error(`--source には収集元の id（数字）を指定してください: ${id ?? "（なし）"}`);
      ids.push(id);
    } else throw new Error(`知らない引数です: ${arg}`);
  }
  if (force && ids.length === 0) throw new Error("--force は --source と一緒に指定してください");
  const vars: string[] = [];
  if (ids.length) vars.push(`CRAWL_SOURCE_IDS:${ids.join(",")}`);
  if (force) vars.push("CRAWL_FORCE:1");
  return { vars };
}
