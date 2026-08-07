# CLAUDE.md

Koto — 業務知識基盤。ユビキタス言語(言 = term)と業務イベント(事 = event)を中央DBに蓄積し、MCP 経由で AI エージェントに参照・還流させる。

設計の背景・決定の経緯は必ず `docs/業務知識基盤_設計記録.md` を読むこと。本書はその要約ではなく、作業時の規約のみ記す。

## コマンド

```bash
docker compose up -d --build   # DB 起動(PGroonga + pgvector、初回スキーマ自動適用)
pnpm install                   # パッケージ管理は pnpm(npm は使わない)
pnpm run typecheck             # tsc --noEmit。変更後は必ず通すこと
pnpm run mcp                   # MCP サーバ(stdio)起動
pnpm run import --context <ctx> <files...>   # 文書 → 知識候補(draft)抽出
pnpm run review list|show|approve|verify|reject   # レビュー CLI
```

## 構成

- `db/init/001_schema.sql` — スキーマ。変更は `db/migrations/` に番号順で追加(既存マイグレーションは変更しない)
- `src/knowledge.ts` — propose / 承認 / 重複検出の中核
- `src/search.ts` — PGroonga + pgvector の RRF ハイブリッド検索
- `src/mcp-server.ts` — MCP ツール8本の定義
- `src/import/` — Claude API による文書からの知識抽出

## 規約

- **名前は koto に統一**: package 名・MCP サーバ名・MCP 登録名はすべて `koto`
- **1概念 = 1レコード**: RAG 的な機械的チャンク分割はしない
- **エージェントの書き込みは必ず draft**: `status=draft` + `needs_review=true` で入れる。approved に直接入れない
- **物理削除しない**: 廃止は `deprecated` + 後継エッジ。履歴は revisions トリガが自動保存
- **コト(event)中心**: event の本文は「概要 / アクター / 対象 / 事前条件 / 事後条件 / 取消・失敗 / 順序・タイミング」の定型見出し
- **イベントソーシングを安易に提案しない**: コト中心の知識化と実装方式としてのイベントソーシングは別物
- **日本語検索は PGroonga 前提**: Postgres 標準の tsvector は日本語に実用不可。検索関連の変更時は注意
- **サプライチェーン設定**: `pnpm-workspace.yaml` の supply-chain 設定(minimumReleaseAge 等)を勝手に緩めない
