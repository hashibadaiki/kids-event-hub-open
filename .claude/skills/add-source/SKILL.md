---
name: add-source
description: 収集元（自治体・公共施設のイベントページや PDF チラシの URL）を sources.yaml に 1 行追加し、D1 に同期して初回クロールする。「/add-source <URL>」「この URL を収集元に追加して」と言われたときに使う。
---

# /add-source <URL>

収集元を `sources.yaml` に追加して D1 に反映する。正は D1 の `sources` テーブルで、`sources.yaml` はオーナー用の入口。

## 手順

1. **重複確認**: `sources.yaml` に同じ URL がないか確認する。あれば追加せず、その行を見せて終わる。

2. **robots.txt と利用規約の確認**（CLAUDE.md「収集の方針」）
   - `<origin>/robots.txt` を取得し、対象パスが `Disallow` されていないか見る
   - サイトの利用規約・サイトポリシー・著作権のページを探して、自動取得や転載についての記述を読む
   - 判定:
     - `ok`: 禁止の記述がない
     - `caution`: 記述が曖昧。低頻度・連絡先付き UA・本文は転載せず要約と元 URL のみ、で進める
     - `ng`: 明示的に禁止されている → **`sources.yaml` には追加しない**。理由と根拠 URL をユーザーに伝えて終わる
   - 根拠（robots.txt の該当行、規約ページの URL と要約）を `policy.note` に短く書く。本文を長く引用しない

3. **項目を決める**
   - `name`: ページのタイトルや施設名から（例: 「高松市こども未来館 イベント情報」）
   - `prefecture`: 都道府県の正式名（例: 香川県）。URL やページの住所から判断し、わからなければユーザーに聞く
   - `type`: `jsonld` / `ical` / `rss` / `html` / `pdf` / `llm`。ページに JSON-LD（schema.org Event）があれば `jsonld`、iCal / RSS のリンクがあればそちらの URL と種別を提案する。PDF 直リンクなら `pdf`。迷ったら省略（URL から推測される）
   - `note`: 更新頻度などのメモ（任意）

4. **`sources.yaml` に追記**（`sources:` の末尾に 1 行分。既存の行は並べ替えない）。`sources: []` のままなら `sources:` にして配列で書く

   ```yaml
     - name: 高松市こども未来館 イベント情報
       url: https://example.jp/events/
       prefecture: 香川県
       type: html
       policy:
         status: ok
         checked_at: "YYYY-MM-DD"
         note: robots.txt に禁止なし。サイトポリシー https://example.jp/policy に自動取得の禁止なし
   ```

5. **同期**
   - `pnpm sync-sources --dry-run` で検証し、追加 1 件になることを確認する（エラーなら直す）
   - `pnpm sync-sources` でローカル D1 に反映する。ローカル D1 に migration がなければ先に `cd apps/web && pnpm exec wrangler d1 migrations apply kids-event-hub --local`
   - **本番 D1 への反映（`pnpm sync-sources --remote`）はオーナー作業**。自分では実行せず、コマンドをユーザーに伝える

6. **初回クロール**
   - クローラー（#7）の実装後: 追加した収集元だけを対象にローカルでクロールし、取れた件数・日付が取れた件数・失敗を報告する
   - 未実装のうちは「初回クロールは #7 の実装後」と伝えて終わる

7. **報告**: 追加した行、policy の判定と根拠、同期結果、オーナーに頼むこと（`pnpm sync-sources --remote`）をまとめる。変更は issue のブランチでコミットする（`main` に直接 push しない）
