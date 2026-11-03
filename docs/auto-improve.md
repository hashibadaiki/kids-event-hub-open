# 自動改善ループ（issue #11）

クロールごとに抽出品質を採点し、低ければ Claude が抽出設定の改善案を出し、保存済みの生データで新旧を比べて **良くなった場合だけ採用** する。

コード: `apps/crawler/src/improve/`（`quality.ts` 採点と採否判定、`configs.ts` 版と生データ、`improve.ts` 改善ジョブ）、`apps/crawler/src/extract/config.ts`（抽出設定）

## 流れ

1. `crawlSource` が文書を取得したら `raw_documents` に生データを保存（収集元ごとに新しい 3 件だけ残す。1.5MB 超は保存しない。公開しない）
2. 収集元の active な抽出設定（なければ v1 = 空の設定を作る）で抽出し、`crawl_runs.config_id` に版を、`crawl_runs.quality_score` にスコアを記録
3. Cron の最後に `improveLowQuality` が、スコアが閾値（0.7）未満で Claude 抽出（`html` / `llm`）の収集元について `improveSource` を実行
4. `improveSource`
   - 保存済みの生データを現行の設定で再抽出して採点（baseline）
   - 日付・会場・年齢を取りこぼしたサンプル、現行の設定、指標、本文の抜粋を Claude に渡し、新しい設定（指示・ヒント・セレクタ候補）を tool use で提案させる
   - 候補を `extraction_configs` に `candidate`（version + 1、`parent_config_id` = 現行）として保存
   - 同じ生データを候補の設定で再抽出して採点（candidate）
   - 採否判定: スコアが 0.02 以上上がり、抽出件数が旧版の 8 割以上なら採用 → 旧版 `retired`・候補 `active`（`adopted_at`）。それ以外は候補 `rejected`
   - 前後比較を `config_evaluations` に記録（両方のスコア・指標・採否・理由）

## 品質スコア

候補（抽出した件数）を分母に、次の重み付き合計（0〜1）。

| 指標 | 定義 | 重み |
| --- | --- | --- |
| 日付取得率 | 開始日を決められた候補 | 0.35 |
| 場所取得率 | 会場がある候補 | 0.15 |
| 対象年齢取得率 | 年齢の表記がある・正規化で取れた候補 | 0.15 |
| 重複率 | 日付が取れた候補のうち同じ抽出内で重複するもの（1 − 率で加点） | 0.15 |
| 必須項目の欠損率 | タイトル・日付・会場のどれかが欠けている候補（1 − 率で加点） | 0.2 |

## 抽出設定（`extraction_configs.config`）

```json
{ "instructions": "このページ向けの指示", "hints": ["ヒント"], "selectors": ["#main ul"] }
```

- `instructions` / `hints` はシステムプロンプトに足す
- `selectors` は HTMLRewriter で本文を絞る。どれにも一致しなければページ全体を使う
- 空 `{}` は既定のプロンプトのみ（v1）

## ダッシュボード（#13）用のデータ

- 前後比較: `packages/db` の `configComparisons(db, { sourceId?, limit? })`（収集元名・旧版/新版の番号・スコア・指標・採否・理由を新しい順）
- 版ごとの推移: `crawl_runs` を `config_id` で GROUP BY（`quality_score` の平均など）
