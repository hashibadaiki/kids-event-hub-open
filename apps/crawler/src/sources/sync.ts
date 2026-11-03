import type { SourceEntry } from "./file";

/** D1 の sources の現状（計画に必要な列だけ） */
export type ExistingSource = { url: string; submittedBy: string; enabled: boolean };

export type SyncPlan = {
  /** 実行する SQL（1 要素 = 1 文。wrangler d1 execute --file / D1 batch で実行） */
  statements: string[];
  inserted: string[];
  updated: string[];
  /** ファイルから消えたので無効化する owner の行 */
  disabled: string[];
  /** 触らなかったファイルの行 */
  skipped: { url: string; reason: string }[];
};

/** SQL の文字列リテラル。値は wrangler --file に埋め込むため、バインドではなくエスケープする */
const lit = (v: string | boolean | null): string => {
  if (v === null) return "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${v.replaceAll("'", "''")}'`;
};

function upsert(e: SourceEntry): string {
  const cols = {
    name: lit(e.name),
    url: lit(e.url),
    type: lit(e.type),
    prefecture: lit(e.prefecture),
    enabled: lit(e.enabled),
    submitted_by: lit("owner"),
    status: lit(e.policy?.status === "ng" ? "rejected" : "approved"),
    policy_status: lit(e.policy?.status ?? null),
    policy_checked_at: lit(e.policy?.checkedAt ?? null),
    policy_note: lit(e.policy?.note ?? null),
  };
  return [
    `INSERT INTO sources (${Object.keys(cols).join(", ")})`,
    `VALUES (${Object.values(cols).join(", ")})`,
    "ON CONFLICT (url) DO UPDATE SET",
    "  name = excluded.name, type = excluded.type, prefecture = excluded.prefecture,",
    "  enabled = excluded.enabled,",
    // rejected は戻さない（クローラーが robots.txt の禁止を検出して付けたもの。解除は D1 を直接直す）
    "  status = CASE WHEN sources.status = 'rejected' THEN 'rejected' ELSE excluded.status END,",
    // ファイルで policy を省略したときは D1 の確認結果を残す
    ...["policy_status", "policy_checked_at", "policy_note"].map(
      (c) => `  ${c} = CASE WHEN sources.status = 'rejected' THEN sources.${c} ELSE coalesce(excluded.${c}, sources.${c}) END,`,
    ),
    "  updated_at = CURRENT_TIMESTAMP",
    // 計画の後に別の入口から同じ URL が入っても上書きしない
    "WHERE sources.submitted_by = 'owner'",
  ].join("\n");
}

/**
 * sources.yaml → D1 の同期計画を作る。
 * - ファイルの行は submitted_by = owner / status = approved で upsert
 * - 触るのは submitted_by = owner の行だけ。同じ URL の施設投稿などがあればスキップ
 * - ファイルから消えた owner の行は削除せず enabled = false（過去のイベントとクロール履歴を残す）
 */
export function planSync(entries: SourceEntry[], existing: ExistingSource[]): SyncPlan {
  const byUrl = new Map(existing.map((s) => [s.url, s]));
  const plan: SyncPlan = { statements: [], inserted: [], updated: [], disabled: [], skipped: [] };

  for (const e of entries) {
    const current = byUrl.get(e.url);
    if (current && current.submittedBy !== "owner") {
      plan.skipped.push({
        url: e.url,
        reason: `同じ URL が submitted_by = ${current.submittedBy} で登録済みのため触りません`,
      });
      continue;
    }
    plan.statements.push(upsert(e));
    (current ? plan.updated : plan.inserted).push(e.url);
  }

  const inFile = new Set(entries.map((e) => e.url));
  plan.disabled = existing
    .filter((s) => s.submittedBy === "owner" && s.enabled && !inFile.has(s.url))
    .map((s) => s.url);
  if (plan.disabled.length > 0) {
    plan.statements.push(
      [
        "UPDATE sources SET enabled = 0, updated_at = CURRENT_TIMESTAMP",
        `WHERE submitted_by = 'owner' AND url IN (${plan.disabled.map(lit).join(", ")})`,
      ].join("\n"),
    );
  }
  return plan;
}
