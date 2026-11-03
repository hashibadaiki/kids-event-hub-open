import { parseExtractionConfig, type ExtractionConfig } from "../extract/config";

/** 収集元ごとに残す生データの数（新しい順） */
export const RAW_DOCS_PER_SOURCE = 3;
/** D1 の 1 行の上限（2MB）に収まるよう、これを超える生データは保存しない */
export const MAX_RAW_BYTES = 1_500_000;

export type ActiveConfig = { id: number; version: number; config: ExtractionConfig };

type ConfigRow = { id: number; version: number; config: string };

export async function getActiveConfig(db: D1Database, sourceId: number): Promise<ActiveConfig | null> {
  const row = await db
    .prepare("SELECT id, version, config FROM extraction_configs WHERE source_id = ? AND status = 'active'")
    .bind(sourceId)
    .first<ConfigRow>();
  return row ? { id: row.id, version: row.version, config: parseExtractionConfig(row.config) } : null;
}

/** active な抽出設定を返す。なければ v1（空の設定 = 既定のプロンプト）を active として作る */
export async function ensureActiveConfig(db: D1Database, sourceId: number, now: Date): Promise<ActiveConfig> {
  const existing = await getActiveConfig(db, sourceId);
  if (existing) return existing;
  await db
    .prepare(
      `INSERT INTO extraction_configs (source_id, version, config, status, note, adopted_at)
       SELECT ?, coalesce(max(version), 0) + 1, '{}', 'active', '既定の設定', ? FROM extraction_configs WHERE source_id = ?
       ON CONFLICT DO NOTHING`,
    )
    .bind(sourceId, now.toISOString(), sourceId)
    .run();
  return (await getActiveConfig(db, sourceId))!;
}

/** 取得した生データを保存し、収集元ごとに新しい RAW_DOCS_PER_SOURCE 件だけ残す。大きすぎるものは保存しない */
export async function saveRawDocument(
  db: D1Database,
  doc: { sourceId: number; runId: number | null; url: string; contentType: string | null; body: string; fetchedAt: Date },
): Promise<boolean> {
  if (new TextEncoder().encode(doc.body).byteLength > MAX_RAW_BYTES) return false;
  await db.batch([
    db
      .prepare("INSERT INTO raw_documents (source_id, crawl_run_id, url, content_type, body, fetched_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(doc.sourceId, doc.runId, doc.url, doc.contentType, doc.body, doc.fetchedAt.toISOString()),
    db
      .prepare(
        `DELETE FROM raw_documents WHERE source_id = ? AND id NOT IN (
           SELECT id FROM raw_documents WHERE source_id = ? ORDER BY fetched_at DESC, id DESC LIMIT ?)`,
      )
      .bind(doc.sourceId, doc.sourceId, RAW_DOCS_PER_SOURCE),
  ]);
  return true;
}

export type RawDocument = { id: number; url: string; contentType: string | null; body: string; fetchedAt: string };

export async function latestRawDocuments(db: D1Database, sourceId: number): Promise<RawDocument[]> {
  const { results } = await db
    .prepare(
      `SELECT id, url, content_type AS contentType, body, fetched_at AS fetchedAt FROM raw_documents
       WHERE source_id = ? ORDER BY fetched_at DESC, id DESC LIMIT ?`,
    )
    .bind(sourceId, RAW_DOCS_PER_SOURCE)
    .all<RawDocument>();
  return results;
}
