---
id: TASK-2
title: 却下からの復帰経路を用意する（誤却下の取り消しと、廃止と誤りの区別）
status: To Do
assignee: []
created_date: '2026-08-13 13:20'
labels:
  - 仕様変更
  - 承認フロー
dependencies: []
references:
  - packages/core/src/knowledge.ts
  - packages/mcp-server/src/server.ts
  - docker/db/init/001_schema.sql
documentation:
  - docs/業務知識基盤_設計記録.md
priority: medium
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## 現状

reject_knowledge は status を deprecated にし、needs_review を落とし、却下理由を review_notes に追記する。行は消さない。
その後、approve_knowledge / reject_knowledge / verify_knowledge の 3 つはいずれも deprecated を弾くため、status を approved に戻す手段が MCP 経由では存在しない。

一方 propose_update は status を見ないので、却下済みレコードでも本文と title は書き換えられる。

## 何が問題か（3 層ある）

1. 誤って却下したときに取り消せない。正規の手順の中に逃げ道がない
2. 正攻法とされる 新レコード + 後継エッジ も塞がっている。unique(context, type, title) に status が入っていないため、却下済みレコードが題名の枠を占有し続け、同じ題名では新規作成もできない。題名を変えて回避することはスキルの規約で禁じている
3. deprecated という終端が 1 つしかないため、意味の違う 2 つが同じ状態に潰れている
   - 誤り: 内容が間違っていた（reject_knowledge のツール説明はこの前提）
   - 廃止: 内容は正しかったが業務が変わって使われなくなった（設計記録の deprecated + 後継エッジ はこちら）
   deprecated に至る扉は reject（誤り）だけなので、廃止を表現する手段が無い。復帰の要否はこの区別に依存するため、ここを決めないと復帰の仕様も決まらない

## 付随して見つかった不具合

却下済みレコードに propose_update を掛けると needs_review が立つ。レビュー待ち一覧（pendingReviews）の条件は status = draft or needs_review で status による除外が無いため一覧に出るが、needs_review を落とせるのは承認・却下・検証の 3 つだけで、そのすべてが deprecated を弾く。結果としてレビュー待ちに居座り、降ろせなくなる。
2026-08-13 時点の実データでは未発生（deprecated 3 件・うち要レビュー 0 件）。

## 現状ある抜け道（手順として推奨しない）

propose_update で却下済みレコードの title をずらす → 一意制約の枠が空く → 同じ題名で新規 draft を作る → 承認する。MCP の中だけで復活できてしまうが、却下済みレコードの題名を汚し履歴が読みにくくなる。物理的に不可能なのではなく、正規の手順が無いという状態。

## 決めること

- 却下（誤り）と廃止（陳腐化）を状態として分けるか
- unique(context, type, title) と却下済みレコードの関係をどうするか（status を含める / 別の方法で題名の枠を空ける）
- 誤却下の取り消しを明示的な操作として持つか、新レコード + 後継エッジに寄せるか

## 関連

TASK-1（propose_update の即時反映）と同じく propose_update の status 無視に由来する。あわせて設計すると整合が取りやすい。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 誤って却下したレコードを、正規の手順で元に戻せる（または同じ題名で作り直せる）
- [ ] #2 「誤り」と「廃止」を分けるかどうかの判断と理由が docs/業務知識基盤_設計記録.md に残っている
- [ ] #3 却下済みレコードに対する propose_update の扱いが決まり、レビュー待ちに居座らないことがテストで固定されている
- [ ] #4 一意制約と却下済みレコードの関係が決まり、テストで固定されている
<!-- AC:END -->
