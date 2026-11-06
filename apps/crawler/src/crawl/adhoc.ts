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
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg !== "--source") throw new Error(`知らない引数です: ${arg}`);
    const id = argv[++i];
    if (!id || !/^\d+$/.test(id)) throw new Error(`--source には収集元の id（数字）を指定してください: ${id ?? "（なし）"}`);
    ids.push(id);
  }
  const vars = ids.length ? [`CRAWL_SOURCE_IDS:${ids.join(",")}`] : [];
  return { vars: [...vars, "CRAWL_FORCE:1"] };
}
