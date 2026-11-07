# .claude/

このリポジトリで Claude Code を使うための設定一式。開発と運用を Claude Code 中心の **ソフトウェアファクトリー** として回すための部品で、開発で Claude をどう使ったかを見せるため **リポジトリにそのまま残します**。全体像（ループの図と人間のチェックポイント）はルートの [README「Claude Code をソフトウェアファクトリーとして回す」](../README.md#claude-code-をソフトウェアファクトリーとして回す) を参照。

| 置き場所 | 中身 |
| --- | --- |
| `settings.json` | プロジェクト共通の Claude Code 設定（フックの登録）。個人設定は `settings.local.json`（コミットしない） |
| `hooks/` | フックのスクリプトとそのテスト（`*.test.mjs`、`pnpm test:claude` で実行） |
| `skills/<名前>/SKILL.md` | 繰り返す作業手順をまとめたスキル |
| `agents/<名前>.md` | 役割を絞ったサブエージェントの定義 |
| `../.mcp.json` | Claude Code から使う MCP サーバー（このサービスの検索ツール） |

## サブエージェント（`agents/`）

| 名前 | ループ | 役割 | 書き込み |
| --- | --- | --- | --- |
| `planner` | 開発 | issue → ゴールの言い直し・作業分割・先に書くテスト | しない |
| `implementer` | 開発 | issue-<番号> ブランチで TDD 実装 → PR 作成（マージはしない） | する |
| `reviewer` | 開発 | 実装を見ていない立場で差分・テスト・要件との対応を確認 | しない |
| `improver` | 運用 | 品質の低い収集元の抽出設定の改善案を 1 つ出す | しない |
| `verifier` | 運用 | 保存済みデータで新旧を再抽出・採点し、auto / human / reject を判定 | しない |

レビュー役・検証役は書き込みツールを持たせていません（作った本人と別の目で見るため。`hooks/project-config.test.mjs` で確認）。

## スキル（`skills/`）

| コマンド | 内容 |
| --- | --- |
| `/add-source <URL>` | robots.txt・規約を確認して `sources.yaml` に追加 → ローカル D1 に同期 → 初回クロール → PR をマージ → 本番 D1 に同期・クロール → 品質 0.95 を超えるまで `pnpm improve-prod`。途中でオーナーに質問しない |
| `/crawl <source>` | 収集元を 1 件ローカルでクロールし、件数・日付取得数・品質スコア・失敗理由を報告 |
| `/improve <source>` | Improver → Verifier → 自動採用 / **人間の承認** / 却下 → `docs/improvement-log.md` に記録 |
| `/review-pr <PR>` | Reviewer サブエージェントにレビューさせ、人間がマージを判断できる形にまとめる |

## フック（`hooks/`）

| フック | イベント | 内容 |
| --- | --- | --- |
| `guard-bash.mjs` | PreToolUse / Bash | `CLAUDE.md` の「やらないこと」を機械的に止める: `wrangler deploy` / `login` / `secret put` / リソース作成（`d1 create` など）/ `--remote` 付きの D1 操作、`main` への直接 push。止めたときは理由を Claude に返し、Claude は PR 本文の「オーナー作業」に書いて先に進む |
| `pre-commit-check.mjs` | PreToolUse / Bash | `git commit` の前に `pnpm typecheck && pnpm lint && pnpm test` を走らせ、失敗したらコミットを止める（出力の末尾を Claude に返す）。チェックはコミットするリポジトリ（worktree）のルートで走らせる: 入力の `cwd` にコマンド先頭の `cd <path> &&` を適用した場所から `git rev-parse --show-toplevel` で求める |
| `migration-notice.mjs` | PostToolUse / Edit・Write | `packages/db/src/schema.ts`・`migrations/` を変えたら注意事項を Claude に返す（`pnpm generate`、本番データへの影響、migration 番号の競合、`--remote` の適用はオーナー作業） |
| `guard-pr.mjs` | PreToolUse / Bash・GitHub MCP | PR 作成時に本文の `Closes #<番号>` を確認（なければ止める）。PR マージの前は止めずに **チェックリストを Claude に渡す**（CI・要件・レビュー指摘・運用ルール/本番への影響）。要件を変える・緩める PR、運用ルール・本番データに影響する PR は Claude がマージせずオーナーに回す |

## MCP

`../.mcp.json` に本番の検索 MCP サーバー（`search_events` / `get_event`、#10）を登録しています。リポジトリを Claude Code で開くと、初回に有効化の確認が出ます。ローカルの `wrangler dev` に向けたいときは `claude mcp add --transport http kids-event-hub-local http://localhost:8787/mcp`。
