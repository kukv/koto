# テスト基盤導入 設計

日付: 2026-08-08
ステータス: 承認済み

## 背景と目的

koto にはテストが存在しない。ロジックの中核は `src/knowledge.ts` / `src/search.ts` の SQL(PGroonga + pgvector 前提)にあるため、DB を使わない単体テストだけでは価値が薄い。DB 統合テストを含むテスト基盤を導入する。

## 決定事項

- **テストランナー**: Node 24 組み込みの `node:test` + `node:assert`。tsx 経由で TypeScript を直接実行する(`node --import tsx --test`)。**新規依存はゼロ**。
  - 理由: `pnpm-workspace.yaml` の厳格なサプライチェーン設定(minimumReleaseAge / strictDepBuilds 等)と整合し、監査対象を増やさない。この規模(約 830 行)なら DX の差は許容範囲。Vitest への将来移行もテスト構造(describe/it/assert)が同型のため低コスト。
- **DB 統合テスト**: 既存 compose の db コンテナ(PGroonga + pgvector)をそのまま使い、テスト専用データベース `koto_test` を作成して実行する。開発 DB(`koto`)には触れない。
- **外部 API**: テスト実行時は `EMBEDDING_PROVIDER=none` とし、埋め込みなし(キーワード検索のみ)の経路を統合テストする。OpenAI / Anthropic への fetch は単体テストでモックする。
- **CI**: 別ブランチで構築中のため今回は含めない。「compose で DB 起動 → `pnpm test`」の 2 ステップで CI から呼べる形にしておく。

## 構成

```
tests/
  helpers/
    setup-db.ts      # koto_test を drop→create し、001_schema.sql を適用
    db.ts            # テスト用 pool と truncate ヘルパ
  unit/
    embeddings.test.ts     # embed(): provider=none→null / API エラー→null / 正常系(fetch モック)、toVectorLiteral
    extract.test.ts        # extractCandidates(): JSON パース・コードフェンス除去・パース失敗(fetch モック)、chunkDocument の分割境界
  integration/
    knowledge.test.ts      # propose / findDuplicates / proposeUpdate / getKnowledge / addRelation /
                           # upsertContext / setVerification / listContexts / pendingReviews
    search.test.ts         # hybridSearch キーワード経路(PGroonga 日本語検索、context/type フィルタ、draft 除外の既定動作)
```

- `package.json` に `test` スクリプトを追加: `tsx tests/helpers/setup-db.ts && node --import tsx --test 'tests/**/*.test.ts'`。環境変数(`DATABASE_URL` を `koto_test` 向けに、`EMBEDDING_PROVIDER=none`)は `test` スクリプトの行頭でインライン指定する(`src/db.ts` の pool はモジュール読み込み時に生成されるため、プロセス起動前に設定されている必要がある)。
- `tsconfig.json` の `include` に `tests` を追加し、typecheck の対象に含める。

## DB 統合テストの流れ

1. `setup-db.ts` が既存 db コンテナに接続し、`koto_test` を drop & create → `docker/db/init/001_schema.sql` のみを適用する。migrations は旧スキーマで初期化済みの既存 DB 向けであり(fresh な DB に重ねると fkey・カラムの重複でエラーになる)、`001_schema.sql` が最新の完全スキーマ(compose の初期化と同一)。DB 未起動時は「`docker compose up -d` を先に実行してください」と明示して失敗する。
2. 各テストファイルは `before` フックで truncate してから自前のテストデータを挿入する。テスト間の独立性は truncate で担保する。テストファイルは `--test-concurrency=1` で直列実行し、共有 DB への干渉を防ぐ。
3. `EMBEDDING_PROVIDER=none` のため `embed()` は null を返す。埋め込み類似の重複検出・ベクトル検索・RRF 融合の経路は統合テストの対象外とする(embeddings の fetch 部分は単体テストでカバー)。
4. `status='approved'` が必要なテストデータは SQL で直接挿入する(`propose()` は規約どおり draft しか作らないため)。

## テスト対象外(今回のスコープ外)

- `src/mcp-server.ts` の MCP ツール定義層(薄いラッパのため。中核ロジックは knowledge/search のテストでカバー)
- `src/review-cli.ts` / `src/import/run-import.ts` の CLI エントリポイント
- 埋め込みありのベクトル検索・RRF 融合の統合テスト(実 API キーが必要なため)

## 検証ゴール

- `docker compose up -d` 済みの環境で `pnpm test` が一発で通る
- `pnpm run typecheck` / `pnpm run lint` がテストコード込みで通る
- 開発 DB(`koto`)のデータがテスト実行で変化しない

## ドキュメント

- `CLAUDE.md` のコマンド一覧に `pnpm test` を 1 行追加する(それ以外は変更しない)
