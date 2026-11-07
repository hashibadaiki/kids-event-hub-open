import type { CrawlAllOptions } from "./run";

function sourceId(v: string | undefined): number {
  if (!v || !/^\d+$/.test(v)) throw new Error(`--source には収集元の id（数字）を指定してください: ${v ?? "（なし）"}`);
  return Number(v);
}

function sourceUrl(v: string | undefined): string {
  if (!v || !/^https?:\/\//.test(v)) throw new Error(`--url には収集元の URL（http / https）を指定してください: ${v ?? "（なし）"}`);
  return v;
}

export function parseCrawlProdArgs(argv: string[]): { local: boolean; options: CrawlAllOptions; urls?: string[] } {
  const ids: number[] = [];
  const urls: string[] = [];
  let local = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--local") local = true;
    else if (arg === "--source") ids.push(sourceId(argv[++i]));
    else if (arg === "--url") urls.push(sourceUrl(argv[++i]));
    else throw new Error(`知らない引数です: ${arg}`);
  }
  return {
    local,
    options: ids.length ? { sourceIds: ids, force: true } : { force: true },
    ...(urls.length ? { urls } : {}),
  };
}

export type ImproveProdArgs = { local: boolean; sourceId?: number; url?: string; target: number; maxRounds: number; maxMisses: number };

export function parseImproveProdArgs(argv: string[]): ImproveProdArgs {
  const out: ImproveProdArgs = { local: false, target: 0.95, maxRounds: 5, maxMisses: 2 };
  const count = (flag: string, v: string | undefined) => {
    if (!v || !/^\d+$/.test(v) || Number(v) < 1) throw new Error(`${flag} には 1 以上の整数を指定してください: ${v ?? "（なし）"}`);
    return Number(v);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--local") out.local = true;
    else if (arg === "--source") out.sourceId = sourceId(argv[++i]);
    else if (arg === "--url") out.url = sourceUrl(argv[++i]);
    else if (arg === "--target") {
      const v = argv[++i];
      const n = Number(v);
      if (!v || Number.isNaN(n) || n < 0 || n > 1) throw new Error(`--target には 0〜1 の数を指定してください: ${v ?? "（なし）"}`);
      out.target = n;
    } else if (arg === "--max-rounds") out.maxRounds = count(arg, argv[++i]);
    else if (arg === "--max-misses") out.maxMisses = count(arg, argv[++i]);
    else throw new Error(`知らない引数です: ${arg}`);
  }
  if (out.sourceId === undefined && out.url === undefined) throw new Error("--source <収集元の id> か --url <収集元の URL> を指定してください");
  return out;
}
