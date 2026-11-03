---
name: review-pr
description: PR を実装していない別のエージェント（Reviewer サブエージェント）にレビューさせ、issue の要件との対応・テスト結果・指摘をまとめて、人間がマージを判断できる形で返す。「/review-pr <PR 番号>」「この PR をレビューして」で使う。
---

# /review-pr <PR 番号>

開発ループの 3 段目（README「ループ 1」）。マージの判断は人間がするので、このスキルは **判断材料を揃えるところまで** で、マージはしない。

## 手順

1. PR の情報を取る: `gh api repos/hashibadaiki/kids-event-hub-open/pulls/<PR>`（本文・head ブランチ・`Closes #N`）と CI の状態 `gh api repos/hashibadaiki/kids-event-hub-open/commits/<head sha>/check-runs --jq '.check_runs[] | "\(.name) \(.conclusion)"'`
2. `reviewer` サブエージェントを起動し、PR 番号と issue 番号だけを渡す（実装時の会話や自分の見立ては渡さない。先入観なしで読ませるため）
3. Reviewer の結果を受け取り、次の形で返す

```
## PR #<番号>: <タイトル>（Closes #<issue>）
- CI: ✅ / ❌（失敗したジョブ名）
- Reviewer の判定: マージしてよい / 修正が必要 / オーナー判断が必要
- issue の要件との対応: ✅ n / ❌ n / 一部 n
- 重大な指摘: …
- 人間が見るべき点: …（migration・本番データ・運用ルール・オーナー作業）
```

4. ユーザーに頼まれたときだけ、指摘を PR にコメントする（本文の最後に Claude Code で生成した旨のフッターを付ける）
5. 「修正が必要」なら Implementer に直させてから再度 `/review-pr`。「オーナー判断が必要」ならマージせず、PR にその理由を書く
