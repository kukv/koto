---
id: TASK-3
title: 承認・検証で消える情報の受け皿を決める（review_notes の役割分離）
status: To Do
assignee: []
created_date: '2026-08-13 13:30'
labels:
  - 仕様変更
  - 承認フロー
dependencies: []
references:
  - packages/core/src/knowledge.ts
  - packages/mcp-server/src/server.ts
documentation:
  - docs/フィードバック_2026-08-10_mindstock承認作業.md
  - docs/業務知識基盤_設計記録.md
priority: medium
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## 現状

approve() と setVerification() は review_notes = null を実行する。一部だけ残す指定は無い。
review_notes には 4 種類が混在している。

| 入る内容 | 性質 | 承認・検証で |
|---|---|---|
| 要確認事項（propose 時にエージェントが書く） | 未解決 | 消える（意図どおり） |
| 重複候補（自動検出） | 未解決 | 消える（統合判断が済んだ前提） |
| 更新提案のメモ（propose_update が追記） | 記録 | 消える ← 問題 |
| 却下理由（reject が追記） | 記録 | 消えない（deprecated は承認を弾くため） |

## 経緯

docs/フィードバック_2026-08-10_mindstock承認作業.md の 4.1 と 3.3 の積み残し。

- 4.1「承認しても要確認が消えない」→ PR #29 でクリアする対応を入れた
- 3.3「review_notes が複数の役割を兼ねている。未解決の確認事項とレビュー履歴を分けるべき」→ 優先度表で「4.1 を直せば緩和される」として見送られ、分離は行われていない

結果として、分けないままクリアだけが入った状態になっている。

## 何が問題か

1. propose_update の note（なぜ変更するのか）は記録なのに、その更新を承認した時点で消える
2. 受け皿とされる verified_note は追記ではなく置換。ツール説明は「既存の内容を引き継いで書くこと」と指示しているが、エージェントの手作業に依存しており、忘れれば消える
3. 消えた内容は knowledge_revisions に残るが、MCP ツール 11 本に履歴を読むものが無く、get_knowledge も返さない。DB を直接見ない限り取り出せないため、運用上は消えたのと変わらない

## 決めること

- 未解決の確認事項と記録を別の欄に分けるか、review_notes のまま運用するか
- verified_note を置換のままにするか、追記にするか（引き継ぎを人・エージェントの手作業に頼り続けるか）
- 履歴（knowledge_revisions）を読む経路を MCP に用意するか

## 関連

TASK-1（propose_update の即時反映）と同じく propose_update 由来。更新の扱いを決めると、その note をどこに残すかも同時に決まる。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 更新理由（propose_update の note）が、承認後も正規の手順で辿れる
- [ ] #2 未解決の確認事項と記録の切り分け方が決まり、判断の理由が docs/業務知識基盤_設計記録.md に残っている
- [ ] #3 verified_note の引き継ぎがエージェントの手作業に依存しない形になっている（依存し続ける判断をした場合はその理由が残っている）
- [ ] #4 承認・検証で何が消えて何が残るかがテストで固定されている
<!-- AC:END -->
