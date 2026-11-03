# 運用ダッシュボード（#13）

管理画面は自作せず、Claude の Dashboard でクロール結果・抽出品質・自動改善の前後比較を見せる。
ダッシュボードは公開サイトの読み取り専用 API `GET /api/dashboard` を読む。認証はなく、公開してよい数字だけを返す。

## データ: `GET /api/dashboard`

```
https://kids-event-hub.hashiba-baan-daiki.workers.dev/api/dashboard
```

| パラメータ | 既定 | 内容 |
| --- | --- | --- |
| `runs` | 50 | 直近のクロールを何件返すか（1〜200） |
| `failures` | 20 | 直近の失敗を何件返すか（1〜200） |

`Access-Control-Allow-Origin: *`（別オリジンのダッシュボードから読む）、`Cache-Control: public, max-age=300`。
集計は `packages/db/src/dashboard.ts` の `dashboardStats`。比率は分母が 0 のとき `null`（0% と区別する）。

| キー | 見せたい数字 | 元データ |
| --- | --- | --- |
| `sources.total` / `byType` | 収集元の数 | `sources`（approved かつ有効） |
| `sources.pdfOnlyRate` | PDF のみの収集元の割合 | `type = pdf` |
| `sources.structuredRate` | 構造化データを持つ割合 | `type` が `jsonld` / `ical` / `rss` |
| `runs[]` | クロールごとの取得件数・抽出成功率・日付取得率 | `crawl_runs`。`extractionRate = extracted / fetched`、`dateRate = dateFound / extracted` |
| `configComparisons[]` | 自動改善の前後の日付取得率 | 親の版（`before`）と改善案の版（`after`）それぞれで動いた `crawl_runs` の合計 |
| `failures[]` | 直近の失敗と原因 | `crawl_runs` の `failed` / `partial` と `error_message` |

自動改善の検証結果そのもの（保存データでの再抽出スコア）は #11 で追加される予定。`configComparisons` は本番クロールの実績で前後を比べる。

## ダッシュボードの構成

1. **KPI 行**: 収集元の数 / PDF のみの割合 / 構造化データを持つ割合 / 直近 24 時間の抽出成功率
2. **クロールの推移**: 日ごとの取得件数（棒）と抽出成功率・日付取得率（折れ線）。`runs[]` を `startedAt` の日付で集計
3. **収集元の種別**: `sources.byType` の内訳
4. **自動改善の前後**: `configComparisons[]` を 1 行 1 版で、v(親) → v(子) の日付取得率と差分、採用状態（`status`）、理由（`note`）
5. **直近の失敗**: `failures[]` の表（日時・収集元・状態・原因）。収集元名から元 URL へリンク

## 作り方

`/api/dashboard` が本番にデプロイされたあと（オーナー作業）、Claude で「Dashboard を作って。データは上記 URL の JSON。構成は docs/dashboard.md のとおり」と頼む。
値はページを開いたときに API から読むので、ダッシュボードに数字を書き写さない。

## デモ動画で映す場面

1. **全体像**（10 秒）: KPI 行。「収集元の◯割は PDF しか出していない」→ PDF を Claude で読む理由
2. **毎日のクロール**（10 秒）: 推移グラフ。1 日 1 回、件数と抽出成功率が並ぶ
3. **自動改善**（20 秒、山場）: 前後比較の表で、日付取得率が v1 → v2 で上がった行を指す。`note` に Claude が書いた改善理由が出ている
4. **失敗も見える**（10 秒）: 直近の失敗と原因。robots.txt で止めた収集元など、配慮して止めたものも記録されている
