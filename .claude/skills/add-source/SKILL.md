---
name: add-source
description: 収集元（自治体・公共施設・子供向け施設のイベントページや PDF チラシの URL）を sources.yaml に追加し、ローカル D1 に同期して初回クロールし、品質が低ければ /improve まで回して PR を作る。オーナーには途中で質問しない。「/add-source <URL>」「この URL を収集元に追加して」と言われたときに使う。
---

# /add-source <URL>

収集元を `sources.yaml` に追加し、ローカルでクロールして品質を確かめ、PR にする。正は D1 の `sources` テーブルで、`sources.yaml` はオーナー用の入口。

## 原則: オーナーに聞かない

途中でオーナーに質問しない。迷ったら下の「判断の基準」で自分で決め、決めた内容と理由を PR 本文の「迷った点」に書く。オーナーは後から PR で直せる。

オーナーに頼むのは、ガードで止められる操作（本番 D1 への反映など）だけ。それも質問はせず、PR 本文の「オーナー作業」に書く。

## 判断の基準

| 迷う点 | 決め方 |
|---|---|
| policy が caution（規約ページが見つからない・記述が曖昧） | caution で登録する。低頻度・連絡先付き UA・本文は転載せず要約と元 URL のみ、で扱う |
| policy が ng（robots.txt の Disallow、規約での明示的な禁止） | 登録しない。理由と根拠 URL を報告して終わる。ng だけは自分で覆さない |
| 渡された URL がトップページ・施設紹介ページ | ページ内のリンクからイベント一覧（「イベント」「催し」「お知らせ」など）を探す。件数がいちばん多く、イベントが中心の一覧を登録する |
| 一覧が「すべて」と「イベントだけ」に分かれている | 「すべて」を登録する。お知らせ（営業案内・休館日など）は抽出で落とす。落ちなければ 8 の改善で直す |
| 一覧が複数ある（月別・カテゴリ別など） | 当月から先が 1 ページで見えるものを選ぶ。1 ページで足りなければ複数行に分けて登録する |
| 民間施設（テーマパーク・商業施設など） | 子供向けのイベントを定期的に載せていれば登録する |
| 複数の都道府県に施設がある運営元 | 渡された URL のホストが扱う施設だけを登録する。他県の施設が別サイトなら、報告に書くだけにする |
| 都道府県 | ページの住所・電話番号の市外局番・自治体名から決める |
| type | JSON-LD（schema.org Event）があれば `jsonld`。iCal / RSS があればそちらの URL と種別にする。PDF 直リンクは `pdf`。HTML の一覧に PDF チラシが並ぶなら `pdf`、それ以外は `html` |

## 手順

1. **重複確認**: `sources.yaml` に同じ URL がないか確認する。末尾スラッシュや http / https の違いは同じ URL とみなす。あれば追加せず、その行を報告して終わる。

2. **作業場所**: CLAUDE.md の手順どおり、`origin/main` から worktree を作る（ブランチ名は `add-source-<施設名の英字>` など）。以降の同期とクロールは worktree の中で行う。worktree のローカル D1 は空から始まる。

3. **ページの下見**: URL のページを読み、上の「判断の基準」で登録する URL・名前・都道府県・type を決める。

4. **robots.txt と利用規約の確認**（CLAUDE.md「収集の方針」）
   - `pnpm check-policy <URL>` を実行する。robots.txt の判定・規約ページの候補・提案（ok / caution / ng）と `policy:` の YAML が出る。`ANTHROPIC_API_KEY` がなければ規約は未判定で caution の提案になるので、規約ページを自分で読んで判定する
   - 規約ページの候補が出なければ、フッターから「サイトポリシー」「利用規約」「著作権」「免責事項」を探して読む
   - 判定（`ok` / `caution` / `ng`）は上の表の基準で自分で確定する
   - 根拠（robots.txt の該当行、規約ページの URL と要約）を `policy.note` に短く書く。本文を長く引用しない

