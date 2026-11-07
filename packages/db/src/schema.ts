import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
  check,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

// 日時は text で持つ。
// - イベントの日時は JST のローカル表記（`YYYY-MM-DD` / `YYYY-MM-DDTHH:mm`）。文字列比較で範囲検索できる
// - 記録用の日時（created_at など）は UTC の ISO 8601 / SQLite の CURRENT_TIMESTAMP

const createdAt = () => text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`);
const updatedAt = () =>
  text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`)
    .$onUpdate(() => sql`CURRENT_TIMESTAMP`);

/**
 * CHECK 制約用の `"col" IN ('a', 'b')`。値は定数のみ。
 * テーブル名で修飾しない（SQLite のテーブル作り直し・RENAME で名前がずれないように）
 */
const oneOf = (column: string, values: readonly string[]) =>
  sql.raw(`"${column}" IN (${values.map((v) => `'${v}'`).join(", ")})`);

export const SOURCE_TYPES = ["jsonld", "ical", "rss", "html", "pdf", "llm"] as const;
export const SUBMITTERS = ["owner", "facility"] as const;
export const SOURCE_STATUSES = ["approved", "pending", "rejected"] as const;
export const POLICY_STATUSES = ["ok", "caution", "ng"] as const;
export const CONFIG_STATUSES = ["candidate", "active", "retired", "rejected"] as const;
export const RUN_STATUSES = ["running", "success", "partial", "failed"] as const;
export const EVALUATION_DECISIONS = ["adopted", "pending", "rejected"] as const;
export const PDF_DOCUMENT_STATUSES = ["extracted", "failed"] as const;

/** 施設。将来の施設管理者投稿のスコープ単位（今は空でよい） */
export const facilities = sqliteTable("facilities", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  prefecture: text("prefecture").notNull(),
  url: text("url"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** 収集元。sources.yaml の同期で owner / approved の行が入る。クローラーは approved のみ対象 */
export const sources = sqliteTable(
  "sources",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    url: text("url").notNull().unique(),
    type: text("type", { enum: SOURCE_TYPES }).notNull(),
    prefecture: text("prefecture").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    submittedBy: text("submitted_by", { enum: SUBMITTERS }).notNull().default("owner"),
    facilityId: integer("facility_id").references(() => facilities.id),
    // 未承認はクロールしない側に倒す。同期コマンドは approved を明示して入れる
    status: text("status", { enum: SOURCE_STATUSES }).notNull().default("pending"),
    // robots.txt・利用規約の確認結果。null は未確認。ng はクロール対象外
    policyStatus: text("policy_status", { enum: POLICY_STATUSES }),
    policyCheckedAt: text("policy_checked_at"),
    policyNote: text("policy_note"), // 根拠 URL と要約
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("sources_prefecture_idx").on(t.prefecture),
    check("sources_type_check", oneOf("type", SOURCE_TYPES)),
    check("sources_submitted_by_check", oneOf("submitted_by", SUBMITTERS)),
    check("sources_status_check", oneOf("status", SOURCE_STATUSES)),
    check("sources_policy_status_check", sql`"policy_status" IS NULL OR ${oneOf("policy_status", POLICY_STATUSES)}`),
  ],
);

/**
 * 収集元ごとの抽出設定（版管理）。
 * 自動改善ループで candidate を作り、保存データで検証して良ければ active にする。
 * active は収集元ごとに 1 つだけ。
 */
export const extractionConfigs = sqliteTable(
  "extraction_configs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    config: text("config", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    status: text("status", { enum: CONFIG_STATUSES }).notNull().default("candidate"),
    qualityScore: real("quality_score"), // 0〜1。採点前は null
    parentConfigId: integer("parent_config_id").references((): AnySQLiteColumn => extractionConfigs.id),
    note: text("note"), // 改善案の理由・変更点
    createdAt: createdAt(),
    adoptedAt: text("adopted_at"),
  },
  (t) => [
    uniqueIndex("extraction_configs_source_version_unique").on(t.sourceId, t.version),
    uniqueIndex("extraction_configs_one_active_per_source")
      .on(t.sourceId)
      .where(sql`status = 'active'`),
    check("extraction_configs_status_check", oneOf("status", CONFIG_STATUSES)),
  ],
);

