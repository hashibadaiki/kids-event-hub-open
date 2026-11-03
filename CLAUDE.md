# kids-event-hub-open

子供向けイベント情報を自動収集し、都道府県 × 日付で探せるようにするサービス。
自治体・公共施設の PDF チラシを Claude が読んで構造化するのが中心。
ハッカソン提出用の公開リポジトリ。締切: 2026-11-08 20:00 JST。

## スタック

- Cloudflare Workers + D1、Hono、Drizzle、TypeScript
- CLI は wrangler
- Claude API（PDF / HTML の構造化、抽出設定の自動改善）
- MCP サーバー（検索ツールのみ）

## コマンド

```sh
pnpm install                              # 依存のインストール（pnpm 11）
pnpm typecheck && pnpm lint && pnpm test  # CI と同じチェック。push 前に必ず通す
pnpm test:claude                          # .claude/hooks のテストだけ
cd apps/web && pnpm exec wrangler dev     # ローカル D1 で起動
cd packages/db && pnpm generate           # スキーマ変更から migration を生成
```

## 運用ルール

- インフラ操作は CLI（wrangler）のみ。ダッシュボードでの手作業はしない
- 認証情報はチャット・ログに出さない。ログインはオーナーが手元のターミナルで `! wrangler login` を実行する
- 開発は worktree で行う: `git worktree add ../kids-event-hub-issue-<番号> -b issue-<番号> origin/main`（1 issue = 1 worktree。クラウドの使い捨てセッションでは clone 自体が隔離環境なのでブランチを切るだけでよい）
- マージ前に確認する: PR 本文に変更点・テスト結果・迷った点・オーナー作業を書き、オーナーが確認してからマージする
- 下記「やらないこと」の一部は `.claude/hooks/guard-bash.mjs` が機械的に止める（`wrangler deploy` / `login` / `secret put` / リソース作成 / `--remote`、`main` への push）。止められたら回避せず、PR 本文の「オーナー作業」に書く

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

## ディレクトリ

- `apps/web`: 公開サイト（SSR）と MCP
- `apps/crawler`: クロール・抽出・自動改善
- `packages/core`: 正規化（日付・価格・年齢・カテゴリ）、重複判定
- `packages/db`: Drizzle スキーマと migration
- `.claude/`: Claude Code の設定。`settings.json`、`hooks/`、`skills/`、`agents/`（そのままリポジトリに残す。詳細は `.claude/README.md`）
- `docs/`: 設計メモ、試行錯誤の記録
