# デモ: Claude に「今週末の香川の子供向けイベント教えて」と聞く

MCP サーバー（`/mcp`、#10）を使い、Claude が検索サイトと同じデータから答える場面。

## 準備

1. Claude に MCP サーバーを登録する（README「MCP サーバー」の手順）
   - Claude Code: `claude mcp add --transport http kids-event-hub https://kids-event-hub.hashiba-baan-daiki.workers.dev/mcp`
   - Claude Desktop / claude.ai: 設定 → コネクタ → カスタムコネクタに同じ URL
2. 本番 D1 に香川県のイベントが入っていること（収集元の登録とクロールは #7 / #8 / #14）。
   データがない週末だと「見つかりませんでした」になるので、事前に検索サイトの `/kagawa?from=<土曜>&to=<日曜>` で件数を確認しておく

## 流れ

| # | 人 / Claude | 内容 |
| --- | --- | --- |
| 1 | 人 | 「今週末の香川の子供向けイベント教えて。5 歳の子がいます」 |
| 2 | Claude | 接続時の案内（`instructions`）にある今日の日付から週末の土日を出し、`search_events` を呼ぶ: `{"prefecture": "香川", "from": "<土曜>", "to": "<日曜>", "age": 5}` |
| 3 | サーバー | 期間中に開催中のイベントを開始日時順で返す。対象年齢は「5 歳が入る」か「記載なし」のもの。各イベントに `when`（例: 11月7日(土) 10:00〜11:00）・会場・料金・掲載元 URL・`from_pdf`（PDF チラシ由来か） |
| 4 | Claude | 日付ごとに一覧で答え、掲載元での確認を促す。PDF チラシ由来のものはそう伝える |
| 5 | 人 | 「工作できるのはある？」 |
| 6 | Claude | `search_events` に `keyword: "工作"` を足して再検索、または `get_event` で詳細を確認して答える |

見せたい点:

- 自治体の PDF チラシにしか載っていなかったイベントが、日付・場所・対象年齢つきで Claude から引ける（`from_pdf: true`）
- MCP は検索のみ。投稿・編集のツールはない

## 確認方法（ネットワークなし）

`apps/web/test/mcp.test.ts` の「デモ: 『今週末の香川の子供向けイベント』」が、この流れのツール呼び出しと結果の形をテストしている。
