# .claude/

このリポジトリで Claude Code を使うための設定一式。開発で Claude をどう使ったかを見せるため、**リポジトリにそのまま残します**。

| 置き場所 | 中身 |
| --- | --- |
| `settings.json` | プロジェクト共通の Claude Code 設定（フックの登録など）。個人設定は `settings.local.json`（コミットしない） |
| `hooks/` | フックのスクリプトとそのテスト（`*.test.mjs`、`pnpm test` で実行） |
| `skills/<名前>/SKILL.md` | 繰り返す作業手順をまとめたスキル |
| `agents/<名前>.md` | 役割を絞ったサブエージェントの定義 |

## フック

- `hooks/guard-bash.mjs`（PreToolUse / Bash）: `CLAUDE.md` の「やらないこと」を機械的に止める。
  - `wrangler deploy` / `login` / `secret put` / リソース作成（`d1 create` など）/ `--remote` 付きの D1 操作
  - `main` への直接 push
  - 止めたときは理由を Claude に返し、Claude は PR 本文の「オーナー作業」に書いて先に進む。
