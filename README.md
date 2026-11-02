# kids-event-hub-open

子供向けイベント情報を自動収集し、都道府県 × 日付で探せるようにするサービス。
自治体・公共施設の PDF チラシを Claude が読んで構造化します。

> ハッカソン提出用リポジトリ（締切: 2026-11-08 20:00 JST）。ライセンス: [MIT](./LICENSE)

## 課題

（TODO）子供向けイベントの情報は自治体・公共施設ごとに散らばり、PDF チラシで公開されることも多く、横断して探しにくい。

## 解決

（TODO）PDF / HTML を Claude で構造化し、都道府県 × 日付で検索できるようにする。

## 公開 URL

https://kids-event-hub.hashiba-baan-daiki.workers.dev （`/healthz` で死活確認）

## 使い方

（TODO）収集コマンド、検索サイト、MCP サーバーの使い方。

### 検索サイト

ログイン不要・モバイル向けの SSR ページ。URL は固定で、そのまま共有できます。

| URL | 内容 |
| --- | --- |
| `/` | 都道府県一覧（イベントがある県だけ） |
| `/kagawa/2026-11-08` | 香川県で 2026-11-08 に開催中のイベント |
| `/kagawa?from=2026-11-01&to=2026-11-30` | 期間で絞り込み（未指定は今日から 30 日間、最大 92 日） |
| `?age=5` | 対象年齢で絞り込み（0〜18。年齢の記載がないイベントは残す） |
| `/events/123` | イベント詳細（掲載元ページ / PDF チラシへのリンク） |

### 開発

```sh
corepack enable          # pnpm 11
pnpm install
pnpm typecheck && pnpm lint && pnpm test
cd apps/web && pnpm exec wrangler dev   # ローカル D1 で起動
```

デプロイ（オーナーのみ）:

```sh
cd apps/web
pnpm exec wrangler d1 migrations apply kids-event-hub --remote
pnpm exec wrangler deploy
```

## アーキテクチャ

（TODO）Cloudflare Workers + D1、Hono、Drizzle、TypeScript。クローラー、正規化、Web / MCP の構成図。

## Claude 活用

（TODO）PDF / HTML の構造化、抽出設定の自動改善、MCP サーバー、開発での Claude Code 活用。

## 秘密情報の扱い

API キー・トークン・個人情報を、コード・コミット・issue・PR・チャットに書かないこと。
本番の秘密情報は `wrangler secret put <NAME>` で Cloudflare に設定します。
ローカル開発用の値は `.dev.vars`（`.gitignore` 済み）に置き、コミットしません。
