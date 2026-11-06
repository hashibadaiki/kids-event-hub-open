import type { CrawlAllOptions } from "./run";

export function parseCrawlProdArgs(argv: string[]): { local: boolean; options: CrawlAllOptions } {
  const ids: number[] = [];
  let local = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--local") local = true;
    else if (arg === "--source") {
      const id = argv[++i];
      if (!id || !/^\d+$/.test(id)) throw new Error(`--source には収集元の id（数字）を指定してください: ${id ?? "（なし）"}`);
      ids.push(Number(id));
    } else throw new Error(`知らない引数です: ${arg}`);
  }
  return { local, options: ids.length ? { sourceIds: ids, force: true } : { force: true } };
}
