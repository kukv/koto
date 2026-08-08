# koto マルチモジュール化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** koto を pnpm workspace の5パッケージ構成（tsconfig / core / mcp-server / import / cli）に再編し、`@kukv/koto-*` として npm 公開可能な体裁を整える。

**Architecture:** 共有ドメイン層を `@kukv/koto-core` に集約し、3つのエントリポイント（MCP サーバ・文書取込・レビュー CLI)がそれを `workspace:*` で参照する。共有 tsconfig は `@kukv/koto-tsconfig` 単体パッケージとして提供し、各パッケージが `extends` で参照する。tsc project references は使わず、`pnpm -r build` のトポロジカル順実行に任せる。実行はすべて `dist/` の JS を node で行い、tsx は廃止する。

**Tech Stack:** pnpm workspace, TypeScript 5.9 (NodeNext), Node >= 24, Biome（ルート一括）

**Spec:** `docs/superpowers/specs/2026-08-08-multi-module-design.md`

## Global Constraints

- パッケージ管理は pnpm のみ（npm は使わない）
- `pnpm-workspace.yaml` の supply-chain 設定（minimumReleaseAge: 10080, trustPolicy: no-downgrade, strictDepBuilds: true, blockExoticSubdeps: true, strictPeerDependencies: true）は変更しない。例外: `allowBuilds.esbuild` は tsx 廃止で esbuild 依存が消えるため削除する（緩和ではなく縮小)
- MCP サーバ名・MCP 登録名は `koto` のまま
- 全パッケージ `"type": "module"`, `engines.node >= 24`, version `0.1.0`
- 移動するソースファイルの中身は import 文と shebang 以外変更しない（`git mv` で履歴を保持)
- `docker/`, `compose.yaml` は変更しない
- **中間状態について:** Task 2〜5 の間はルートの旧スクリプト（`tsx src/...`)は壊れている。各タスクは `pnpm --filter` によるパッケージ単位の検証を行い、リポジトリ全体の green は Task 6 で回復する

---

### Task 1: workspace 化と共有 tsconfig パッケージ

**Files:**
- Modify: `pnpm-workspace.yaml`（先頭に packages フィールド追加)
- Create: `packages/tsconfig/package.json`
- Create: `packages/tsconfig/base.json`

**Interfaces:**
- Produces: `@kukv/koto-tsconfig` パッケージ。各パッケージの tsconfig.json が `"extends": "@kukv/koto-tsconfig/base.json"` で参照する

- [ ] **Step 1: pnpm-workspace.yaml の先頭に packages フィールドを追加**

ファイル先頭（supply-chain コメントの前)に以下を挿入する。既存の内容は一切変更しない:

```yaml
packages:
  - packages/*

```

- [ ] **Step 2: packages/tsconfig/package.json を作成**

```json
{
  "name": "@kukv/koto-tsconfig",
  "version": "0.1.0",
  "description": "Shared TypeScript config for koto packages",
  "files": ["base.json"],
  "publishConfig": {
    "access": "public"
  }
}
```

注意: `exports` は定義しない。TypeScript の `extends` 解決が exports マップに制限されるのを避けるため。

- [ ] **Step 3: packages/tsconfig/base.json を作成**

現行ルート `tsconfig.json` の compilerOptions を移設し、ライブラリ配布用に declaration 系を追加する:

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 4: インストール確認**

Run: `pnpm install`
Expected: 終了コード 0。`packages/tsconfig` が workspace として認識される（`pnpm ls -r --depth -1` に `@kukv/koto-tsconfig` が出る)

- [ ] **Step 5: Commit**

```bash
git add pnpm-workspace.yaml packages/tsconfig
git commit -m "chore: pnpm workspace 化し共有 tsconfig パッケージを追加"
```

---

### Task 2: @kukv/koto-core パッケージ

