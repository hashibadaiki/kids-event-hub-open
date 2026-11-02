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

### 開発

```sh
corepack enable          # pnpm 11
pnpm install
pnpm typecheck && pnpm lint && pnpm test
cd apps/web && pnpm exec wrangler dev   # ローカル D1 で起動
```

デプロイ: `main` が更新されると GitHub Actions が CI（typecheck → lint → test）の後に本番 D1 の migration 適用（`wrangler d1 migrations apply --remote`）とデプロイ（`wrangler deploy`）を自動で行います。

必要な GitHub の Secrets:

- `CLOUDFLARE_API_TOKEN`: 権限「Workers Scripts: Edit」「D1: Edit」を付けた API トークン
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare のアカウント ID

## アーキテクチャ

（TODO）Cloudflare Workers + D1、Hono、Drizzle、TypeScript。クローラー、正規化、Web / MCP の構成図。

## Claude 活用

（TODO）PDF / HTML の構造化、抽出設定の自動改善、MCP サーバー、開発での Claude Code 活用。

### Claude Code の設定（`.claude/`）

開発で使っている Claude Code の設定を、リポジトリにそのまま残しています。

- `.claude/settings.json`: フックの登録
- `.claude/hooks/`: フック。`guard-bash.mjs` はデプロイ・ログイン・秘密情報の登録・リソース作成・`main` への push を止める（テスト付き）
- `.claude/skills/`: 作業手順のスキル（`<名前>/SKILL.md`）
- `.claude/agents/`: サブエージェントの定義（`<名前>.md`）

開発ルールは [`CLAUDE.md`](./CLAUDE.md)、各ディレクトリの説明は [`.claude/README.md`](./.claude/README.md) を参照。

## 秘密情報の扱い

API キー・トークン・個人情報を、コード・コミット・issue・PR・チャットに書かないこと。
本番の秘密情報は `wrangler secret put <NAME>` で Cloudflare に設定します。
ローカル開発用の値は `.dev.vars`（`.gitignore` 済み）に置き、コミットしません。
