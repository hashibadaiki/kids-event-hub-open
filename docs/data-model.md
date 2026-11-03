# データモデル（issue #5）

スキーマ: `packages/db/src/schema.ts`、migration: `packages/db/migrations/`

## テーブル

| テーブル | 役割 |
| --- | --- |
| `facilities` | 施設。将来の施設管理者投稿のスコープ単位（今は空） |
| `sources` | 収集元。`type`（jsonld / ical / rss / html / pdf / llm）、都道府県、`enabled`、`submitted_by`（owner / facility）、`facility_id`、`status`（approved / pending / rejected）、`policy_status`（ok / caution / ng、null は未確認）と確認日時・根拠 |
| `extraction_configs` | 収集元ごとの抽出設定。`(source_id, version)` で一意。`status` は candidate / active / retired / rejected で、**active は収集元ごとに 1 つだけ**（部分一意インデックス）。`quality_score`、`parent_config_id`（どの版からの改善案か）、`note`、`adopted_at` |
| `crawl_runs` | 実行ログ。使用した `config_id`、`status`、開始/終了・所要時間、`fetched_count` / `extracted_count` / `date_found_count` / `upserted_count`、`quality_score`（#11）、エラー |
| `raw_documents` | 取得した生データ（HTML などのテキスト）。自動改善の検証用で非公開。収集元ごとに新しい 3 件だけ残す（#11） |
| `config_evaluations` | 自動改善の前後比較。旧版・候補の版、両方のスコアと指標、`decision`（adopted / rejected）、理由（#11） |
| `events` | イベント。1 開催日 = 1 行。`dedup_key` で一意（upsert のキー）。`(prefecture, start_at)` にインデックス |

## 決めたこと

- 日時は text。イベント日時は JST ローカル表記（`YYYY-MM-DD` / `YYYY-MM-DDTHH:mm`。`packages/core` の `normalizeDate` と同じ）。文字列比較で範囲検索する
  - 「ある日に開催中」= `start_at < 翌日 AND coalesce(end_at, start_at) >= 当日`
- 列挙値は CHECK 制約で DB 側でも弾く
- 未承認（`pending`）・無効・`policy_status = 'ng'` はクロール対象外。既定は `pending`（安全側）で、`sources.yaml` の同期は `owner / approved` を明示して入れる
- 本文は持たず `summary`（要約）と `source_url` のみ
- 年齢・料金は正規化値（`age_min` / `age_max` / `with_parent`、`price_free` / `price_min_yen` / `price_max_yen`）と元の表記（`age_text` / `price_text`）の両方を持つ。`categories` は JSON 配列、繰り返し開催は `recurrence`（JSON）

## ダッシュボードで見たい指標（#13）

- クロール結果: `crawl_runs` を source / 日付で集計（件数、失敗、所要時間）
- 抽出品質: 抽出成功率 = `extracted_count / fetched_count`、日付取得率 = `date_found_count / extracted_count`、`extraction_configs.quality_score`
- 自動改善の前後比較: `config_evaluations`（`configComparisons` クエリ、詳細は `docs/auto-improve.md`）。版ごとの推移は `crawl_runs` を `config_id`（= 版）で GROUP BY（`quality_score` もある）。`packages/db/test/schema.test.ts` に集計クエリの例あり