**Files:**
- Move: `src/db.ts` → `packages/core/src/db.ts`
- Move: `src/embeddings.ts` → `packages/core/src/embeddings.ts`
- Move: `src/knowledge.ts` → `packages/core/src/knowledge.ts`
- Move: `src/search.ts` → `packages/core/src/search.ts`
- Create: `packages/core/src/index.ts`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`

**Interfaces:**
- Consumes: `@kukv/koto-tsconfig/base.json`（Task 1)
- Produces: `@kukv/koto-core` パッケージ。エントリ `dist/index.js` から以下を re-export:
  `pool`(pg.Pool), `EMBEDDING_DIM`, `embed(text): Promise<number[] | null>`, `toVectorLiteral(v): string`,
  `KnowledgeType`, `Alias`, `ProposeInput`, `findDuplicates`, `propose`, `proposeUpdate`, `getKnowledge`, `addRelation`, `upsertContext`, `setVerification`, `listContexts`, `pendingReviews`,
  `SearchOptions`, `hybridSearch(query, opts?)`

- [ ] **Step 1: ソースを git mv で移動**

```bash
mkdir -p packages/core/src
git mv src/db.ts src/embeddings.ts src/knowledge.ts src/search.ts packages/core/src/
```

ファイル内の相対 import（`./db.js` 等)は同一ディレクトリ内で完結しているため変更不要。

- [ ] **Step 2: packages/core/src/index.ts を作成（公開 API バレル)**

```typescript
export { pool } from "./db.js";
export { EMBEDDING_DIM, embed, toVectorLiteral } from "./embeddings.js";
export {
  type Alias,
  type KnowledgeType,
  type ProposeInput,
  addRelation,
  findDuplicates,
  getKnowledge,
  listContexts,
  pendingReviews,
  propose,
  proposeUpdate,
  setVerification,
  upsertContext,
} from "./knowledge.js";
export { type SearchOptions, hybridSearch } from "./search.js";
```

- [ ] **Step 3: packages/core/package.json を作成**

```json
{
  "name": "@kukv/koto-core",
  "version": "0.1.0",
  "description": "koto domain layer: knowledge propose/approve, hybrid search (PGroonga + pgvector)",
  "type": "module",
  "engines": {
    "node": ">=24"
  },
  "files": ["dist"],
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "pg": "^8.13.0"
  },
  "devDependencies": {
    "@kukv/koto-tsconfig": "workspace:*",
    "@types/node": "24.13.3",
    "@types/pg": "8.20.1",
    "typescript": "5.9.3"
  }
}
```

- [ ] **Step 4: packages/core/tsconfig.json を作成**

```json
{
  "extends": "@kukv/koto-tsconfig/base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 5: インストールとビルド確認**

Run: `pnpm install && pnpm --filter @kukv/koto-core build`
Expected: 終了コード 0。`packages/core/dist/index.js` と `packages/core/dist/index.d.ts` が生成される

- [ ] **Step 6: Commit**

```bash
git add -A src packages/core
git commit -m "feat: 共有ドメイン層を @kukv/koto-core パッケージに分離"
```

---

### Task 3: @kukv/koto-mcp パッケージ

**Files:**
- Move: `src/mcp-server.ts` → `packages/mcp-server/src/mcp-server.ts`
- Modify: `packages/mcp-server/src/mcp-server.ts:1-13`（shebang 追加と import 書き換え)
- Create: `packages/mcp-server/package.json`
- Create: `packages/mcp-server/tsconfig.json`

**Interfaces:**
- Consumes: `@kukv/koto-core` の `addRelation, getKnowledge, listContexts, pendingReviews, propose, proposeUpdate, upsertContext, hybridSearch`
- Produces: bin `koto-mcp`（stdio MCP サーバ)。`pnpm --filter @kukv/koto-mcp start` で起動

- [ ] **Step 1: git mv で移動**

```bash
mkdir -p packages/mcp-server/src
git mv src/mcp-server.ts packages/mcp-server/src/
```

- [ ] **Step 2: ファイル冒頭を書き換え**

