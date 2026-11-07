---
name: improve
description: 品質スコアが低い収集元の抽出設定を改善する。Improver サブエージェントが改善案を出し、Verifier サブエージェントが保存済みデータで新旧を比較し、明確な改善だけ自動採用・判断が割れるものは人間に承認を求める。「/improve <収集元>」「抽出の品質を上げて」で使う。
---

# /improve <source>

運用ループ（README「ループ 2」）を Claude Code から 1 収集元ぶん回す。Cron の自動改善ジョブ（#11、`apps/crawler/src/improve/`）と同じデータ（`crawl_runs.quality_score`・`raw_documents`・`extraction_configs`・`config_evaluations`）を使う。**ローカル D1 だけ**を使い、本番 D1 への反映はオーナー作業。

前提: #11（生データの保存・採点・設定の版管理）がマージされていること。`raw_documents` テーブルがなければ「#11 のマージ待ち」と伝えて終わる。

## 手順

1. **対象**: 収集元を特定し、直近の `crawl_runs.quality_score` を見る。0.7 以上なら「改善不要」と伝えて終わる（ユーザーが明示的に頼んだときだけ続ける）。本番 D1 の収集元を目標スコアまで繰り返し改善するときは、このスキルではなく `cd apps/crawler && pnpm improve-prod --url <URL>`（既定は 0.95 を超えるまで、最大 5 回）を使う
2. **改善案**: `improver` サブエージェントに収集元 ID を渡し、改善案（設定 JSON と根拠）を受け取る
3. **検証**: `verifier` サブエージェントに収集元 ID と改善案を渡す（Improver の説明は渡さず、案そのものだけ渡す）。判定 `auto` / `human` / `reject` と前後比較を受け取る
4. **採否**
   - `auto`（+0.10 以上・正解サンプルを壊さない）→ 候補を新しい版として `active` にし、旧版を `retired`、`config_evaluations` に `adopted` で記録する
   - `human` → **ここで止まり、人間に承認を求める**。Verifier の前後比較・差分サンプル・理由をそのまま見せ、「採用 / 却下」を聞く。承認されたら `auto` と同じ処理、却下なら候補を `rejected`。返事がないまま採用しない
   - `reject` → 候補を `rejected` にする
5. **記録**: 判定にかかわらず `docs/improvement-log.md` に 1 行追記する（日付・収集元・旧→新スコア・判定・理由・承認者）。却下した案も残す
6. **報告**: 前後のスコア、判定、本番に反映するためのオーナー作業（ローカルで確かめた設定を本番 D1 に入れる手順）。結果はダッシュボード（#13）で見える
