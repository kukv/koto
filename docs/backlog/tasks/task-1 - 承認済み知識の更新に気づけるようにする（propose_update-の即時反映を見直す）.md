---
id: TASK-1
title: 承認済み知識の更新に気づけるようにする（propose_update の即時反映を見直す）
status: To Do
assignee: []
created_date: '2026-08-13 13:06'
labels:
  - 仕様変更
  - 承認フロー
dependencies: []
references:
  - packages/core/src/knowledge.ts
  - packages/mcp-server/src/server.ts
documentation:
  - docs/業務知識基盤_設計記録.md
priority: high
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## 現状

propose_update は対象の status を見ずに本文を即時置換する。needs_review は立つが status は approved のままなので、書き換えた瞬間から新しい本文が検索の既定結果に出る。確認ダイアログ（elicitation）も楽観ロックも無い。draft / approved / deprecated のいずれでも同じ UPDATE が走る。

実装: packages/core/src/knowledge.ts の proposeUpdate（MCP 層 packages/mcp-server/src/server.ts は english_name の書式検証のみ）

## 何が問題か

設計記録では 楽観方式（revisions で巻き戻せる）として意図的に選んだ形だが、運用してみると 人が気づけない ことが問題。needs_review はレビュー待ち一覧に出るだけの受動的な印で、レビューに着手するまで検出できない。その間も旧版ではなく新版が配られ続ける。

なお 承認済みには body を渡さず note だけで呼ぶ という運用は skills/koto-import の規約であって、サーバ側では強制していない。規約に頼っている点も含めて見直す。

## 検討の方向（未決定・要ブレスト）

- 承認まで旧版を見せる二重化（設計記録の Phase 2 課題として既出）
- 承認済みへの更新にも確認ダイアログを掛ける
- 更新が入ったら status を draft に戻し、検索の既定から外す
- 仕組みは変えず、更新が起きたことを能動的に知らせる経路だけ作る

## あわせて決めること

- draft / deprecated への更新をどう扱うか（deprecated は現状 status チェックが無く本文だけ書き換わる）
- 検証レベルの自動リセット（内容変更で none に戻る）との整合
- 既存レコードへの移行が要るか
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 承認済みレコードの本文が、人が気づかないまま検索の既定結果に出る状態が解消されている
- [ ] #2 採用しなかった方式とその理由が docs/業務知識基盤_設計記録.md に追記されている
- [ ] #3 draft / approved / deprecated それぞれへの更新の扱いが決まり、テストで固定されている
- [ ] #4 skills/koto-import の再取り込み規約が新しい仕様と矛盾しないよう更新されている
<!-- AC:END -->
