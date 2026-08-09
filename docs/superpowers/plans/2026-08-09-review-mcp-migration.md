# 承認フローの MCP 移管と CLI 廃止 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 承認・検証・却下を MCP ツールとして提供し、人間の確認を elicitation でサーバ側から強制した上で、レビュー CLI とバッチインポート CLI を廃止する。

**Architecture:** DB 操作は `packages/core` に関数として置き、MCP サーバはその薄いラッパにする。3ツールとも DB を変更する前にクライアントへ elicitation を投げ、確認者名を人間に入力させる。ダイアログを出せないクライアントでは実行を拒否する。テストのため MCP サーバの構築処理を `createKotoServer()` として切り出し、`InMemoryTransport` でクライアントを立てて検証する。

**Tech Stack:** TypeScript 7 / Node 24 / pnpm workspace / `@modelcontextprotocol/sdk` 1.30.0 / Postgres 18 (PGroonga + pgvector) / vitest 4 / biome

**設計:** `docs/superpowers/specs/2026-08-09-review-mcp-migration-design.md`

## Global Constraints

- パッケージ管理は **pnpm**。`npm` は使わない。
- `pnpm run build` は `typecheck` / `test` の前に必須(workspace パッケージが `dist` 越しに解決されるため)。
- テスト実行前に `docker compose up -d` で DB が起動していること。テストは `koto_test` を使い、開発 DB (`koto`) には触れない。
- **物理削除しない。** 却下は `status='deprecated'` + 理由の記録。
- **エージェントの書き込みは必ず draft。** 本計画で追加するのは承認側のツールであり、`propose_*` の挙動は変えない。
- `@modelcontextprotocol/sdk` は **1.30.0 固定**。`pnpm-workspace.yaml` の supply-chain 設定(`minimumReleaseAge` 等)を緩めない。
- 新規 devDependency は既存パッケージと同じバージョン指定を使う(vitest は `^4.1.10`)。
- コメント・エラーメッセージは日本語。既存ファイルのスタイル(コメント密度・命名)に合わせる。
- 各タスクの最後に `pnpm run lint:fix` を通してからコミットする。

---

## ファイル構成

**新規作成:**

| ファイル | 責務 |
|---|---|
| `packages/mcp-server/src/server.ts` | `createKotoServer()` — MCP サーバの構築とツール登録。現 `mcp-server.ts` の中身を移す |
| `packages/mcp-server/src/elicit.ts` | `requireHumanApproval()` — capability 確認・ダイアログ提示・確認者名の取得 |
| `packages/mcp-server/tests/helpers/db.ts` | テスト用の truncate と draft 投入 |
| `packages/mcp-server/tests/helpers/client.ts` | InMemoryTransport でクライアントを接続するヘルパ |
| `packages/mcp-server/tests/integration/review-tools.test.ts` | 承認3ツールの統合テスト |
| `packages/mcp-server/tsconfig.test.json` | テストコードの型検査設定 |

**変更:**

| ファイル | 変更内容 |
|---|---|
| `packages/core/src/knowledge.ts` | `approve()` / `reject()` を追加 |
| `packages/core/src/index.ts` | 上記2関数を re-export |
| `packages/core/tests/integration/knowledge.test.ts` | 上記2関数のテストを追加 |
| `packages/mcp-server/src/mcp-server.ts` | 起動処理のみに縮小 |
| `packages/mcp-server/package.json` | vitest 追加、`typecheck:tests` 追加 |
| `package.json`(ルート) | `import` / `review` スクリプトを削除 |
| `README.md` / `CLAUDE.md` / `skills/koto-import/SKILL.md` / `docs/業務知識基盤_設計記録.md` | CLI 廃止と承認ツールの追加を反映 |

**削除:** `packages/cli/` 一式、`packages/import/` 一式

---

### Task 1: core に `approve()` を追加

**Files:**
- Modify: `packages/core/src/knowledge.ts`(末尾に追加)
- Modify: `packages/core/src/index.ts:3-16`
- Test: `packages/core/tests/integration/knowledge.test.ts`(末尾に追加)

**Interfaces:**
- Consumes: `pool`(同ファイル内で import 済み)、テストヘルパ `seedKnowledge({ context, title, type?, body?, status? }): Promise<string>` / `truncateAll()` / `pool`
- Produces: `approve(id: string, by: string): Promise<{ id: string; status: "approved" }>` — 存在しない id では `Error` を throw する

- [ ] **Step 1: 失敗するテストを書く**

`packages/core/tests/integration/knowledge.test.ts` の import に `approve` を追加する(既存 import は `addRelation, findDuplicates, getKnowledge, listContexts, pendingReviews, propose, proposeUpdate, setVerification, upsertContext` — アルファベット順に `approve` を挿入)。

ファイル末尾に追加:

