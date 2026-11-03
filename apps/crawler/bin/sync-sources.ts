// sources.yaml → D1 の同期。使い方: pnpm sync-sources [--remote] [--dry-run] [--file <path>]
// 既定はローカル D1。本番（--remote）はオーナーが手元で実行する
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSyncArgs, runSyncSources } from "../src/sources/cli";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const webDir = join(repoRoot, "apps/web");

try {
  const code = await runSyncSources(parseSyncArgs(process.argv.slice(2)), {
    readSourcesFile: (file) => readFileSync(file ? resolve(process.env.INIT_CWD ?? process.cwd(), file) : join(repoRoot, "sources.yaml"), "utf8"),
    wrangler: (args) =>
      execFileSync("pnpm", ["exec", "wrangler", ...args], {
        cwd: webDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      }),
    writeTempFile: (content) => {
      const path = join(mkdtempSync(join(tmpdir(), "sync-sources-")), "sync.sql");
      writeFileSync(path, content);
      return path;
    },
    log: (line) => console.log(line),
  });
  process.exit(code);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
