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

（TODO）検索サイト、MCP サーバーの使い方。

### 収集元の管理

収集元は [`sources.yaml`](./sources.yaml) で管理し、同期コマンドで D1 の `sources` テーブルに反映します（正は D1）。

```sh
pnpm sync-sources --dry-run   # 検証と計画の表示のみ
pnpm sync-sources             # ローカル D1 に反映
pnpm sync-sources --remote    # 本番 D1 に反映（オーナーのみ）
```

- ファイルの行は `submitted_by = owner` / `status = approved` で upsert。クローラーは approved・有効・policy が ng でない行だけを対象にします
- ファイルから消した行は削除せず無効化（`enabled = false`）。owner 以外の入口から入った行は触りません
- Claude Code では `/add-source <URL>` で robots.txt・利用規約の確認 → 追記 → 同期まで行います

### 検索サイト

ログイン不要・モバイル向けの SSR ページ。URL は固定で、そのまま共有できます。

| URL | 内容 |
| --- | --- |
| `/` | 都道府県一覧（イベントがある県だけ） |
| `/kagawa/2026-11-08` | 香川県で 2026-11-08 に開催中のイベント |
| `/kagawa?from=2026-11-01&to=2026-11-30` | 期間で絞り込み（未指定は今日から 30 日間、最大 92 日） |
| `?age=5` | 対象年齢で絞り込み（0〜18。年齢の記載がないイベントは残す） |
| `/events/123` | イベント詳細（掲載元ページ / PDF チラシへのリンク） |

### MCP サーバー（Claude から検索する）

検索サイトと同じデータを、MCP（Model Context Protocol）のツールとして提供します。**検索のみ**で、書き込み系のツールはありません。認証は不要です。

- エンドポイント: `https://kids-event-hub.hashiba-baan-daiki.workers.dev/mcp`（Streamable HTTP。ステートレスで、POST に JSON で応答します）
- ツール:

| ツール | 引数 | 返すもの |
| --- | --- | --- |
| `search_events` | `prefecture`（必須。「香川県」「香川」「kagawa」）、`from` / `to`（JST の `YYYY-MM-DD`。省略時は今日から 30 日間、最大 92 日）、`age`（0〜18）、`keyword`（タイトル・概要・会場・市町村の部分一致、空白区切りで AND）、`limit`（1〜50、既定 20） | 期間中に開催中のイベント（開始日時順）。日時・会場・対象年齢・料金・詳細ページ URL・掲載元 URL。今日の日付 `today` も返す |
| `get_event` | `id`（`search_events` の結果の id） | イベントの全項目 |

**Claude Code** から:

```sh
claude mcp add --transport http kids-event-hub https://kids-event-hub.hashiba-baan-daiki.workers.dev/mcp
```

**Claude Desktop / claude.ai** から: 設定 → コネクタ → 「カスタムコネクタを追加」で、上の URL を入力します。
コネクタを追加できない環境では、`claude_desktop_config.json` に [mcp-remote](https://www.npmjs.com/package/mcp-remote) 経由で登録します（Node.js が必要）。

```json
{
  "mcpServers": {
    "kids-event-hub": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://kids-event-hub.hashiba-baan-daiki.workers.dev/mcp"]
    }
  }
}
```

あとは Claude に「今週末の香川の子供向けイベント教えて」と聞くと、`search_events` で探して答えます。デモの流れは [`docs/mcp-demo.md`](./docs/mcp-demo.md)。
ローカルで試すときは `wrangler dev` を起動し、URL を `http://localhost:8787/mcp` にします。

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