現在の 1〜13 行目:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  addRelation,
  getKnowledge,
  listContexts,
  pendingReviews,
  propose,
  proposeUpdate,
  upsertContext,
} from "./knowledge.js";
import { hybridSearch } from "./search.js";
```

を以下に置き換える（shebang 追加、core からの一括 import。これ以外の行は変更しない):

```typescript
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  addRelation,
  getKnowledge,
  hybridSearch,
  listContexts,
  pendingReviews,
  propose,
  proposeUpdate,
  upsertContext,
} from "@kukv/koto-core";
import { z } from "zod";
```

- [ ] **Step 3: packages/mcp-server/package.json を作成**

```json
{
  "name": "@kukv/koto-mcp",
  "version": "0.1.0",
  "description": "koto MCP server (stdio)",
  "type": "module",
  "engines": {
    "node": ">=24"
  },
  "files": ["dist"],
  "bin": {
    "koto-mcp": "dist/mcp-server.js"
  },
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "start": "node dist/mcp-server.js"
  },
  "dependencies": {
    "@kukv/koto-core": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@kukv/koto-tsconfig": "workspace:*",
    "@types/node": "24.13.3",
    "typescript": "5.9.3"
  }
}
```

- [ ] **Step 4: packages/mcp-server/tsconfig.json を作成**

```json
{
  "extends": "@kukv/koto-tsconfig/base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 5: ビルドと起動確認**

Run: `pnpm install && pnpm --filter @kukv/koto-mcp build`
Expected: 終了コード 0

Run: `timeout 3 pnpm --filter @kukv/koto-mcp start < /dev/null; echo "exit=$?"`
Expected: クラッシュ（スタックトレース)なしに終了する。stdio サーバは stdin が閉じると終了するため exit=0 または timeout の 124 なら OK（DB 接続は遅延なので DB 停止中でも起動自体は成功する)

- [ ] **Step 6: Commit**

```bash
git add -A src packages/mcp-server
git commit -m "feat: MCP サーバを @kukv/koto-mcp パッケージに分離"
```

---

### Task 4: @kukv/koto-import パッケージ

**Files:**
- Move: `src/import/extract.ts` → `packages/import/src/extract.ts`
- Move: `src/import/run-import.ts` → `packages/import/src/run-import.ts`
- Modify: `packages/import/src/run-import.ts:1-5`（shebang 追加と import 書き換え)
- Create: `packages/import/package.json`
- Create: `packages/import/tsconfig.json`

**Interfaces:**
- Consumes: `@kukv/koto-core` の `pool, propose`
- Produces: bin `koto-import`。`pnpm --filter @kukv/koto-import start --context <ctx> <files...>` で実行

- [ ] **Step 1: git mv で移動**

```bash
mkdir -p packages/import/src
git mv src/import/extract.ts src/import/run-import.ts packages/import/src/
```

- [ ] **Step 2: run-import.ts の冒頭を書き換え**

現在の 1〜5 行目:

```typescript
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pool } from "../db.js";
import { propose } from "../knowledge.js";
import { chunkDocument, extractCandidates } from "./extract.js";
```

を以下に置き換える（これ以外の行は変更しない):

```typescript
#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pool, propose } from "@kukv/koto-core";
import { chunkDocument, extractCandidates } from "./extract.js";
```

extract.ts は外部 import を持たないため変更不要。

- [ ] **Step 3: packages/import/package.json を作成**

```json
{
  "name": "@kukv/koto-import",
  "version": "0.1.0",
  "description": "koto document importer: extract knowledge candidates (draft) via Claude API",
  "type": "module",
  "engines": {
    "node": ">=24"
  },
  "files": ["dist"],
  "bin": {
    "koto-import": "dist/run-import.js"
  },
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "start": "node dist/run-import.js"
  },
  "dependencies": {
    "@kukv/koto-core": "workspace:*"
  },
  "devDependencies": {
    "@kukv/koto-tsconfig": "workspace:*",
    "@types/node": "24.13.3",
    "typescript": "5.9.3"
  }
}
```

- [ ] **Step 4: packages/import/tsconfig.json を作成**

```json
{
  "extends": "@kukv/koto-tsconfig/base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 5: ビルドと実行確認**

Run: `pnpm install && pnpm --filter @kukv/koto-import build`
Expected: 終了コード 0

Run: `pnpm --filter @kukv/koto-import start; echo "exit=$?"`
Expected: 引数なしなので使い方メッセージ(`使い方: npm run import ...`)を表示して exit=1（正常なエラー系動作)

- [ ] **Step 6: Commit**

```bash
git add -A src packages/import
git commit -m "feat: 文書取込を @kukv/koto-import パッケージに分離"
```

---

### Task 5: @kukv/koto-cli パッケージ

**Files:**
- Move: `src/review-cli.ts` → `packages/cli/src/review-cli.ts`
- Modify: `packages/cli/src/review-cli.ts:1-2`（shebang 追加と import 書き換え)
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`

