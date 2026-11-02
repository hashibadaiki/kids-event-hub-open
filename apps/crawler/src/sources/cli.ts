import { parseSourcesFile } from "./file";
import { planSync, type ExistingSource } from "./sync";

export const D1_DATABASE = "kids-event-hub";

export type SyncArgs = { remote: boolean; dryRun: boolean; file: string | null };

/** 実行環境に依存する部分（テストではモックする） */
export type SyncDeps = {
  readSourcesFile: (file: string | null) => string;
  /** `wrangler <args>` を apps/web（wrangler.jsonc のある場所）で実行して stdout を返す。失敗したら throw */
  wrangler: (args: string[]) => string;
  /** 一時ファイルに書いてパスを返す */
  writeTempFile: (content: string) => string;
  log: (line: string) => void;
};

export function parseSyncArgs(argv: string[]): SyncArgs {
  const args: SyncArgs = { remote: false, dryRun: false, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--remote") args.remote = true;
    else if (a === "--local") args.remote = false;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--file" && argv[i + 1]) args.file = argv[++i];
    else throw new Error(`知らない引数です: ${a}（使えるのは --remote / --local / --dry-run / --file <path>）`);
  }
  return args;
}

function readExisting(args: SyncArgs, deps: SyncDeps): ExistingSource[] {
  const out = deps.wrangler([
    "d1", "execute", D1_DATABASE, args.remote ? "--remote" : "--local", "--json",
    "--command", "SELECT url, submitted_by, enabled FROM sources",
  ]);
  const [first] = JSON.parse(out) as { results: { url: string; submitted_by: string; enabled: number }[] }[];
  return first.results.map((r) => ({ url: r.url, submittedBy: r.submitted_by, enabled: r.enabled === 1 }));
}

/** sources.yaml → D1。終了コードを返す */
export async function runSyncSources(args: SyncArgs, deps: SyncDeps): Promise<number> {
  const target = args.remote ? "本番 D1（--remote）" : "ローカル D1";
  const { entries, errors } = parseSourcesFile(deps.readSourcesFile(args.file));
  if (errors.length > 0) {
    deps.log("sources.yaml にエラーがあります。D1 には書き込んでいません:");
    for (const e of errors) deps.log(`  - ${e}`);
    return 1;
  }

  let existing: ExistingSource[];
  try {
    existing = readExisting(args, deps);
  } catch (e) {
    deps.log(`${target} の sources を読めませんでした: ${(e as Error).message}`);
    deps.log(
      `migration が未適用なら: cd apps/web && pnpm exec wrangler d1 migrations apply ${D1_DATABASE} ${args.remote ? "--remote" : "--local"}`,
    );
    return 1;
  }

  const plan = planSync(entries, existing);
  deps.log(
    `${target}: 追加 ${plan.inserted.length} / 更新 ${plan.updated.length} / 無効化 ${plan.disabled.length} / スキップ ${plan.skipped.length}`,
  );
  for (const url of plan.inserted) deps.log(`  + ${url}`);
  for (const url of plan.disabled) deps.log(`  - ${url}（無効化）`);
  for (const s of plan.skipped) deps.log(`  スキップ ${s.url}: ${s.reason}`);

  const sql = plan.statements.map((s) => `${s};`).join("\n\n");
  if (args.dryRun) {
    deps.log("--dry-run のため書き込んでいません。実行する SQL:");
    deps.log(sql || "（なし）");
    return 0;
  }
  if (plan.statements.length === 0) return 0;

  const path = deps.writeTempFile(sql + "\n");
  deps.wrangler(["d1", "execute", D1_DATABASE, args.remote ? "--remote" : "--local", "--file", path]);
  deps.log("同期しました");
  return 0;
}
