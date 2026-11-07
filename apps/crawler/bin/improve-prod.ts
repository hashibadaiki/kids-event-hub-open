// 手元の Node から本番 D1 に（remote binding で）つなぎ、1 収集元の抽出設定を目標スコアを超えるまで改善する（再クロールはしない。本番 D1 に書き込む）
// 使い方: pnpm improve-prod (--source <id> | --url <収集元の URL>) [--target 0.95] [--max-rounds 5] [--max-misses 2] [--local]
// 事前に wrangler login 済みであること。ANTHROPIC_API_KEY は apps/crawler/.dev.vars から読む
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import { createClaudeClient } from "../src/claude";
import { parseImproveProdArgs, type ImproveProdArgs } from "../src/crawl/adhoc";
import { improveUntil } from "../src/improve/improve";
import type { CrawlerEnv } from "../src/worker";

let args: ImproveProdArgs;
try {
  args = parseImproveProdArgs(process.argv.slice(2));
} catch (e) {
  console.error((e as Error).message);
  console.error("使い方: pnpm improve-prod (--source <id> | --url <収集元の URL>) [--target 0.95] [--max-rounds 5] [--max-misses 2] [--local]");
  process.exit(1);
}

const dir = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const proxy = await getPlatformProxy<CrawlerEnv>(
  args.local
    ? { configPath: dir("../wrangler.jsonc"), remoteBindings: false, persist: { path: dir("../../web/.wrangler/state/v3") } }
    : { configPath: dir("../wrangler.prod.jsonc"), remoteBindings: true },
);

try {
  const { env } = proxy;
  const apiKey = env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY が未設定のため改善できません");
    process.exitCode = 1;
  } else {
    const id =
      args.sourceId ??
      (await env.DB.prepare("SELECT id FROM sources WHERE url = ?").bind(args.url!).first<{ id: number }>())?.id;
    if (id === undefined) throw new Error(`D1 にない URL です: ${args.url}`);
    const claude = createClaudeClient({ apiKey, model: env.CLAUDE_MODEL || process.env.CLAUDE_MODEL || undefined });
    console.log(`${args.local ? "ローカル" : "本番"} D1 の収集元 ${id} を、品質 ${args.target} を超えるまで改善します（最大 ${args.maxRounds} 回）`);
    const out = await improveUntil(env.DB, id, { claude, now: () => new Date() }, args);
    out.rounds.forEach((r, i) => {
      const scores = r.baseline ? `${r.baseline.score.toFixed(2)} → ${r.candidate?.score.toFixed(2) ?? "-"}` : "-";
      console.log(`[${i + 1}] ${r.decision}（${scores}）${r.reason}`);
    });
    const labels = {
      reached: "目標を超えた",
      stalled: "採用されない回が続いた",
      "max-rounds": "上限回数に達した",
      skipped: "改善できなかった",
      "not-improvable": "Claude で抽出しない種別なので対象外",
    };
    console.log(`\n終了: ${labels[out.stop]}。品質 ${out.score?.toFixed(2) ?? "-"}`);
  }
} finally {
  await proxy.dispose();
}