**Interfaces:**
- Consumes: `@kukv/koto-core` の `pool, getKnowledge, pendingReviews, setVerification`
- Produces: bin `koto-review`。`pnpm --filter @kukv/koto-cli start list` 等で実行

- [ ] **Step 1: git mv で移動**

```bash
mkdir -p packages/cli/src
git mv src/review-cli.ts packages/cli/src/
```

- [ ] **Step 2: review-cli.ts の冒頭を書き換え**

現在の 1〜2 行目:

```typescript
import { pool } from "./db.js";
import { getKnowledge, pendingReviews, setVerification } from "./knowledge.js";
```

を以下に置き換える（これ以外の行は変更しない):

```typescript
#!/usr/bin/env node
import { getKnowledge, pendingReviews, pool, setVerification } from "@kukv/koto-core";
```

- [ ] **Step 3: packages/cli/package.json を作成**

```json
{
  "name": "@kukv/koto-cli",
  "version": "0.1.0",
  "description": "koto review CLI: list/show/approve/verify/reject draft knowledge",
  "type": "module",
  "engines": {
    "node": ">=24"
  },
  "files": ["dist"],
  "bin": {
    "koto-review": "dist/review-cli.js"
  },
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "start": "node dist/review-cli.js"
  },
  "dependencies": {
    "@kukv/koto-core": "workspace:*"
  },
  "devDependencies": {
    "@kukv/koto-tsconfig": "workspace:*",
    "@types/node": "24.13.3",
    "typescript": "5.9.3"
  }
}
```

- [ ] **Step 4: packages/cli/tsconfig.json を作成**

```json
{
  "extends": "@kukv/koto-tsconfig/base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 5: ビルド確認**

Run: `pnpm install && pnpm --filter @kukv/koto-cli build`
Expected: 終了コード 0。`src/` ディレクトリが空になっている（`ls src` がエラーまたは空)

- [ ] **Step 6: Commit**

```bash
git add -A src packages/cli
git commit -m "feat: レビュー CLI を @kukv/koto-cli パッケージに分離"
```

---

### Task 6: ルート整理（package.json / tsconfig / biome / workspace)

**Files:**
- Modify: `package.json`（ルート)
- Delete: `tsconfig.json`（ルート)
- Modify: `biome.json`（files.includes のパス)
- Modify: `pnpm-workspace.yaml`（allowBuilds.esbuild の削除)

**Interfaces:**
- Consumes: Task 2〜5 の全パッケージ
- Produces: ルートコマンド `pnpm run build / typecheck / mcp / import / review / lint`（既存コマンド互換)

- [ ] **Step 1: ルート package.json を全面書き換え**

```json
{
  "name": "koto",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.14.0",
  "engines": {
    "node": ">=24"
  },
  "scripts": {
    "build": "pnpm -r build",
    "typecheck": "pnpm run build",
    "mcp": "pnpm --filter @kukv/koto-mcp start",
    "import": "pnpm --filter @kukv/koto-import start",
    "review": "pnpm --filter @kukv/koto-cli start",
    "lint": "biome check .",
    "lint:fix": "biome check --write ."
  },
  "devDependencies": {
    "@biomejs/biome": "2.5.6"
  }
}
```

補足:
- `typecheck` は全パッケージビルドの別名にする。NodeNext + declaration 出力の `tsc` は `--noEmit` と同等の型検査を行い、かつ依存パッケージの d.ts を依存順(`pnpm -r` はトポロジカル順)に生成できる唯一の方法のため
- tsx は全エントリポイントが dist 実行になったため削除。typescript / @types/* は各パッケージへ移動済み

- [ ] **Step 2: ルート tsconfig.json を削除**

```bash
git rm tsconfig.json
```

- [ ] **Step 3: biome.json の対象パスを更新**

`"includes": ["src/**/*.ts"]` を以下に変更（他は変更しない):

```json
    "includes": ["packages/*/src/**/*.ts"]
