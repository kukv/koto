---
id: TASK-7
title: 埋め込みの有効化を気づけるもの・効くものにする（静かな縮退とバックフィル）
status: To Do
assignee: []
created_date: '2026-08-13 13:55'
labels:
  - 検索
  - 運用
dependencies: []
references:
  - packages/core/src/embeddings.ts
  - packages/core/src/search.ts
  - packages/core/src/knowledge.ts
documentation:
  - docs/業務知識基盤_設計記録.md
priority: medium
ordinal: 7000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## 現状

EMBEDDING_PROVIDER の既定は none（課金ゼロ構成、設計記録 2.9）。無効時は近似重複の検出が同名・別名・english_name の完全一致だけになり、検索もキーワードのみになる。

これ自体は意図されたトレードオフで、補償策とセットになっている。english_name を title の英訳 = 概念の同一性キーに再定義（2026-08-10）したことで、埋め込みなしでも context 横断の同義語を文字列一致で検出できる。すり抜ける英訳のゆれ（resident / inhabitant）は、取り込み手順（英訳を発明する前に既存語彙を検索する）と棚卸しで拾う 3 段構え。

問題はその下にある 2 つ。

## 問題 1: 縮退が静か

packages/core/src/embeddings.ts の embed() は、次の 3 経路すべてで黙って null を返す。

1. EMBEDDING_PROVIDER=openai にしても OPENAI_API_KEY が無ければ null。警告が無く、有効にしたつもりで無効のまま動く
2. API がエラーを返しても標準エラーに 1 行出るだけで propose_knowledge は成功する。結果その 1 件だけ embedding が null のまま残り、再試行も無い
3. 検索側も、クエリの埋め込みに失敗すると黙ってキーワードのみに落ちる

## 問題 2: バックフィルの経路が無い

embedding が計算されるのは propose と propose_update のときだけ。後から有効化しても既存レコードは null のまま残る。

- ベクトル検索の CTE は embedding is not null で絞るため、既存レコードはキーワード側からしか出てこない
- 重複検出の類似度比較も埋め込みを持つ行から上位 3 件を見るので、既存レコードは比較対象に入らない

つまり後から有効化すると、その時点より前の知識だけが虫食いで抜けた状態になる。

## タイミングの論点

知識を一から入れ直す方針（2026-08-12）なので、入れ直す前に有効化するかを決めればバックフィル自体が不要になる。逆に無効のまま入れ直してから有効化するなら、バックフィルの経路が要る。

## 決めること

- 起動時に設定の整合（provider が openai なのにキーが無い等）を検証して警告するか
- 埋め込みの生成に失敗したときの扱い。propose を失敗させるか、印を付けて後から拾えるようにするか
- バックフィルの経路（全件再計算のコマンド、または埋め込み欠落の検出）
- 次元の固定。vector(1536) は列定義に固定で、ローカルモデル（bge-m3 は 1024 次元）に替えるならマイグレーションが要る
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 有効にしたつもりで無効になっている状態に気づける
- [ ] #2 埋め込みの生成に失敗したレコードを後から特定して埋められる
- [ ] #3 後から有効化したときに既存レコードもベクトル検索と重複検出の対象になる（またはバックフィル不要な運用として判断と理由が残っている）
- [ ] #4 上記がテストで固定されている
<!-- AC:END -->