```ts
describe("approve", () => {
  test("draft を approved にし verification=internal と確認者を記録する", async () => {
    const id = await seedKnowledge({ context: "sales", title: "受注", status: "draft" });
    await pool.query("update knowledge set needs_review = true where id = $1", [id]);

    const result = await approve(id, "野中");

    assert.deepEqual(result, { id, status: "approved" });
    const row = (await pool.query("select * from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.status, "approved");
    assert.equal(row.needs_review, false);
    assert.equal(row.verification, "internal");
    assert.equal(row.verified_by, "野中");
    assert.notEqual(row.verified_at, null);
  });

  test("既に expert のレコードは検証レベルを維持する", async () => {
    const id = await seedKnowledge({ context: "sales", title: "受注", status: "draft" });
    await pool.query("update knowledge set verification = 'expert' where id = $1", [id]);

    await approve(id, "野中");

    const row = (await pool.query("select * from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.verification, "expert");
  });

  test("存在しない id はエラーになる", async () => {
    await assert.rejects(
      () => approve("00000000-0000-0000-0000-000000000000", "野中"),
      /見つかりません/,
    );
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
docker compose up -d
pnpm run build
pnpm test -- knowledge
```

Expected: FAIL。`approve` が `@kukv/koto-core` から export されておらず、`"approve" is not exported` 相当のエラーで落ちる。

- [ ] **Step 3: `approve()` を実装する**

`packages/core/src/knowledge.ts` の `setVerification()` の直前に追加する(承認 → 検証レベル操作の順で並べる):

```ts
/** レビューを通して承認する(検索の既定対象になる。検証レベルは internal、既に expert なら維持) */
export async function approve(id: string, by: string) {
  const res = await pool.query(
    `update knowledge
        set status = 'approved', needs_review = false,
            verification = case when verification = 'expert' then 'expert' else 'internal' end,
            verified_by = $2, verified_at = now()
      where id = $1`,
    [id, by],
  );
  if (res.rowCount === 0) throw new Error(`知識レコードが見つかりません: ${id}`);
  return { id, status: "approved" as const };
}
```

- [ ] **Step 4: re-export する**

`packages/core/src/index.ts` の `./knowledge.js` からの export リストに `approve,` を追加する(`addRelation,` の直後、アルファベット順):

```ts
export {
  type Alias,
  addRelation,
  approve,
  findDuplicates,
  getKnowledge,
  type KnowledgeType,
  listContexts,
  type ProposeInput,
  pendingReviews,
  propose,
  proposeUpdate,
  setVerification,
  upsertContext,
} from "./knowledge.js";
```

- [ ] **Step 5: テストが通ることを確認する**

```bash
pnpm run build
pnpm test -- knowledge
```

Expected: PASS。`approve` の3テストが緑になる。

- [ ] **Step 6: コミット**

```bash
pnpm run lint:fix
git add packages/core/src/knowledge.ts packages/core/src/index.ts packages/core/tests/integration/knowledge.test.ts
git commit -m "feat(core): 知識を承認する approve() を追加"
```

---

### Task 2: core に `reject()` を追加

