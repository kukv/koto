# CLAUDE.md

Koto — 業務知識基盤。ユビキタス言語(言 = term)と業務イベント(事 = event)を中央DBに蓄積し、MCP 経由で AI エージェントに参照・還流させる。

設計の背景・決定の経緯は必ず `docs/業務知識基盤_設計記録.md` を読むこと。本書はその要約ではなく、作業時の規約のみ記す。

## コマンド

```bash
docker compose up -d --build   # DB 起動(PGroonga + pgvector、初回スキーマ自動適用)
pnpm install                   # パッケージ管理は pnpm(npm は使わない)
pnpm run build                 # 全パッケージを依存順にビルド(実行前に必須)
pnpm run typecheck             # build + テストコードの型検査。変更後は必ず通すこと
pnpm test                      # vitest 実行(要 docker compose up -d。koto_test を作り直して単体+DB統合を検証)
pnpm run mcp                   # MCP サーバ(stdio)起動
pnpm --filter @kukv/koto-mcp run bundle   # 配布用の単一ファイル koto-mcp.mjs を生成(要 pnpm run build)
pnpm --filter @kukv/koto-mcp run smoke    # 生成したバンドルの起動確認(ツール一覧が返るか)
```

## 構成

- `docker/db/init/001_schema.sql` — スキーマ。変更は `docker/db/migrations/` に番号順で追加(既存マイグレーションは変更しない)
- `packages/tsconfig/` — 共有 tsconfig(@kukv/koto-tsconfig)。各パッケージが extends で参照
- `packages/core/` — 共有ドメイン層(@kukv/koto-core)。propose / 承認 / 重複検出 / RRF ハイブリッド検索
- `packages/mcp-server/` — MCP ツール11本の定義(@kukv/koto-mcp)
- `skills/koto-import/` — エージェント対話での文書インポート手順(主経路。抽出規約はここが正。`.claude/skills/` からシンボリックリンクで参照)
- `skills/koto-code-import/` — コード起点のインポート手順(規約は koto-import の `references/` を symlink で共有)

## 規約

- **名前は koto に統一**: MCP サーバ名・MCP 登録名は `koto`。npm パッケージは `@kukv/koto-*`
- **1概念 = 1レコード**: RAG 的な機械的チャンク分割はしない
- **エージェントの書き込みは必ず draft**: `status=draft` + `needs_review=true` で入れる。approved に直接入れない。承認系ツール(`approve_knowledge` / `reject_knowledge` / `verify_knowledge`)は elicitation でユーザーの確認を必ず取る — この確認を迂回する実装を入れない
- **物理削除しない**: 廃止は `deprecated` + 後継エッジ。履歴は revisions トリガが自動保存
- **コト(event)中心**: event の本文は「概要 / アクター / 対象 / 事前条件 / 事後条件 / 取消・失敗 / 順序・タイミング」の定型見出し
- **イベントソーシングを安易に提案しない**: コト中心の知識化と実装方式としてのイベントソーシングは別物
- **日本語検索は PGroonga 前提**: Postgres 標準の tsvector は日本語に実用不可。検索関連の変更時は注意
- **初期構成は課金ゼロ**: 埋め込みは `EMBEDDING_PROVIDER=openai` の明示オプトイン。デフォルトはキーワード検索のみ。API キー必須の機能をデフォルト経路に置かない
- **サプライチェーン設定**: `pnpm-workspace.yaml` の supply-chain 設定(minimumReleaseAge 等)を勝手に緩めない