/** クロールの実行ログ。ダッシュボードの指標（件数・抽出成功率・日付取得率・所要時間）の元 */
export const crawlRuns = sqliteTable(
  "crawl_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    configId: integer("config_id").references(() => extractionConfigs.id), // 使用した抽出設定の版
    status: text("status", { enum: RUN_STATUSES }).notNull().default("running"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    durationMs: integer("duration_ms"),
    fetchedCount: integer("fetched_count").notNull().default(0), // 取得したページ / ファイル / 候補の数
    extractedCount: integer("extracted_count").notNull().default(0), // イベントとして抽出できた数
    dateFoundCount: integer("date_found_count").notNull().default(0), // うち日付が取れた数
    upsertedCount: integer("upserted_count").notNull().default(0), // events に入れた / 更新した数
    qualityScore: real("quality_score"), // 抽出品質（0〜1）。採点できなかった（取得失敗など）は null
    errorMessage: text("error_message"),
    nothingNew: integer("nothing_new", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    index("crawl_runs_source_started_idx").on(t.sourceId, t.startedAt),
    index("crawl_runs_started_idx").on(t.startedAt),
    index("crawl_runs_config_idx").on(t.configId),
    check("crawl_runs_status_check", oneOf("status", RUN_STATUSES)),
  ],
);

/** 繰り返し開催（例: 毎週土曜）。weekdays は 0=日〜6=土 */
export type Recurrence = { freq: "weekly"; weekdays: number[] };

/** イベント。1 開催日 = 1 行を基本とし、重複キーで二重登録を防ぐ */
export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    crawlRunId: integer("crawl_run_id").references(() => crawlRuns.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    summary: text("summary"), // 本文は転載せず要約のみ
    startAt: text("start_at").notNull(), // JST ローカル表記
    endAt: text("end_at"),
    allDay: integer("all_day", { mode: "boolean" }).notNull().default(false),
    recurrence: text("recurrence", { mode: "json" }).$type<Recurrence>(),
    prefecture: text("prefecture").notNull(),
    city: text("city"),
    venue: text("venue"),
    ageMin: integer("age_min"), // 満年齢・両端含む。null は制限なし/不明
    ageMax: integer("age_max"),
    withParent: integer("with_parent", { mode: "boolean" }),
    ageText: text("age_text"), // 元の表記
    priceFree: integer("price_free", { mode: "boolean" }), // null は不明
    priceMinYen: integer("price_min_yen"),
    priceMaxYen: integer("price_max_yen"),
    priceText: text("price_text"),
    applyText: text("apply_text"),
    categories: text("categories", { mode: "json" }).notNull().default([]).$type<string[]>(),
    sourceUrl: text("source_url").notNull(),
    dedupKey: text("dedup_key").notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("events_prefecture_start_idx").on(t.prefecture, t.startAt),
    index("events_source_idx").on(t.sourceId),
  ],
);

/**
 * 取得した生データ（HTML などのテキスト）。自動改善ループで新旧の抽出設定を再実行して比べるために残す。
 * 公開はしない。収集元ごとに新しいものを数件だけ持つ（古いものはクローラーが消す）
 */