**Files:**
- Modify: `packages/core/src/knowledge.ts`(`approve()` の直後)
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/tests/integration/knowledge.test.ts`(末尾に追加)

**Interfaces:**
- Consumes: `pool`、テストヘルパ `seedKnowledge` / `truncateAll`
- Produces: `reject(id: string, reason: string, by: string): Promise<{ id: string; status: "deprecated" }>` — 存在しない id では `Error` を throw する。`review_notes` に `却下(<by>): <reason>` を追記する

- [ ] **Step 1: 失敗するテストを書く**

import に `reject` を追加し(`propose, proposeUpdate,` の後、アルファベット順)、ファイル末尾に追加:

```ts
describe("reject", () => {
  test("deprecated になり却下理由と確認者が review_notes に残る", async () => {
    const id = await seedKnowledge({ context: "sales", title: "受注", status: "draft" });

    const result = await reject(id, "営業部の実態と食い違っている", "野中");

    assert.deepEqual(result, { id, status: "deprecated" });
    const row = (await pool.query("select * from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.status, "deprecated");
    assert.equal(row.needs_review, false);
    assert.match(row.review_notes, /却下\(野中\): 営業部の実態と食い違っている/);
  });

  test("既存の review_notes は残したまま追記される", async () => {
    const id = await seedKnowledge({ context: "sales", title: "受注", status: "draft" });
    await pool.query("update knowledge set review_notes = '要確認: 出典不明' where id = $1", [id]);

    await reject(id, "出典が確認できなかった", "野中");

    const row = (await pool.query("select review_notes from knowledge where id = $1", [id])).rows[0];
    assert.match(row.review_notes, /要確認: 出典不明/);
    assert.match(row.review_notes, /却下\(野中\): 出典が確認できなかった/);
  });

  test("存在しない id はエラーになる", async () => {
    await assert.rejects(
      () => reject("00000000-0000-0000-0000-000000000000", "理由", "野中"),
      /見つかりません/,
    );
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
pnpm run build
pnpm test -- knowledge
```

Expected: FAIL。`reject` が export されていないエラー。

- [ ] **Step 3: `reject()` を実装する**

`packages/core/src/knowledge.ts` の `approve()` の直後に追加:

```ts
/** レビューで却下する(物理削除はせず deprecated にし、却下理由を履歴として残す) */
export async function reject(id: string, reason: string, by: string) {
  const res = await pool.query(
    `update knowledge
        set status = 'deprecated', needs_review = false,
            review_notes = coalesce(review_notes || E'\n', '') || $2
      where id = $1`,
    [id, `却下(${by}): ${reason}`],
  );
  if (res.rowCount === 0) throw new Error(`知識レコードが見つかりません: ${id}`);
  return { id, status: "deprecated" as const };
}
```

- [ ] **Step 4: re-export する**

`packages/core/src/index.ts` の export リストに `reject,` を追加する(`proposeUpdate,` の直後):

```ts
  propose,
  proposeUpdate,
  reject,
  setVerification,
```

- [ ] **Step 5: テストが通ることを確認する**

```bash
pnpm run build
pnpm test -- knowledge
```

Expected: PASS。

- [ ] **Step 6: コミット**

```bash
pnpm run lint:fix
git add packages/core/src/knowledge.ts packages/core/src/index.ts packages/core/tests/integration/knowledge.test.ts
git commit -m "feat(core): 却下理由を記録する reject() を追加"
```

---

### Task 3: MCP サーバをテスト可能な構造に分割する

現在の `mcp-server.ts` はトップレベルで `await server.connect()` するため、テストから import できない。サーバ構築を `createKotoServer()` として切り出す。**このタスクでは振る舞いを一切変えない。**

**Files:**
- Create: `packages/mcp-server/src/server.ts`
- Create: `packages/mcp-server/tests/helpers/db.ts`
- Create: `packages/mcp-server/tests/helpers/client.ts`
- Create: `packages/mcp-server/tests/integration/review-tools.test.ts`
- Create: `packages/mcp-server/tsconfig.test.json`
- Modify: `packages/mcp-server/src/mcp-server.ts`(全面書き換え)
- Modify: `packages/mcp-server/package.json`

**Interfaces:**
- Produces:
  - `createKotoServer(): McpServer`(`src/server.ts`)
  - `truncateAll(): Promise<void>` / `seedDraft(input: { context: string; title: string; type?: string; body?: string }): Promise<string>` / `pool`(`tests/helpers/db.ts`)
  - `connect(): Promise<Client>` / `textOf(result: unknown): string`(`tests/helpers/client.ts`)

- [ ] **Step 1: テスト設定を用意する**

`packages/mcp-server/tsconfig.test.json` を作成(core と同じ構成):

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": "."
  },
  "include": ["src", "tests"]
}
```

`packages/mcp-server/package.json` の `scripts` に `typecheck:tests` を追加し、`devDependencies` に vitest を追加する:

```json
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "typecheck:tests": "tsc -p tsconfig.test.json",
    "start": "node dist/mcp-server.js"
  },
  "devDependencies": {
    "@kukv/koto-tsconfig": "workspace:*",
    "@types/node": "24.13.3",
    "typescript": "7.0.2",
    "vitest": "^4.1.10"
  }
```

続けて依存を反映する:

```bash
pnpm install
```

- [ ] **Step 2: テストヘルパを作る**

`packages/mcp-server/tests/helpers/db.ts`:

```ts
import { pool } from "@kukv/koto-core";

// 誤って開発 DB に向いたまま truncate しないためのガード
const url = process.env.DATABASE_URL ?? "";
if (!url.endsWith("/koto_test")) {
  throw new Error(`統合テストは koto_test 以外の DB では実行できません: ${url || "(未設定)"}`);
}

export async function truncateAll() {
  await pool.query(
    "truncate contexts, knowledge, knowledge_relations, knowledge_revisions restart identity cascade",
  );
}

/** レビュー待ちの draft を1件作る */
export async function seedDraft(input: {
  context: string;
  title: string;
  type?: string;
  body?: string;
}): Promise<string> {
  await pool.query("insert into contexts (name) values ($1) on conflict (name) do nothing", [
    input.context,
  ]);
  const res = await pool.query(
    `insert into knowledge (type, context, title, body, status, needs_review)
     values ($1,$2,$3,$4,'draft',true) returning id`,
    [input.type ?? "term", input.context, input.title, input.body ?? "本文"],
  );
  return res.rows[0].id as string;
}

export { pool };
```

`packages/mcp-server/tests/helpers/client.ts`:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createKotoServer } from "../../src/server.js";

/** InMemoryTransport でサーバに接続したクライアントを返す */
export async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    createKotoServer().connect(serverTransport),
  ]);
  return client;
}

/** callTool の戻り値からテキストを取り出す */
export function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
}
```

- [ ] **Step 3: 失敗するテストを書く**

`packages/mcp-server/tests/integration/review-tools.test.ts`:

```ts
import assert from "node:assert/strict";
import { afterAll, beforeEach, describe, test } from "vitest";
import { connect } from "../helpers/client.js";
import { pool, truncateAll } from "../helpers/db.js";

beforeEach(truncateAll);
afterAll(() => pool.end());

describe("createKotoServer", () => {
  test("既存のツールがすべて登録されている", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [
        "add_relation",
        "get_knowledge",
        "get_pending_reviews",
        "list_contexts",
        "propose_knowledge",
        "propose_update",
        "search_knowledge",
        "upsert_context",
      ],
    );
  });
});
```

- [ ] **Step 4: テストが失敗することを確認する**

```bash
pnpm run build
pnpm test -- review-tools
```

Expected: FAIL。`../../src/server.js` が存在せず解決に失敗する。

- [ ] **Step 5: `src/server.ts` を作る**

現在の `packages/mcp-server/src/mcp-server.ts` の**1行目の shebang と、末尾3行(`const transport = ...` / `await server.connect(transport)` / `console.error(...)`)を除く全内容**を `packages/mcp-server/src/server.ts` に移す。移したうえで、`const server = new McpServer(...)` から最後の `registerTool` までを `createKotoServer()` の中に入れ、`server` を返す。

`text` / `fail` / `aliasSchema` は関数の外(モジュールトップレベル)に置いたままにする。ツール登録の中身は一字一句変えない。

結果の骨格:

```ts
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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const text = (v: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof v === "string" ? v : JSON.stringify(v, null, 2),
    },
  ],
});