5. **`sources.yaml` に追記**（`sources:` の末尾に追加し、既存の行は並べ替えない）

   ```yaml
     - name: 高松市こども未来館 イベント情報
       url: https://example.jp/events/
       prefecture: 香川県
       type: html
       note: 一覧の形・更新頻度・他県の施設は別サイト、など
       policy:
         status: ok
         checked_at: "YYYY-MM-DD"
         note: robots.txt に禁止なし。サイトポリシー https://example.jp/policy に自動取得の禁止なし
   ```

6. **同期（ローカル D1）**
   - `cd apps/web && pnpm exec wrangler d1 migrations apply kids-event-hub --local`（空の D1 なので先に適用する）
   - `pnpm sync-sources --dry-run` で、エラーがなく今回の行が追加に入っていることを確かめる。空の D1 なので全行が追加と出るのは正常
   - `pnpm sync-sources` で反映する

7. **初回クロール（今回の行だけ）**
   - 以下 `d1 "<SQL>"` は `cd apps/web && pnpm exec wrangler d1 execute kids-event-hub --local --command "<SQL>"` のこと
   - 空の D1 に全収集元が入っている。他サイトに余計なアクセスをしないよう、今回の行以外をローカル D1 で止める: `d1 "UPDATE sources SET enabled = 0 WHERE url != '<登録した URL>'"`
   - HTML / PDF / LLM 抽出には `ANTHROPIC_API_KEY` が要る。worktree には `apps/crawler/.dev.vars` がないので、メインのチェックアウトの同じファイルを worktree にコピーする（中身は読まない・表示しない）。メイン側にもなければクロールを飛ばし、PR の「オーナー作業」に書く
   - `cd apps/crawler && pnpm dev` をバックグラウンドで起動し、`curl "http://localhost:8787/__scheduled?cron=0+18+*+*+*"` で Cron を起動する
   - `d1 "SELECT * FROM crawl_runs ORDER BY id DESC LIMIT 1"` の status が success / partial / failed になるまで待つ。そのあと `d1 "SELECT title, start_at, end_at, venue, age_min, age_max FROM events ORDER BY start_at"` で中身を見る
   - 終わったらクローラーを止める

8. **結果の評価と改善**: 下のどれかに当たれば直し、7 のクロールを取り直す。同じサイトへのクロールは、取り直しを含めて 3 回まで
   - **取れた件数が 0・失敗**: エラーと取得したページを見る。URL か type が原因なら `sources.yaml` を直す（別の一覧ページ、RSS / iCal、PDF など）
   - **品質スコアが 0.7 未満**: `/improve <収集元 ID>` を回す。Verifier の判定が `auto` なら採用し、`reject` なら却下する。`human` は採用も却下もせず候補のまま残し、前後比較を PR の「迷った点」に書く（オーナーへの質問はしない）
   - **スコアは 0.7 以上でも中身がおかしい**: イベントでないもの（営業案内・休館日など）が混ざる、日付が一覧と合わない、などの場合は `/improve` を回す。年齢や料金が取れていないだけなら、PR に書くだけにする
   - 原因が収集元に固有でなく抽出の仕組みの穴（日付の書式に対応していない、など）なら、ここでは直さない。PR に書き、汎用の修正として issue にする

9. **チェックと PR**
   - `pnpm typecheck && pnpm lint && pnpm test`
   - コミットして push し、PR を作る。PR 本文は Write で一時ファイルに書いて `--body-file` で渡す
   - PR 本文に書くこと: 追加した行、policy の判定と根拠、クロール結果（抽出数・日付あり・保存数・品質スコア・取れたイベントの例）、改善を回したならその前後、迷った点と自分の決め方、オーナー作業（マージ後に本番 D1 へ `pnpm sync-sources` を remote 指定で実行）
   - push したら worktree を削除する

10. **報告**: PR の URL と、PR 本文の要点を短く伝える。
