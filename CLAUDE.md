# kids-event-hub-open

子供向けイベント情報を自動収集し、都道府県 × 日付で探せるようにするサービス。
自治体・公共施設の PDF チラシを Claude が読んで構造化するのが中心。
ハッカソン提出用の公開リポジトリ。締切: 2026-11-08 20:00 JST。

## スタック

- Cloudflare Workers + D1、Hono、Drizzle、TypeScript
- CLI は wrangler
- Claude API（PDF / HTML の構造化、抽出設定の自動改善）
- MCP サーバー（検索ツールのみ）

## 進め方

- 作業は GitHub の issue 単位。1 issue = 1 ブランチ `issue-<番号>` = 1 PR
- `ready` ラベルの issue だけ着手する。ラベルはオーナーが付ける
- issue の要件（ゴール）は変えない。緩めたくなったら issue にコメントして止まる
- `main` には直接 push しない。PR のマージはオーナーが行う
- TDD で進める: 先に失敗するテストを書く（Red）→ 通す最小の実装（Green）→ リファクタ。テストのない PR は作らない
- CI（typecheck → lint → test）がグリーンであることがマージ条件
- テストはネットワークに出ない。外部サイトや Claude API は fixtures とモックで扱う

## やらないこと

- `wrangler deploy` / `wrangler login` / `wrangler secret put` / Cloudflare リソースの作成（オーナーが手元で実行する。必要なら PR 本文に「オーナー作業」として書く）
- API キー・トークン・個人情報をコード、コミット、ログ、PR、issue に書く
- Web の公開投稿フォーム、ユーザー登録・ログイン、管理画面の自作

## 収集の方針

- 収集元は `sources.yaml` で管理し、同期コマンドで D1 に反映する
- クロール前に robots.txt と利用規約を確認する。明示的な禁止はクロールしない。曖昧な記述は低頻度・連絡先付き UA・本文は転載せず要約と元 URL のみ、で配慮して進める
- 取得頻度は 1 日 1 回程度

## ディレクトリ（予定）

- `apps/web`: 公開サイト（SSR）と MCP
- `apps/crawler`: クロール・抽出・自動改善
- `packages/core`: 正規化（日付・価格・年齢・カテゴリ）、重複判定
- `packages/db`: Drizzle スキーマと migration
- `.claude/`: skills / agents / hooks（そのままリポジトリに残す）
- `docs/`: 設計メモ、試行錯誤の記録