const fail = (e: unknown) => text(`エラー: ${e instanceof Error ? e.message : String(e)}`);

const aliasSchema = z.object({
  name: z.string(),
  kind: z
    .enum(["synonym", "forbidden"])
    .describe("synonym=同義語 / forbidden=使ってはいけない表記"),
});

export function createKotoServer(): McpServer {
  const server = new McpServer({ name: "koto", version: "0.1.0" });

  server.registerTool(
    "search_knowledge",
    // …(既存8ツールの登録をそのまま移す)
  );

  return server;
}
```

- [ ] **Step 6: `mcp-server.ts` を起動処理だけにする**

`packages/mcp-server/src/mcp-server.ts` を次の内容で全面置換する:

```ts
#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createKotoServer } from "./server.js";

const transport = new StdioServerTransport();
await createKotoServer().connect(transport);
console.error("knowledge-base MCP server running (stdio)");
```

- [ ] **Step 7: テストが通ることを確認する**

```bash
pnpm run build
pnpm test -- review-tools
pnpm run typecheck
```

Expected: すべて PASS。8ツールが並ぶ。

- [ ] **Step 8: コミット**

```bash
pnpm run lint:fix
git add packages/mcp-server pnpm-lock.yaml
git commit -m "refactor(mcp): サーバ構築を createKotoServer() に切り出しテスト基盤を追加"
```

---

### Task 4: elicitation ヘルパと `approve_knowledge`

**Files:**
- Create: `packages/mcp-server/src/elicit.ts`
- Modify: `packages/mcp-server/src/server.ts`
- Modify: `packages/mcp-server/tests/helpers/client.ts`
- Modify: `packages/mcp-server/tests/integration/review-tools.test.ts`

**Interfaces:**
- Consumes: `approve(id, by)`(Task 1)、`getKnowledge(id, expandRelations)` — 見つからないとき `null` を返す、`createKotoServer()`(Task 3)
- Produces:
  - `requireHumanApproval(server: McpServer, message: string, target: ReviewTarget): Promise<{ ok: true; reviewer: string } | { ok: false; message: string }>`
  - `ReviewTarget = { id: string; type: string; context: string; title: string; body: string }`
  - `connectWithElicitation(respond: () => ElicitResult): Promise<Client>` / `connectWithoutElicitation(): Promise<Client>`(テストヘルパ)

- [ ] **Step 1: テストヘルパに elicitation 対応版を足す**

`packages/mcp-server/tests/helpers/client.ts` に追加(既存の `connect` / `textOf` はそのまま残す):

```ts
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";

