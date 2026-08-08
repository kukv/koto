# koto マルチモジュール化 設計

日付: 2026-08-08
ステータス: 承認済み（実装前）

## 目的

koto を pnpm workspace によるマルチパッケージ構成に再編し、様々な AI エージェント環境から柔軟に利用可能にする。将来的な npm 公開（`@kukv/koto-*`）に耐える体裁（exports / dist / bin）を整える。公開操作自体は本件のスコープ外。

## パッケージ構成

```
koto/
├─ pnpm-workspace.yaml          # packages: ["packages/*"] を追加（supply-chain 設定は維持）
├─ package.json                 # ルート: private。スクリプトは --filter で各パッケージへ委譲
└─ packages/
   ├─ tsconfig/                 # @kukv/koto-tsconfig — 共有 tsconfig（単体パッケージ）
   │  ├─ package.json
   │  └─ base.json              # 現行 tsconfig.json の compilerOptions を移設
   ├─ core/                     # @kukv/koto-core — 共有ドメイン層
   │  └─ src/ db.ts / embeddings.ts / knowledge.ts / search.ts / index.ts
   ├─ mcp-server/               # @kukv/koto-mcp — MCP サーバ（bin 付き）
   │  └─ src/ mcp-server.ts
   ├─ import/                   # @kukv/koto-import — 文書取込 CLI（Claude API 依存はここだけ）
   │  └─ src/ extract.ts / run-import.ts
   └─ cli/                      # @kukv/koto-cli — レビュー CLI
      └─ src/ review-cli.ts
```

- 1 パッケージ = 1 関心事。Claude API に依存するのは `import` のみ。MCP サーバや CLI だけを使う環境に余計な依存を持ち込まない。
- `core` に `index.ts`（バレル）を新設し、公開 API（propose / getKnowledge / pendingReviews / setVerification / hybridSearch / pool 等、現在エントリポイントが import しているもの）を明示的に re-export する。

## tsconfig 共通化

- `packages/tsconfig` を共有設定の単体パッケージとする。各パッケージは devDependencies に `"@kukv/koto-tsconfig": "workspace:*"` を持ち、`"extends": "@kukv/koto-tsconfig/base.json"` で参照する。
- tsc の project references は使わない。ビルド順序は `pnpm -r build` のトポロジカル実行に任せる。
- 各パッケージの tsconfig.json は extends + `outDir: dist` / `rootDir: src` / `include: ["src"]` / `declaration: true` 程度の最小差分のみ持つ。

## 依存関係

| パッケージ | dependencies |
|---|---|
| @kukv/koto-tsconfig | なし |
| @kukv/koto-core | pg |
| @kukv/koto-mcp | @kukv/koto-core, @modelcontextprotocol/sdk, zod |
| @kukv/koto-import | @kukv/koto-core |
| @kukv/koto-cli | @kukv/koto-core |

- workspace 内参照は `workspace:*`（publish 時に実バージョンへ変換される）。
- devDependencies（typescript, tsx, @types/*）は各パッケージが必要な分だけ持つ。biome はルートのみ。

## npm 公開対応の体裁

- 各パッケージ: `exports` で `dist/index.js` + `dist/index.d.ts` を指す。`files: ["dist"]`。
- `mcp-server` と `cli` は `bin` を定義（将来 `npx @kukv/koto-mcp` で起動可能にする）。
- ルート package.json は `private: true` を維持。各パッケージも公開準備が整うまで publish しない（体裁のみ整える）。

## ルートスクリプト（既存コマンド互換）

| コマンド | 実装 |
|---|---|
| `pnpm run build` | `pnpm -r build`（依存順） |
| `pnpm run typecheck` | `pnpm -r typecheck` |
| `pnpm run mcp` | `--filter @kukv/koto-mcp` へ委譲 |
| `pnpm run import` | `--filter @kukv/koto-import` へ委譲 |
| `pnpm run review` | `--filter @kukv/koto-cli` へ委譲 |
| `pnpm run lint` / `lint:fix` | ルートの biome のまま |

挙動変更: ライブラリ参照（exports）が dist を指すため、`pnpm run mcp` 等の実行前に `pnpm build` が必要になる。

## 変更しないもの

- `docker/`（DB スキーマ・マイグレーション）、`compose.yaml`
- `pnpm-workspace.yaml` の supply-chain 設定（minimumReleaseAge 等）— `packages:` フィールドの追加のみ行う
- biome / renovate の設定（パス調整が必要な場合のみ最小変更）

## 検証条件

1. `pnpm install` が成功する（strictDepBuilds 等の supply-chain 設定下で）
2. `pnpm run build` が全パッケージで成功する
3. `pnpm run typecheck` が全パッケージで通る
4. `pnpm run lint` が通る
5. `pnpm run mcp` で MCP サーバが起動する（DB 起動時）
6. `pnpm run review list` / `pnpm run import` が従来どおり動作する