```

- [ ] **Step 4: pnpm-workspace.yaml から allowBuilds を削除**

tsx 廃止により esbuild が依存ツリーから消えるため、末尾の以下 3 行を削除する:

```yaml
# tsx が依存する esbuild はネイティブバイナリの取得に postinstall が必要
allowBuilds:
  esbuild: true
```

supply-chain 設定（minimumReleaseAge 等)は一切変更しない。

- [ ] **Step 5: ロックファイル更新と全体検証**

Run: `pnpm install`
Expected: 終了コード 0。lockfile から tsx / esbuild が消える

Run: `pnpm run build && pnpm run lint; echo "exit=$?"`
Expected: exit=0

Run: `git grep -l "tsx" -- package.json packages/*/package.json; echo "exit=$?"`
Expected: マッチなし（exit=1)

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json biome.json pnpm-workspace.yaml
git commit -m "chore: ルートをワークスペース統括に整理し tsx を廃止"
```

---

### Task 7: ドキュメント更新と最終検証

**Files:**
- Modify: `CLAUDE.md`（コマンド・構成セクション)
- Modify: `README.md`（構成パス・MCP 登録手順)

**Interfaces:**
- Consumes: Task 1〜6 の最終構成

- [ ] **Step 1: CLAUDE.md のコマンドセクションを更新**

現在の「## コマンド」のコードブロックを以下に置き換える:

```bash
docker compose up -d --build   # DB 起動(PGroonga + pgvector、初回スキーマ自動適用)
pnpm install                   # パッケージ管理は pnpm(npm は使わない)
pnpm run build                 # 全パッケージを依存順にビルド(実行前に必須)
pnpm run typecheck             # build の別名(tsc が型検査を兼ねる)。変更後は必ず通すこと
pnpm run mcp                   # MCP サーバ(stdio)起動
pnpm run import --context <ctx> <files...>   # 文書 → 知識候補(draft)抽出
pnpm run review list|show|approve|verify|reject   # レビュー CLI
```

- [ ] **Step 2: CLAUDE.md の構成セクションを更新**

「## 構成」の src 系 4 行を以下に置き換える（docker の行は変更しない):

```markdown
- `packages/tsconfig/` — 共有 tsconfig(@kukv/koto-tsconfig)。各パッケージが extends で参照
- `packages/core/` — 共有ドメイン層(@kukv/koto-core)。propose / 承認 / 重複検出 / RRF ハイブリッド検索
- `packages/mcp-server/` — MCP ツール8本の定義(@kukv/koto-mcp)
- `packages/import/` — Claude API による文書からの知識抽出(@kukv/koto-import)
- `packages/cli/` — レビュー CLI(@kukv/koto-cli)
```

また「## 規約」の名前統一の行を以下に更新:

```markdown
- **名前は koto に統一**: MCP サーバ名・MCP 登録名は `koto`。npm パッケージは `@kukv/koto-*`
```

- [ ] **Step 3: README.md のパスと MCP 登録手順を更新**

構成説明の 3 行を:

```
packages/core/          共有ドメイン層(propose・検索)
packages/mcp-server/    MCPサーバ(8ツール)
packages/import/        文書 → 知識候補(draft)の抽出パイプライン
packages/cli/           draft承認用CLI
packages/tsconfig/      共有tsconfig
```

に、MCP 登録手順の `npx tsx /絶対パス/koto/src/mcp-server.ts` 系 2 箇所を、事前に `pnpm build` を実行した上で:

```
node /絶対パス/koto/packages/mcp-server/dist/mcp-server.js
```

を使う形に書き換える（`claude mcp add` の例と JSON 設定例の両方。JSON 側は `"command": "node", "args": ["/絶対パス/koto/packages/mcp-server/dist/mcp-server.js"]`)。

- [ ] **Step 4: 最終検証（フルスイート)**

Run: `pnpm install && pnpm run build && pnpm run lint; echo "exit=$?"`
Expected: exit=0

Run: `docker compose up -d && sleep 5 && pnpm run review list; echo "exit=$?"`
Expected: exit=0。「レビュー待ちはありません」または一覧が表示される（DB 接続確認)

Run: `timeout 3 pnpm run mcp < /dev/null; echo "exit=$?"`
Expected: クラッシュなし（exit=0 または 124)

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: マルチモジュール構成にドキュメントを更新"
```