/** elicitation に対応したクライアント。respond がダイアログへの応答を決める */
export async function connectWithElicitation(respond: () => ElicitResult): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "test", version: "0.0.0" },
    { capabilities: { elicitation: {} } },
  );
  client.setRequestHandler(ElicitRequestSchema, async () => respond());
  await Promise.all([
    client.connect(clientTransport),
    createKotoServer().connect(serverTransport),
  ]);
  return client;
}
```

`connectWithoutElicitation` は既存の `connect` がそのまま該当するため、追加しない。

- [ ] **Step 2: 失敗するテストを書く**

`packages/mcp-server/tests/integration/review-tools.test.ts` に追加。import に `connectWithElicitation` と `seedDraft` を足すこと。

```ts
describe("approve_knowledge", () => {
  test("ユーザーが accept すると approved になり確認者が記録される", async () => {
    const id = await seedDraft({ context: "sales", title: "受注" });
    const client = await connectWithElicitation(() => ({
      action: "accept",
      content: { reviewer: "野中" },
    }));

    const res = await client.callTool({ name: "approve_knowledge", arguments: { id } });

    assert.match(textOf(res), /approved/);
    const row = (await pool.query("select * from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.status, "approved");
    assert.equal(row.verified_by, "野中");
  });

  test("ユーザーが decline すると DB は変化しない", async () => {
    const id = await seedDraft({ context: "sales", title: "受注" });
    const client = await connectWithElicitation(() => ({ action: "decline" }));

    const res = await client.callTool({ name: "approve_knowledge", arguments: { id } });

    assert.match(textOf(res), /承認しませんでした/);
    const row = (await pool.query("select * from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.status, "draft");
  });

  test("確認者名が空なら実行しない", async () => {
    const id = await seedDraft({ context: "sales", title: "受注" });
    const client = await connectWithElicitation(() => ({
      action: "accept",
      content: { reviewer: "  " },
    }));

    const res = await client.callTool({ name: "approve_knowledge", arguments: { id } });

    assert.match(textOf(res), /確認者名/);
    const row = (await pool.query("select status from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.status, "draft");
  });

  test("elicitation 非対応のクライアントからは実行できない", async () => {
    const id = await seedDraft({ context: "sales", title: "受注" });
    const client = await connect();

    const res = await client.callTool({ name: "approve_knowledge", arguments: { id } });

    assert.match(textOf(res), /確認ダイアログ/);
    const row = (await pool.query("select status from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.status, "draft");
  });

  test("存在しない id はエラーを返す", async () => {
    const client = await connectWithElicitation(() => ({
      action: "accept",
      content: { reviewer: "野中" },
    }));

    const res = await client.callTool({
      name: "approve_knowledge",
      arguments: { id: "00000000-0000-0000-0000-000000000000" },
    });

    assert.match(textOf(res), /見つかりません/);
  });
});
```

既存の「既存のツールがすべて登録されている」テストの期待値に `"approve_knowledge",` を先頭に追加する(sort 順で `add_relation` の次)。

```ts
      [
        "add_relation",
        "approve_knowledge",
        "get_knowledge",
        "get_pending_reviews",
        "list_contexts",
        "propose_knowledge",
        "propose_update",
        "search_knowledge",
        "upsert_context",
      ],
```

- [ ] **Step 3: テストが失敗することを確認する**

```bash
pnpm run build
pnpm test -- review-tools
```

Expected: FAIL。`approve_knowledge` が未登録で `Tool approve_knowledge not found` 相当のエラー。

- [ ] **Step 4: elicitation ヘルパを実装する**

`packages/mcp-server/src/elicit.ts`:

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface ReviewTarget {
  id: string;
  type: string;
  context: string;
  title: string;
  body: string;
}

export type ApprovalOutcome = { ok: true; reviewer: string } | { ok: false; message: string };

/**
 * 人間の確認をクライアント経由で取り、確認者名を受け取る。
 * ダイアログを出せないクライアントでは実行を許可しない(エージェントの自己承認を防ぐため)。
 */
export async function requireHumanApproval(
  server: McpServer,
  message: string,
  target: ReviewTarget,
): Promise<ApprovalOutcome> {
  if (!server.server.getClientCapabilities()?.elicitation) {
    return {
      ok: false,
      message:
        "このクライアントは確認ダイアログ(elicitation)に対応していないため実行できません。承認・却下には人間の確認が必要です。",
    };
  }

  const excerpt = target.body.length > 300 ? `${target.body.slice(0, 300)}…` : target.body;
  const result = await server.server.elicitInput({
    message: `${message}\n\n[${target.type}/${target.context}] ${target.title}\n\n${excerpt}`,
    requestedSchema: {
      type: "object",
      properties: {
        reviewer: {
          type: "string",
          title: "確認者名",
          description: "この判断をした人の名前(記録に残ります)",
          default: process.env.KOTO_REVIEWER ?? "",
        },
      },
      required: ["reviewer"],
    },
  });

  if (result.action !== "accept") {
    return {
      ok: false,
      message: `ユーザーが承認しませんでした(${result.action})。何も変更していません。`,
    };
  }

  const reviewer = typeof result.content?.reviewer === "string" ? result.content.reviewer.trim() : "";
  if (!reviewer) {
    return { ok: false, message: "確認者名が入力されなかったため実行しませんでした。" };
  }
  return { ok: true, reviewer };
}
```

- [ ] **Step 5: 対象レコード取得のヘルパと `approve_knowledge` を追加する**

`packages/mcp-server/src/server.ts` の import に追加:

```ts
import { approve, getKnowledge, /* …既存… */ } from "@kukv/koto-core";
import { type ReviewTarget, requireHumanApproval } from "./elicit.js";
```

`aliasSchema` の下(モジュールトップレベル)に、対象レコードを `ReviewTarget` に詰め替えるヘルパを置く:

```ts
/** 確認ダイアログに出す最小情報を取り出す(見つからなければ null) */
async function reviewTarget(id: string): Promise<ReviewTarget | null> {
  const rec = (await getKnowledge(id, false)) as Record<string, unknown> | null;
  if (!rec) return null;
  return {
    id,
    type: String(rec.type),
    context: String(rec.context),
    title: String(rec.title),
    body: String(rec.body),
  };
}
```

`createKotoServer()` の中、`get_pending_reviews` の登録の直後に追加:

```ts
  server.registerTool(
    "approve_knowledge",
    {
      title: "知識の承認",
      description:
        "レビュー待ちの知識を承認し、検索の既定対象にする。実行するとユーザーに確認ダイアログが出る。ユーザーが承認しなければ何も変更されない。承認するかどうかの判断は必ずユーザーに委ねること。",
      inputSchema: { id: z.string().uuid() },
      annotations: { idempotentHint: true },
    },
    async ({ id }) => {
      try {
        const target = await reviewTarget(id);
        if (!target) return text(`知識レコードが見つかりません: ${id}`);
        const outcome = await requireHumanApproval(server, "この知識を承認しますか?", target);
        if (!outcome.ok) return text(outcome.message);
        return text(await approve(id, outcome.reviewer));
      } catch (e) {
        return fail(e);
      }
    },
  );
```

- [ ] **Step 6: テストが通ることを確認する**

```bash
pnpm run build
pnpm test -- review-tools
pnpm run typecheck
```

Expected: すべて PASS。

- [ ] **Step 7: コミット**

```bash
pnpm run lint:fix
git add packages/mcp-server
git commit -m "feat(mcp): elicitation で人間の確認を強制する approve_knowledge を追加"
```

---

### Task 5: `reject_knowledge`

**Files:**
- Modify: `packages/mcp-server/src/server.ts`
- Modify: `packages/mcp-server/tests/integration/review-tools.test.ts`

**Interfaces:**
- Consumes: `reject(id, reason, by)`(Task 2)、`requireHumanApproval()` / `reviewTarget()`(Task 4)

- [ ] **Step 1: 失敗するテストを書く**

`review-tools.test.ts` に追加:

```ts
describe("reject_knowledge", () => {
  test("accept すると deprecated になり理由が残る", async () => {
    const id = await seedDraft({ context: "sales", title: "受注" });
    const client = await connectWithElicitation(() => ({
      action: "accept",
      content: { reviewer: "野中" },
    }));

    const res = await client.callTool({
      name: "reject_knowledge",
      arguments: { id, reason: "営業部の実態と食い違っている" },
    });

    assert.match(textOf(res), /deprecated/);
    const row = (await pool.query("select * from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.status, "deprecated");
    assert.match(row.review_notes, /却下\(野中\): 営業部の実態と食い違っている/);
  });

  test("decline すると DB は変化しない", async () => {
    const id = await seedDraft({ context: "sales", title: "受注" });
    const client = await connectWithElicitation(() => ({ action: "cancel" }));

    const res = await client.callTool({
      name: "reject_knowledge",
      arguments: { id, reason: "理由" },
    });

    assert.match(textOf(res), /承認しませんでした/);
    const row = (await pool.query("select status from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.status, "draft");
  });

  test("elicitation 非対応のクライアントからは実行できない", async () => {
    const id = await seedDraft({ context: "sales", title: "受注" });
    const client = await connect();

    const res = await client.callTool({
      name: "reject_knowledge",
      arguments: { id, reason: "理由" },
    });

    assert.match(textOf(res), /確認ダイアログ/);
    const row = (await pool.query("select status from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.status, "draft");
  });
});
```

ツール一覧テストの期待値に `"reject_knowledge",` を追加する(`propose_update` の次):

```ts
        "propose_update",
        "reject_knowledge",
        "search_knowledge",
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
pnpm run build
pnpm test -- review-tools
```

Expected: FAIL。`reject_knowledge` が未登録。

- [ ] **Step 3: `reject_knowledge` を実装する**

`packages/mcp-server/src/server.ts` の import に `reject` を追加し、`approve_knowledge` の登録の直後に追加:

```ts
  server.registerTool(
    "reject_knowledge",
    {
      title: "知識の却下",
      description:
        "レビューで却下する。物理削除はせず deprecated にし、却下理由を記録として残す。実行するとユーザーに確認ダイアログが出る。reason には「なぜ誤りなのか」を具体的に書くこと(この理由自体が後から参照される知識になる)。",
      inputSchema: {
        id: z.string().uuid(),
        reason: z.string().describe("却下する理由。記録に残る"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ id, reason }) => {
      try {
        const target = await reviewTarget(id);
        if (!target) return text(`知識レコードが見つかりません: ${id}`);
        const outcome = await requireHumanApproval(
          server,
          `この知識を却下しますか?\n却下理由: ${reason}`,
          target,
        );
        if (!outcome.ok) return text(outcome.message);
        return text(await reject(id, reason, outcome.reviewer));
      } catch (e) {
        return fail(e);
      }
    },
  );
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
pnpm run build
pnpm test -- review-tools
```

Expected: PASS。

- [ ] **Step 5: コミット**

```bash
pnpm run lint:fix
git add packages/mcp-server
git commit -m "feat(mcp): 却下理由を必須にした reject_knowledge を追加"
```

---

### Task 6: `verify_knowledge`

**Files:**
- Modify: `packages/mcp-server/src/server.ts`
- Modify: `packages/mcp-server/tests/integration/review-tools.test.ts`

**Interfaces:**
- Consumes: `setVerification(id, level, by)`(既存 core 関数)、`requireHumanApproval()` / `reviewTarget()`(Task 4)

- [ ] **Step 1: 失敗するテストを書く**

`review-tools.test.ts` に追加:

```ts
describe("verify_knowledge", () => {
  test("accept すると検証レベルが expert に上がる", async () => {
    const id = await seedDraft({ context: "legal", title: "源泉徴収" });
    const client = await connectWithElicitation(() => ({
      action: "accept",
      content: { reviewer: "山田税理士" },
    }));

    const res = await client.callTool({
      name: "verify_knowledge",
      arguments: { id, level: "expert" },
    });

    assert.match(textOf(res), /expert/);
    const row = (await pool.query("select * from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.verification, "expert");
    assert.equal(row.verified_by, "山田税理士");
  });

  test("decline すると DB は変化しない", async () => {
    const id = await seedDraft({ context: "legal", title: "源泉徴収" });
    const client = await connectWithElicitation(() => ({ action: "decline" }));

    const res = await client.callTool({
      name: "verify_knowledge",
      arguments: { id, level: "expert" },
    });

    assert.match(textOf(res), /承認しませんでした/);
    const row = (await pool.query("select verification from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.verification, "none");
  });
});
```

ツール一覧テストの期待値に `"verify_knowledge",` を追加する(末尾、`upsert_context` の次):

```ts
        "upsert_context",
        "verify_knowledge",
      ],
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
pnpm run build
pnpm test -- review-tools
```

Expected: FAIL。`verify_knowledge` が未登録。

- [ ] **Step 3: `verify_knowledge` を実装する**

`packages/mcp-server/src/server.ts` の import に `setVerification` を追加し、`reject_knowledge` の登録の直後に追加:

```ts
  server.registerTool(
    "verify_knowledge",
    {
      title: "検証レベルの設定",
      description:
        "知識の検証レベルを設定する。internal=社内で確認済 / expert=外部専門家(税理士・弁護士等)が確認済。承認(status)とは別軸で、内容をどこまで信用してよいかを表す。expert は実際に専門家の確認を得た場合にのみ使うこと。実行するとユーザーに確認ダイアログが出る。",
      inputSchema: {
        id: z.string().uuid(),
        level: z.enum(["internal", "expert"]),
      },
      annotations: { idempotentHint: true },
    },
    async ({ id, level }) => {
      try {
        const target = await reviewTarget(id);
        if (!target) return text(`知識レコードが見つかりません: ${id}`);
        const outcome = await requireHumanApproval(
          server,
          `この知識の検証レベルを ${level} にしますか?`,
          target,
        );
        if (!outcome.ok) return text(outcome.message);
        return text(await setVerification(id, level, outcome.reviewer));
      } catch (e) {
        return fail(e);
      }
    },
  );
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
pnpm run build
pnpm test -- review-tools
pnpm run typecheck
```

Expected: すべて PASS。ツールは11本になる。

- [ ] **Step 5: コミット**

```bash
pnpm run lint:fix
git add packages/mcp-server
git commit -m "feat(mcp): 検証レベルを設定する verify_knowledge を追加"
```

---

### Task 7: CLI 2パッケージを削除する

**Files:**
- Delete: `packages/cli/`、`packages/import/`
- Modify: `package.json`(ルート)
- Modify: `.env.example`(**ユーザーに依頼する** — 権限設定によりエージェントは操作できない)

- [ ] **Step 1: パッケージを削除する**

```bash
git rm -r packages/cli packages/import
```

- [ ] **Step 2: ルート `package.json` からスクリプトを消す**

`scripts` から `import` と `review` の2行を削除する。削除後:

```json
  "scripts": {
    "build": "pnpm -r build",
    "typecheck": "pnpm run build && pnpm -r run typecheck:tests",
    "mcp": "pnpm --filter @kukv/koto-mcp start",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "test": "vitest run"
  },
```

- [ ] **Step 3: lockfile を更新する**

```bash
pnpm install
```

- [ ] **Step 4: 全体が通ることを確認する**

```bash
pnpm run build
pnpm run typecheck
pnpm test
```

Expected: すべて PASS。`packages/import/tests/unit/extract.test.ts` が消えた分テスト数は減る。`packages/core` と `packages/mcp-server` のテストはすべて緑。

- [ ] **Step 5: `.env.example` の更新をユーザーに依頼する**

`.env.example` は権限設定によりエージェントが読み書きできない。次を**ユーザーに依頼する**:

> `.env.example` から `EXTRACT_PROVIDER` / `EXTRACT_MODEL` / `ANTHROPIC_API_KEY` の行を削除し、`KOTO_REVIEWER=あなたの名前`(承認ダイアログの既定値)を追加してください。`!` プレフィックスでエディタを開くか、直接編集をお願いします。

ユーザーの対応を待ってから次のステップへ進む。

- [ ] **Step 6: コミット**

```bash
pnpm run lint:fix
git add -A
git commit -m "refactor: レビュー CLI とバッチインポート CLI を削除"
```

---

### Task 8: ドキュメントを更新する

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `skills/koto-import/SKILL.md:38`
- Modify: `docs/業務知識基盤_設計記録.md`

- [ ] **Step 1: `README.md` を更新する**

次の4箇所を直す。

1. 冒頭の構成ツリーから `packages/import/` と `packages/cli/` の行を削除する
2. 「セットアップ」の `pnpm build` の説明文 `(import / review / mcp の実行前に必須)` を `(mcp の実行前に必須)` に変える
3. 「MCPサーバの接続」の登録例に `KOTO_REVIEWER` を追加する:

```bash
claude mcp add koto \
  --env DATABASE_URL=postgres://koto:koto@localhost:5432/koto \
  --env KOTO_REVIEWER=あなたの名前 \
  -- node /絶対パス/koto/packages/mcp-server/dist/mcp-server.js
```

ツール一覧の行を11本に更新する:

> ツール一覧: `search_knowledge` / `get_knowledge` / `list_contexts` / `upsert_context` / `propose_knowledge` / `propose_update` / `add_relation` / `get_pending_reviews` / `approve_knowledge` / `verify_knowledge` / `reject_knowledge`

4. 「運用の流れ」の**導線1のバッチ CLI 段落**(`pnpm run import` のコードブロックとその前後2段落)と、**「レビュー(承認ゲート)」節のコードブロック**を削除し、次の内容に差し替える:

````markdown
**レビュー(承認ゲート)**

レビューはエージェントとの対話で行います。

> レビュー待ちを見せて → (内容を確認・修正) → これを承認して

承認・却下・検証レベルの設定は MCP ツール(`approve_knowledge` / `reject_knowledge` / `verify_knowledge`)から行いますが、**実行するとサーバが確認ダイアログを出し、ユーザー自身が確認者名を入力するまで DB は変更されません**。エージェントが勝手に承認することはできません。確認者名の既定値は環境変数 `KOTO_REVIEWER` で設定できます。

この確認ダイアログは MCP の elicitation を使っています。elicitation に対応していないクライアント(Claude Desktop など)からは、承認・却下・検証レベルの設定は実行できません。

承認済み(approved)だけが検索のデフォルト対象です。検証レベルは3段階(none=未検証 / internal=社内確認済 / expert=専門家確認済)で、レコードの内容が更新されると自動でnoneに戻ります(専門家確認は旧版に対するものだから)。却下は物理削除せず deprecated にし、却下理由を記録に残します。
````

- [ ] **Step 2: `CLAUDE.md` を更新する**

「コマンド」ブロックから `pnpm run import` と `pnpm run review` の2行を削除する。「構成」から `packages/import/` と `packages/cli/` の2行を削除する。「規約」の**エージェントの書き込みは必ず draft**の項に一文を足す:

```markdown
- **エージェントの書き込みは必ず draft**: `status=draft` + `needs_review=true` で入れる。approved に直接入れない。承認系ツール(`approve_knowledge` / `reject_knowledge` / `verify_knowledge`)は elicitation でユーザーの確認を必ず取る — この確認を迂回する実装を入れない
```

- [ ] **Step 3: `skills/koto-import/SKILL.md` を更新する**

38行目を次に置き換える:

```markdown
- 登録はすべて draft として入る。承認するかどうかはユーザーの判断 — `approve_knowledge` を呼ぶと確認ダイアログが出るので、ユーザーが承認を求めたときだけ呼ぶこと
```

- [ ] **Step 4: 設計記録に決定を追記する**

`docs/業務知識基盤_設計記録.md` の末尾に追記する(既存の記述は履歴なので書き換えない):

```markdown
## 追記 2026-08-09: 承認フローの MCP 移管と CLI 廃止

レビュー CLI の固有機能は `approve` / `verify` / `reject` の3つだけで、`list` / `show` は既存 MCP ツールで代替できた。2.4 に書いた「CLI直よりエージェントとの対話でレビュー」を実装するため、この3つを MCP ツール化し、`packages/cli` と `packages/import`(主経路がエージェント対話に移り役目を終えた)を削除した。

人間の確認は MCP の elicitation でサーバ側から強制する。クライアントの permission 設定に依存させないのは、(a) 利用者が settings.json を書き換えれば消えてしまうこと、(b) 複数マシンで使う際に設定を配る手間が生じることの2点による。確認者名はツール引数ではなくダイアログのフォームで人間に入力させるため、`verified_by` に入るのは必ず人間がその場で打った値になる。

副次的な効果として、他リポジトリでの作業からレビューするために koto リポジトリへ `cd` する必要がなくなった。残る「MCP 登録の絶対パス」「更新のたびの `pnpm build`」は配布方式の問題であり、別途設計する。
```

- [ ] **Step 5: 記述と実装が食い違っていないか確認する**

```bash
grep -rn 'pnpm run review\|pnpm run import\|npm run review\|npm run import\|packages/cli\|packages/import' README.md CLAUDE.md skills/
```

Expected: 出力なし(設計記録 `docs/` は履歴なので対象外)。

- [ ] **Step 6: コミット**

```bash
git add README.md CLAUDE.md skills/koto-import/SKILL.md docs/業務知識基盤_設計記録.md
git commit -m "docs: 承認フローの MCP 移管と CLI 廃止を反映"
```

---

## 完了条件

- [ ] `pnpm run build` が通る
- [ ] `pnpm run typecheck` が通る
- [ ] `pnpm test` が全件 PASS
- [ ] `pnpm run lint` が通る
- [ ] 実機確認: MCP を再登録し、`propose_knowledge` で draft を作ってから `approve_knowledge` を呼び、確認ダイアログが出ること・承認後に `search_knowledge` の既定検索でヒットすることを確認する
- [ ] 実機確認: ダイアログをキャンセルしたとき draft のまま変わらないこと
