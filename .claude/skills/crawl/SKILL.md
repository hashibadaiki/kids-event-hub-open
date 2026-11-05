---
name: crawl
description: 収集元を 1 件ローカルでクロールし、取れた件数・日付が取れた数・品質スコア・失敗理由を報告する。「/crawl <収集元の id・名前・URL>」「この収集元をクロールして」と言われたときに使う。
---

# /crawl <source>

ローカル D1 の収集元を 1 件クロールして結果を見る。本番のクロールは Cron（03:00 JST に全収集元、12:00 JST は直前に失敗した収集元の取り直し）に任せ、ここでは **ローカル D1 だけ**を使う（`--remote` は使わない）。

SQL はすべて `cd apps/web && pnpm exec wrangler d1 execute kids-event-hub --local --command "<SQL>"` で実行する（以下 `d1 "<SQL>"` と書く）。

## 手順

1. **収集元を特定する**: `d1 "SELECT id, name, url, type, status, enabled, policy_status FROM sources WHERE id = <id> OR name LIKE '%<名前>%' OR url = '<URL>'"`。
   - 見つからない → `/add-source <URL>` を案内して終わる
   - `status` が approved でない・`enabled = 0`・`policy_status = 'ng'` → クロールしない。理由を伝えて終わる（ng を解除しない）
2. **間隔の確認**: 最後に成功（success / partial）した取得から 20 時間、または直前の取得から 6 時間たっていない収集元は Cron がスキップする（`d1 "SELECT status, started_at FROM crawl_runs WHERE source_id = <id> ORDER BY id DESC LIMIT 3"`）。ローカルで取り直したいときだけ、ローカル D1 のその収集元の `crawl_runs` を消してよい（本番には触らない）。相手サイトへの負荷を考え、同じ収集元を短時間に何度も取らない
3. **クロール**: `cd apps/crawler && pnpm dev`（バックグラウンド）→ `curl "http://localhost:8787/__scheduled?cron=0+18+*+*+*"`。ほかの収集元も対象になる場合は、事前にその旨を伝える
   - HTML / PDF / LLM 抽出には `apps/crawler/.dev.vars` の `ANTHROPIC_API_KEY` が要る。なければそう伝える（キーをチャットに貼ってもらわない）
4. **結果を読む**: `d1 "SELECT * FROM crawl_runs WHERE source_id = <id> ORDER BY id DESC LIMIT 1"` と、保存されたイベント `d1 "SELECT id, title, start_at, venue, age_min, age_max FROM events WHERE source_id = <id> ORDER BY start_at LIMIT 20"`
5. **報告**: 種別・取れた件数・日付が取れた件数・保存数・品質スコア（#11 マージ後は `quality_score`）・エラー。品質スコアが閾値（0.7）を下回るなら `/improve <id>` を提案する。失敗したクロールは原因と一緒に `docs/improvement-log.md` に 1 行残す
