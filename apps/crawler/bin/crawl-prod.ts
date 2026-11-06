// 手元の wrangler dev を本番 D1 につなぎ、クロールと自動改善を 1 回だけ実行する（本番 D1 に書き込む。オーナーが実行する）
// 使い方: pnpm crawl-prod [--source <id> ...]
//   引数なし       クロール対象の全収集元を、間隔の制限（成功から 20 時間 / 直前から 6 時間）なしで今すぐ取る
//   --source <id>  その収集元だけ取る（複数指定可）
// 事前に wrangler login 済みであること。ANTHROPIC_API_KEY は apps/crawler/.dev.vars から読む
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CRAWL_DONE, parseCrawlProdArgs } from "../src/crawl/adhoc";

const PORT = 8799;
const base = `http://localhost:${PORT}`;

let vars: string[];
try {
  ({ vars } = parseCrawlProdArgs(process.argv.slice(2)));
} catch (e) {
  console.error((e as Error).message);
  console.error("使い方: pnpm crawl-prod [--source <id> ...]");
  process.exit(1);
}

const only = vars.find((v) => v.startsWith("CRAWL_SOURCE_IDS:"));
console.log(`本番 D1 に向けてクロールします（${only ? `収集元 ${only.split(":")[1]}` : "全収集元"}。間隔の制限なし）`);

const args = ["exec", "wrangler", "dev", "-c", "wrangler.prod.jsonc", "--test-scheduled", "--port", String(PORT), ...vars.flatMap((v) => ["--var", v])];
const dev = spawn("pnpm", args, { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["ignore", "pipe", "pipe"] });

let finished = false;
const stop = (code: number) => {
  finished = true;
  dev.kill("SIGINT");
  process.exitCode = code;
};

const watch = (chunk: Buffer, out: NodeJS.WriteStream) => {
  const text = chunk.toString();
  out.write(text);
  if (text.split("\n").some((line) => line.includes(CRAWL_DONE))) stop(0);
};
dev.stdout.on("data", (c: Buffer) => watch(c, process.stdout));
dev.stderr.on("data", (c: Buffer) => watch(c, process.stderr));
dev.on("exit", (code) => {
  if (!finished) {
    console.error(`wrangler dev が終了しました（code ${code}）`);
    process.exitCode = 1;
  }
});
process.on("SIGINT", () => stop(130));

async function waitForReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (finished) return false;
    try {
      await fetch(base);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

if (await waitForReady()) {
  const res = await fetch(`${base}/__scheduled?cron=${encodeURIComponent("0 18 * * *")}`);
  if (!res.ok) {
    console.error(`クロールの起動に失敗しました（HTTP ${res.status}）`);
    stop(1);
  }
} else if (!finished) {
  console.error("wrangler dev が起動しませんでした");
  stop(1);
}
