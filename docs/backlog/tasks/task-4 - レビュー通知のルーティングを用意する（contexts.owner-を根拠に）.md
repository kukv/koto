---
id: TASK-4
title: レビュー通知のルーティングを用意する（contexts.owner を根拠に）
status: To Do
assignee: []
created_date: '2026-08-13 13:35'
labels:
  - Phase2
  - 承認フロー
dependencies: []
documentation:
  - docs/業務知識基盤_設計記録.md
priority: low
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## 位置づけ

Phase 2（チーム共有）への申し送り。承認者 1 人の実験段階では実害が無いため、今は着手しない。

## 現状

contexts.owner（承認責任者）は次の 2 か所に出るだけで、通知の経路は無い。

- 承認・却下・検証の確認ダイアログに表示（未設定なら警告。実行は止めない）
- list_contexts の一覧

設計記録 2.5 は owner を「Phase 2 のレビュー通知ルーティング（Slack 等）の根拠になる」と位置づけているが、その通知側が存在しない。draft がいくら溜まっても、誰にも届かない。

## 決めること

- owner の値の持ち方。現在は部署・ロールの自由記述（例: 営業企画部）で、Slack のチャンネルやユーザーには解決できない。通知先へ写像する層が要るか、owner 自体を識別子に寄せるか
- 通知のきっかけ（draft 投入のたび / 一定件数たまったら / 定期）
- expert（外部専門家の種別）をどう扱うか。社内の通知先が存在しない
- 通知の担い手。MCP サーバは stdio で常駐しないため、通知を出す主体が別に要る（Phase 2 でリモート化するならそこに載る）

## 前提

Phase 2 では DB を Supabase / RDS へ、MCP を HTTP + OAuth のリモートへ移す想定。この移行とセットで設計する。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 owner の値から通知先を決められる形になっている
- [ ] #2 通知のきっかけと担い手が決まっている
<!-- AC:END -->