export const rawDocuments = sqliteTable(
  "raw_documents",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    crawlRunId: integer("crawl_run_id").references(() => crawlRuns.id, { onDelete: "set null" }),
    url: text("url").notNull(),
    contentType: text("content_type"),
    body: text("body").notNull(),
    fetchedAt: text("fetched_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("raw_documents_source_fetched_idx").on(t.sourceId, t.fetchedAt)],
);

/**
 * PDF の一覧ページからたどった PDF。抽出済み（extracted）は次回以降は取得・抽出しない。
 * 失敗（failed）はまだ試していない PDF の後に取り直す。fail_count は取得の 4xx（リンク切れなど）だけを数え、一定回数でやめる
 */
export const pdfDocuments = sqliteTable(
  "pdf_documents",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    crawlRunId: integer("crawl_run_id").references(() => crawlRuns.id, { onDelete: "set null" }),
    url: text("url").notNull(),
    status: text("status", { enum: PDF_DOCUMENT_STATUSES }).notNull(),
    extractedCount: integer("extracted_count"),
    failCount: integer("fail_count").notNull().default(0),
    lastError: text("last_error"),
    lastTriedAt: text("last_tried_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("pdf_documents_source_url_unique").on(t.sourceId, t.url),
    check("pdf_documents_status_check", oneOf("status", PDF_DOCUMENT_STATUSES)),
  ],
);

/** 品質指標（0〜1 の率）。crawler の scoreExtraction の結果 */
export type QualityMetrics = Record<string, number>;

/**
 * 自動改善の検証結果（前後比較）。保存済みの生データに対して旧版（baseline）と候補（candidate）で再抽出したスコア
 */
export const configEvaluations = sqliteTable(
  "config_evaluations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    baselineConfigId: integer("baseline_config_id")
      .notNull()
      .references(() => extractionConfigs.id, { onDelete: "cascade" }),
    candidateConfigId: integer("candidate_config_id")
      .notNull()
      .references(() => extractionConfigs.id, { onDelete: "cascade" }),
    baselineScore: real("baseline_score").notNull(),
    candidateScore: real("candidate_score").notNull(),
    baselineMetrics: text("baseline_metrics", { mode: "json" }).notNull().$type<QualityMetrics>(),
    candidateMetrics: text("candidate_metrics", { mode: "json" }).notNull().$type<QualityMetrics>(),
    sampleCount: integer("sample_count").notNull(), // 検証に使った生データの数
    decision: text("decision", { enum: EVALUATION_DECISIONS }).notNull(),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [
    index("config_evaluations_source_created_idx").on(t.sourceId, t.createdAt),
    check("config_evaluations_decision_check", oneOf("decision", EVALUATION_DECISIONS)),
  ],
);

export const HEALTH_ANOMALY_KINDS = ["no_run", "failed", "zero_events", "event_count_drop", "date_rate_drop", "quality_drop"] as const;
export type HealthAnomalyKind = (typeof HEALTH_ANOMALY_KINDS)[number];

export const healthReports = sqliteTable("health_reports", {
  date: text("date").primaryKey(),
  generatedAt: text("generated_at").notNull(),
  targetSources: integer("target_sources").notNull(),
  ranSources: integer("ran_sources").notNull(),
  successCount: integer("success_count").notNull(),
  partialCount: integer("partial_count").notNull(),
  failedCount: integer("failed_count").notNull(),
  noRunCount: integer("no_run_count").notNull(),
  anomalyCount: integer("anomaly_count").notNull(),
  extractedCount: integer("extracted_count").notNull(),
  dateFoundCount: integer("date_found_count").notNull(),
});

export const sourceHealth = sqliteTable(
  "source_health",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    date: text("date").notNull(),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    runId: integer("run_id"),
    status: text("status", { enum: RUN_STATUSES }),
    nothingNew: integer("nothing_new", { mode: "boolean" }).notNull().default(false),
    extractedCount: integer("extracted_count").notNull().default(0),
    dateFoundCount: integer("date_found_count").notNull().default(0),
    dateRate: real("date_rate"),
    baselineExtractedCount: real("baseline_extracted_count"),
    baselineDateRate: real("baseline_date_rate"),
    qualityScore: real("quality_score"),
    baselineQualityScore: real("baseline_quality_score"),
    consecutiveFailedDays: integer("consecutive_failed_days").notNull().default(0),
    anomalies: text("anomalies", { mode: "json" }).$type<HealthAnomalyKind[]>(),
    errorMessage: text("error_message"),
  },
  (t) => [
    uniqueIndex("source_health_date_source_unique").on(t.date, t.sourceId),
    index("source_health_source_date_idx").on(t.sourceId, t.date),
  ],
);
