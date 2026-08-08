# テスト基盤導入 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** koto に `node:test` ベースのテスト基盤(単体 + DB 統合)を新規依存ゼロで導入する。

**Architecture:** テストランナーは Node 24 組み込みの `node:test` + `node:assert`、tsx 経由で TypeScript を直接実行。DB 統合テストは既存 compose の db コンテナ内にテスト専用 DB `koto_test` を作って実 SQL(PGroonga 含む)を検証する。外部 API(OpenAI / Anthropic)は fetch モックの単体テストでカバーする。

**Tech Stack:** node:test / node:assert(組み込み)、tsx(既存)、pg(既存)、PGroonga + pgvector(既存 Docker イメージ)

**Spec:** `docs/superpowers/specs/2026-08-08-test-introduction-design.md`

## 実行状況(2026-08-08 時点)

- Task 1〜6: すべて実装・レビュー承認済み(全 38 テスト PASS、typecheck / lint 通過、開発 DB 非汚染を確認)
- 付随修正: Docker イメージのビルド不能(`postgresql-18-pgdg-pgroonga` へのパッケージ名変更)と postgres:18 のマウント規約変更に対応(commit `48ea048`)

## Global Constraints

- 新規 npm 依存を追加しない(テストは `node:test` / `node:assert` のみで書く)
- パッケージ管理は pnpm(npm は使わない)
- 開発 DB `koto` のデータに触れない。統合テストの接続先は `koto_test` のみ
- `docker/db/init/001_schema.sql` と `docker/db/migrations/*` は変更しない。setup-db が適用するのは **001 のみ**(migrations は旧スキーマの既存 DB 向けで、fresh な DB に重ねるとエラーになる)
- テスト実行時は `EMBEDDING_PROVIDER=none`(埋め込みなし経路のみ統合テスト)
- `status='approved'` のテストデータは SQL 直接挿入で作る(`propose()` は規約どおり draft しか作らない)
- knowledge テーブルには `unique (context, type, title)` 制約がある。テストデータは title か type を変えて衝突を避ける
- 各タスク完了時に `pnpm run typecheck` と `pnpm run lint` が通ること
- 統合テストの前提: `docker compose up -d` で db コンテナが起動済みであること

## 実行の前提知識(全タスク共通)

- **テストは既存コードに対して書く**。TDD の「失敗するテストを先に書く」とは異なり、テストは書いた時点で通るはず。**通らない場合はテスト側のバグをまず疑い、原因を特定してから直す**(実装側のバグを見つけたらタスクを止めてユーザーに報告する)
- import は ESM 規約で `.js` 拡張子を付ける(例: `../../src/embeddings.js`)。tsx が `.ts` に解決する
- `node --test` はデフォルトでテストファイルを並列プロセス実行する。共有 DB を使うため `--test-concurrency=1` で直列化する(test スクリプトに含まれている)

---

### Task 1: テスト実行基盤(setup-db + ヘルパ + スモークテスト)

**Files:**
- Create: `tests/helpers/setup-db.ts`
- Create: `tests/helpers/db.ts`
- Create: `tests/integration/smoke.test.ts`
- Modify: `package.json`(scripts に `test` を追加)
- Modify: `tsconfig.json`(include に `tests` を追加)
- Modify: `biome.json`(files.includes に `tests/**/*.ts` を追加)

**Interfaces:**
- Produces: `tests/helpers/db.ts` が後続タスクに提供するもの:
  - `pool`(`src/db.js` の pg Pool の再エクスポート。`DATABASE_URL` 経由で `koto_test` に接続)
  - `truncateAll(): Promise<void>` — 全テーブルを truncate
  - `seedContext(name: string): Promise<void>` — contexts へ upsert
  - `seedKnowledge(k: { context: string; title: string; type?: string; body?: string; english_name?: string; aliases?: { name: string; kind: string }[]; status?: string }): Promise<string>` — knowledge へ直接挿入し id を返す。既定: `type="term"`, `body="本文"`, `status="approved"`
- Produces: `pnpm test` コマンド(setup-db 実行 → 全テスト直列実行)

- [ ] **Step 1: `tests/helpers/setup-db.ts` を作成**

```typescript
import { readFileSync } from "node:fs";
import pg from "pg";

// 既存 db コンテナの開発 DB(koto)に管理接続し、テスト専用 DB koto_test を作り直す。
// migrations は旧スキーマで初期化済みの既存 DB 向けなので適用しない。
// 001_schema.sql が最新の完全スキーマ(compose の初期化と同一)。
const admin = new pg.Client({
  connectionString: process.env.ADMIN_DATABASE_URL ?? "postgres://koto:koto@localhost:5432/koto",
});
try {
  await admin.connect();
} catch (err) {
  console.error("DB に接続できません。先に `docker compose up -d` を実行してください。");
  console.error(String(err));
  process.exit(1);
}
await admin.query("drop database if exists koto_test with (force)");
await admin.query("create database koto_test");
await admin.end();

const testDb = new pg.Client({
  connectionString: "postgres://koto:koto@localhost:5432/koto_test",
});
await testDb.connect();
await testDb.query(readFileSync("docker/db/init/001_schema.sql", "utf8"));
await testDb.end();
console.log("koto_test を初期化しました");
```

- [ ] **Step 2: `tests/helpers/db.ts` を作成**

```typescript
import { pool } from "../../src/db.js";

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

export async function seedContext(name: string) {
  await pool.query("insert into contexts (name) values ($1) on conflict (name) do nothing", [name]);
}

export interface SeedKnowledgeInput {
  context: string;
  title: string;
  type?: string;
  body?: string;
  english_name?: string;
  aliases?: { name: string; kind: string }[];
  status?: string;
}

/** approved を含む任意ステータスの knowledge を直接挿入する(propose は draft しか作らないため) */
export async function seedKnowledge(k: SeedKnowledgeInput): Promise<string> {
  await seedContext(k.context);
  const res = await pool.query(
    `insert into knowledge (type, context, title, english_name, body, aliases, status)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7) returning id`,
    [
      k.type ?? "term",
      k.context,
      k.title,
      k.english_name ?? null,
      k.body ?? "本文",
      JSON.stringify(k.aliases ?? []),
      k.status ?? "approved",
    ],
  );
  return res.rows[0].id as string;
}

export { pool };
```

- [ ] **Step 3: `tests/integration/smoke.test.ts` を作成**

```typescript
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { pool } from "../helpers/db.js";

after(() => pool.end());

test("koto_test に必要な拡張とテーブルが揃っている", async () => {
  const ext = await pool.query("select extname from pg_extension");
  const extensions = ext.rows.map((r) => r.extname);
  assert.ok(extensions.includes("pgroonga"));
  assert.ok(extensions.includes("vector"));

  const res = await pool.query("select tablename from pg_tables where schemaname = 'public'");
  const tables = res.rows.map((r) => r.tablename);
  for (const required of ["contexts", "knowledge", "knowledge_relations", "knowledge_revisions"]) {
    assert.ok(tables.includes(required), `テーブルがありません: ${required}`);
  }
});
```

- [ ] **Step 4: `package.json` の scripts に `test` を追加**

`"typecheck"` の行の上に追加:

```json
    "test": "tsx tests/helpers/setup-db.ts && DATABASE_URL=postgres://koto:koto@localhost:5432/koto_test EMBEDDING_PROVIDER=none node --import tsx --test --test-concurrency=1 'tests/**/*.test.ts'",
```

- [ ] **Step 5: `tsconfig.json` の include を変更**

```json
  "include": ["src", "tests"]
```

- [ ] **Step 6: `biome.json` の files.includes を変更**

```json
  "files": {
    "includes": ["src/**/*.ts", "tests/**/*.ts"]
  },
```

- [ ] **Step 7: DB 起動を確認してテストを実行**

Run: `docker compose up -d && pnpm test`
Expected: `koto_test を初期化しました` の後、smoke テスト 1 件が PASS(`# pass 1`)

- [ ] **Step 8: typecheck と lint を実行**

Run: `pnpm run typecheck && pnpm run lint`
Expected: どちらもエラーなし

- [ ] **Step 9: Commit**

```bash
git add tests/ package.json tsconfig.json biome.json
git commit -m "test: node:test ベースのテスト実行基盤を追加(koto_test セットアップとスモークテスト)"
```

---

### Task 2: embeddings の単体テスト

**Files:**
- Create: `tests/unit/embeddings.test.ts`

**Interfaces:**
- Consumes: `src/embeddings.js` の `embed(text: string): Promise<number[] | null>`, `toVectorLiteral(v: number[]): string`
- Produces: なし(末端タスク)

- [ ] **Step 1: `tests/unit/embeddings.test.ts` を作成**

環境変数は各テストで設定し、`afterEach` で復元する(テストプロセス全体は `EMBEDDING_PROVIDER=none` で起動されている点に注意)。fetch のモックは `t.mock.method` を使う(テスト終了時に自動復元される)。

```typescript
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { embed, toVectorLiteral } from "../../src/embeddings.js";

const saved = {
  provider: process.env.EMBEDDING_PROVIDER,
  key: process.env.OPENAI_API_KEY,
};

function setEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  setEnv("EMBEDDING_PROVIDER", saved.provider);
  setEnv("OPENAI_API_KEY", saved.key);
});

describe("embed", () => {
  test("EMBEDDING_PROVIDER=none なら null を返す", async () => {
    setEnv("EMBEDDING_PROVIDER", "none");
    setEnv("OPENAI_API_KEY", "dummy");
    assert.equal(await embed("テスト"), null);
  });

  test("OPENAI_API_KEY 未設定なら null を返す", async () => {
    setEnv("EMBEDDING_PROVIDER", "openai");
    setEnv("OPENAI_API_KEY", undefined);
    assert.equal(await embed("テスト"), null);
  });

  test("正常系: API の埋め込みを返す", async (t) => {
    setEnv("EMBEDDING_PROVIDER", "openai");
    setEnv("OPENAI_API_KEY", "test-key");
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 }),
    );
    assert.deepEqual(await embed("テスト"), [0.1, 0.2, 0.3]);
  });

  test("API エラーなら null を返す", async (t) => {
    setEnv("EMBEDDING_PROVIDER", "openai");
    setEnv("OPENAI_API_KEY", "test-key");
    t.mock.method(
      globalThis,
      "fetch",
      async () => new Response("rate limited", { status: 429 }),
    );
    assert.equal(await embed("テスト"), null);
  });
});

describe("toVectorLiteral", () => {
  test("pgvector リテラル形式に変換する", () => {
    assert.equal(toVectorLiteral([1, -2.5, 3]), "[1,-2.5,3]");
  });
});
```

- [ ] **Step 2: テストを実行**

Run: `EMBEDDING_PROVIDER=none node --import tsx --test tests/unit/embeddings.test.ts`
Expected: 5 件すべて PASS

- [ ] **Step 3: typecheck と lint を実行**

Run: `pnpm run typecheck && pnpm run lint`
Expected: どちらもエラーなし

- [ ] **Step 4: Commit**

```bash
git add tests/unit/embeddings.test.ts
git commit -m "test: embeddings の単体テストを追加(fetch モック)"
```

---

### Task 3: extract の単体テスト

**Files:**
- Create: `tests/unit/extract.test.ts`

**Interfaces:**
- Consumes: `src/import/extract.js` の `extractCandidates(docText: string): Promise<ExtractedCandidate[]>`, `chunkDocument(text: string, maxChars?: number): string[]`
- Produces: なし(末端タスク)

- [ ] **Step 1: `tests/unit/extract.test.ts` を作成**

```typescript
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { chunkDocument, extractCandidates } from "../../src/import/extract.js";

const savedKey = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

function mockAnthropicResponse(text: string, status = 200) {
  return async () =>
    new Response(
      status === 200 ? JSON.stringify({ content: [{ type: "text", text }] }) : "bad request",
      { status },
    );
}

describe("extractCandidates", () => {
  test("ANTHROPIC_API_KEY 未設定ならエラー", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await assert.rejects(extractCandidates("文書"), /ANTHROPIC_API_KEY/);
  });

  test("正常系: JSON 配列をパースして返す", async (t) => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const json = JSON.stringify([{ type: "term", title: "受注", body: "定義" }]);
    t.mock.method(globalThis, "fetch", mockAnthropicResponse(json));
    const result = await extractCandidates("文書");
    assert.equal(result.length, 1);
    assert.equal(result[0].title, "受注");
  });

  test("コードフェンス付きの応答も除去してパースする", async (t) => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const json = JSON.stringify([{ type: "faq", title: "質問", body: "回答" }]);
    t.mock.method(globalThis, "fetch", mockAnthropicResponse("```json\n" + json + "\n```"));
    const result = await extractCandidates("文書");
    assert.equal(result[0].type, "faq");
  });

  test("API エラーならエラーを投げる", async (t) => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    t.mock.method(globalThis, "fetch", mockAnthropicResponse("", 400));
    await assert.rejects(extractCandidates("文書"), /Anthropic API error: 400/);
  });

  test("JSON でない応答はパース失敗エラーを投げる", async (t) => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    t.mock.method(globalThis, "fetch", mockAnthropicResponse("これはJSONではありません"));
    await assert.rejects(extractCandidates("文書"), /JSONパースに失敗/);
  });
});

describe("chunkDocument", () => {
  test("maxChars 以下の文書はそのまま 1 チャンク", () => {
    assert.deepEqual(chunkDocument("短い文書"), ["短い文書"]);
  });

  test("見出し境界で分割され、結合すると元の文書に戻る", () => {
    const section = (name: string) => `## ${name}\n${"あ".repeat(30)}\n`;
    const doc = section("一") + section("二") + section("三");
    const chunks = chunkDocument(doc, 40);
    assert.ok(chunks.length > 1);
    assert.equal(chunks.join(""), doc);
    for (const c of chunks) {
      assert.ok(c.startsWith("## "), `チャンクが見出しで始まっていない: ${c.slice(0, 10)}`);
    }
  });
});
```

- [ ] **Step 2: テストを実行**

Run: `EMBEDDING_PROVIDER=none node --import tsx --test tests/unit/extract.test.ts`
Expected: 7 件すべて PASS

- [ ] **Step 3: typecheck と lint を実行**

Run: `pnpm run typecheck && pnpm run lint`
Expected: どちらもエラーなし

- [ ] **Step 4: Commit**

```bash
git add tests/unit/extract.test.ts
git commit -m "test: 文書抽出(extractCandidates / chunkDocument)の単体テストを追加"
```

---

### Task 4: knowledge 統合テスト(propose / findDuplicates / proposeUpdate)

**Files:**
- Create: `tests/integration/knowledge.test.ts`
- Test 実行前提: `docker compose up -d` 済み

**Interfaces:**
- Consumes: `tests/helpers/db.js` の `pool` / `truncateAll()` / `seedKnowledge()`(Task 1 参照)、`src/knowledge.js` の `propose` / `findDuplicates` / `proposeUpdate`
- Produces: `tests/integration/knowledge.test.ts` のファイル構造(トップレベルの `beforeEach(truncateAll)` と `after(() => pool.end())`)。Task 5 はこのファイルに describe を追記する

- [ ] **Step 1: `tests/integration/knowledge.test.ts` を作成**

`EMBEDDING_PROVIDER=none` で実行されるため `propose` 内の `embed()` は null を返し、埋め込みなし経路(名前一致の重複検出のみ)をテストする。

```typescript
import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";
import { findDuplicates, propose, proposeUpdate } from "../../src/knowledge.js";
import { pool, seedKnowledge, truncateAll } from "../helpers/db.js";

beforeEach(truncateAll);
after(() => pool.end());

describe("propose", () => {
  test("draft として登録され needs_review が立つ", async () => {
    const { id, duplicates } = await propose({
      type: "term",
      context: "sales",
      title: "受注",
      body: "顧客からの注文を受け付けること",
    });
    assert.equal(duplicates.length, 0);
    const row = (await pool.query("select * from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.status, "draft");
    assert.equal(row.needs_review, true);
    assert.equal(row.created_by, "agent");
  });

  test("未知のコンテキストは contexts に自動登録される", async () => {
    await propose({ type: "term", context: "new-context", title: "用語", body: "定義" });
    const res = await pool.query("select owner from contexts where name = 'new-context'");
    assert.equal(res.rowCount, 1);
    assert.equal(res.rows[0].owner, null);
  });

  test("同名の既存レコードがあると duplicates と review_notes に載る", async () => {
    await seedKnowledge({ context: "sales", title: "受注", type: "term" });
    // 注意: unique (context, type, title) があるため type を変えて衝突を避ける
    const { id, duplicates } = await propose({
      type: "rule",
      context: "sales",
      title: "受注",
      body: "ルール本文",
    });
    assert.equal(duplicates.length, 1);
    assert.match(String(duplicates[0].reason), /同名または別名/);
    const row = (await pool.query("select review_notes from knowledge where id = $1", [id]))
      .rows[0];
    assert.match(row.review_notes, /重複候補/);
  });
});

describe("findDuplicates", () => {
  test("タイトルは大文字小文字を無視して一致する", async () => {
    await seedKnowledge({ context: "sales", title: "Order" });
    const dups = await findDuplicates("order", "sales", null);
    assert.equal(dups.length, 1);
  });

  test("別名(alias)も一致対象になる", async () => {
    await seedKnowledge({
      context: "sales",
      title: "受注",
      aliases: [{ name: "オーダー", kind: "synonym" }],
    });
    const dups = await findDuplicates("オーダー", "sales", null);
    assert.equal(dups.length, 1);
  });

  test("別コンテキストの同名は対象外", async () => {
    await seedKnowledge({ context: "sales", title: "受注" });
    const dups = await findDuplicates("受注", "support", null);
    assert.equal(dups.length, 0);
  });
});

describe("proposeUpdate", () => {
  test("存在しない id はエラー", async () => {
    await assert.rejects(
      proposeUpdate("00000000-0000-0000-0000-000000000000", { body: "x" }),
      /見つかりません/,
    );
  });

  test("部分更新がマージされ needs_review が立つ", async () => {
    const id = await seedKnowledge({ context: "sales", title: "受注", body: "旧本文" });
    await proposeUpdate(id, { body: "新本文" }, "定義を明確化");
    const row = (await pool.query("select * from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.body, "新本文");
    assert.equal(row.title, "受注"); // 未指定の項目は維持される
    assert.equal(row.needs_review, true);
    assert.match(row.review_notes, /更新提案: 定義を明確化/);
  });

  test("内容(body 等)の変更で verification がリセットされる", async () => {
    const id = await seedKnowledge({ context: "sales", title: "受注" });
    await pool.query(
      "update knowledge set verification = 'expert', verified_by = '専門家' where id = $1",
      [id],
    );
    await proposeUpdate(id, { body: "変更後" });
    const row = (await pool.query("select * from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.verification, "none");
    assert.equal(row.verified_by, null);
  });

  test("内容以外(aliases)の変更では verification が維持される", async () => {
    const id = await seedKnowledge({ context: "sales", title: "受注" });
    await pool.query("update knowledge set verification = 'expert' where id = $1", [id]);
    await proposeUpdate(id, { aliases: [{ name: "オーダー", kind: "synonym" }] });
    const row = (await pool.query("select * from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.verification, "expert");
  });

  test("更新時に revisions へ更新前の内容が保存される", async () => {
    const id = await seedKnowledge({ context: "sales", title: "受注", body: "旧本文" });
    await proposeUpdate(id, { body: "新本文" });
    const res = await pool.query(
      "select snapshot from knowledge_revisions where knowledge_id = $1",
      [id],
    );
    assert.equal(res.rowCount, 1);
    assert.equal(res.rows[0].snapshot.body, "旧本文");
  });
});
```

- [ ] **Step 2: テストを実行**

Run: `docker compose up -d && pnpm test`
Expected: smoke + 単体 + 本タスクの 11 件、すべて PASS

- [ ] **Step 3: typecheck と lint を実行**

Run: `pnpm run typecheck && pnpm run lint`
Expected: どちらもエラーなし

- [ ] **Step 4: Commit**

```bash
git add tests/integration/knowledge.test.ts
git commit -m "test: knowledge の DB 統合テストを追加(propose / findDuplicates / proposeUpdate)"
```

---

### Task 5: knowledge 統合テスト(参照系・関連・コンテキスト管理)

**Files:**
- Modify: `tests/integration/knowledge.test.ts`(ファイル末尾に describe を追記)

**Interfaces:**
- Consumes: Task 4 のファイル構造(トップレベル `beforeEach(truncateAll)` / `after(() => pool.end())` は定義済み。追記する describe にフックは書かない)。`src/knowledge.js` の `getKnowledge` / `addRelation` / `upsertContext` / `setVerification` / `listContexts` / `pendingReviews`
- Produces: なし(末端タスク)

- [ ] **Step 1: import 文を拡張**

`tests/integration/knowledge.test.ts` の import を以下に置き換える:

```typescript
import {
  addRelation,
  findDuplicates,
  getKnowledge,
  listContexts,
  pendingReviews,
  propose,
  proposeUpdate,
  setVerification,
  upsertContext,
} from "../../src/knowledge.js";
```

- [ ] **Step 2: ファイル末尾に describe を追記**

```typescript
describe("getKnowledge / addRelation", () => {
  test("存在しない id は null", async () => {
    assert.equal(await getKnowledge("00000000-0000-0000-0000-000000000000"), null);
  });

  test("関連が両方向に 1 ホップ展開される", async () => {
    const orderId = await seedKnowledge({ context: "sales", title: "受注確定", type: "event" });
    const stockId = await seedKnowledge({ context: "sales", title: "在庫" });
    await addRelation(orderId, stockId, "対象", "1..*");

    const fromSide = (await getKnowledge(orderId)) as { relations: Record<string, unknown>[] };
    assert.equal(fromSide.relations.length, 1);
    assert.equal(fromSide.relations[0].direction, "out");
    assert.equal(fromSide.relations[0].title, "在庫");
    assert.equal(fromSide.relations[0].label, "対象");

    const toSide = (await getKnowledge(stockId)) as { relations: Record<string, unknown>[] };
    assert.equal(toSide.relations[0].direction, "in");
    assert.equal(toSide.relations[0].title, "受注確定");
  });

  test("同じ関連の重複登録は無視される", async () => {
    const a = await seedKnowledge({ context: "sales", title: "A" });
    const b = await seedKnowledge({ context: "sales", title: "B" });
    await addRelation(a, b, "含む");
    await addRelation(a, b, "含む");
    const res = await pool.query("select count(*) from knowledge_relations");
    assert.equal(Number(res.rows[0].count), 1);
  });
});

describe("upsertContext", () => {
  test("新規登録と、未指定項目を維持した更新", async () => {
    await upsertContext("sales", { description: "販売", owner: "営業部" });
    const updated = await upsertContext("sales", { expert: "税理士" });
    assert.equal(updated.description, "販売"); // 未指定でも維持される
    assert.equal(updated.owner, "営業部");
    assert.equal(updated.expert, "税理士");
  });
});

describe("setVerification", () => {
  test("検証レベルが設定され needs_review が下りる", async () => {
    const id = await seedKnowledge({ context: "sales", title: "受注" });
    await pool.query("update knowledge set needs_review = true where id = $1", [id]);
    await setVerification(id, "internal", "田中");
    const row = (await pool.query("select * from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.verification, "internal");
    assert.equal(row.verified_by, "田中");
    assert.notEqual(row.verified_at, null);
    assert.equal(row.needs_review, false);
  });
});

describe("listContexts", () => {
  test("コンテキストごとの集計が返る", async () => {
    await seedKnowledge({ context: "sales", title: "受注", status: "approved" });
    await seedKnowledge({ context: "sales", title: "下書き", status: "draft" });
    const rows = await listContexts();
    const sales = rows.find((r: { context: string }) => r.context === "sales");
    assert.ok(sales);
    assert.equal(Number(sales.approved), 1);
    assert.equal(Number(sales.draft), 1);
    assert.ok(sales.types.includes("term"));
  });
});

describe("pendingReviews", () => {
  test("draft と needs_review のレコードだけが返る", async () => {
    const draftId = await seedKnowledge({ context: "sales", title: "下書き", status: "draft" });
    const flaggedId = await seedKnowledge({ context: "sales", title: "要確認", status: "approved" });
    await pool.query("update knowledge set needs_review = true where id = $1", [flaggedId]);
    await seedKnowledge({ context: "sales", title: "確定済み", status: "approved" });

    const rows = await pendingReviews();
    const ids = rows.map((r: { id: string }) => r.id);
    assert.ok(ids.includes(draftId));
    assert.ok(ids.includes(flaggedId));
    assert.equal(rows.length, 2);
  });
});
```

- [ ] **Step 3: テストを実行**

Run: `docker compose up -d && pnpm test`
Expected: 追加 7 件を含む全テストが PASS

- [ ] **Step 4: typecheck と lint を実行**

Run: `pnpm run typecheck && pnpm run lint`
Expected: どちらもエラーなし

- [ ] **Step 5: Commit**

```bash
git add tests/integration/knowledge.test.ts
git commit -m "test: knowledge の DB 統合テストを追加(参照系・関連・コンテキスト管理)"
```

---

### Task 6: search 統合テスト + ドキュメント更新 + 最終検証

**Files:**
- Create: `tests/integration/search.test.ts`
- Modify: `CLAUDE.md`(コマンド一覧に `pnpm test` を 1 行追加。それ以外は変更しない)

**Interfaces:**
- Consumes: `tests/helpers/db.js` の `pool` / `truncateAll()` / `seedKnowledge()`、`src/search.js` の `hybridSearch(query: string, opts?: { context?: string; type?: string; includeDrafts?: boolean; limit?: number })`
- Produces: なし(最終タスク)

- [ ] **Step 1: `tests/integration/search.test.ts` を作成**

`EMBEDDING_PROVIDER=none` のためキーワード検索(PGroonga)経路のみが動く。検索対象データは読み取り専用なので `before` で一度だけ投入する。

```typescript
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { hybridSearch } from "../../src/search.js";
import { pool, seedKnowledge, truncateAll } from "../helpers/db.js";

before(async () => {
  await truncateAll();
  await seedKnowledge({
    context: "sales",
    title: "受注",
    body: "顧客からの注文を受け付けること",
    aliases: [{ name: "オーダー", kind: "synonym" }],
  });
  await seedKnowledge({
    context: "sales",
    type: "event",
    title: "在庫引当",
    body: "受注に対して在庫を確保する",
  });
  await seedKnowledge({ context: "support", title: "問い合わせ", body: "顧客からの質問" });
  await seedKnowledge({
    context: "sales",
    title: "見積",
    body: "受注前に金額を提示する",
    status: "draft",
  });
  await seedKnowledge({
    context: "sales",
    title: "旧受注",
    body: "廃止された受注の概念",
    status: "deprecated",
  });
});
after(() => pool.end());

describe("hybridSearch(キーワード検索経路)", () => {
  test("既定では approved のみが返る(draft / deprecated は除外)", async () => {
    const titles = (await hybridSearch("受注")).map((r) => r.title);
    assert.ok(titles.includes("受注"));
    assert.ok(titles.includes("在庫引当")); // body の「受注」にヒット
    assert.ok(!titles.includes("見積")); // draft
    assert.ok(!titles.includes("旧受注")); // deprecated
  });

  test("includeDrafts で draft が含まれ deprecated は除外のまま", async () => {
    const titles = (await hybridSearch("受注", { includeDrafts: true })).map((r) => r.title);
    assert.ok(titles.includes("見積"));
    assert.ok(!titles.includes("旧受注"));
  });

  test("context で絞り込める", async () => {
    const rows = await hybridSearch("顧客", { context: "support" });
    assert.deepEqual(
      rows.map((r) => r.title),
      ["問い合わせ"],
    );
  });

  test("type で絞り込める", async () => {
    const rows = await hybridSearch("受注", { type: "event" });
    assert.deepEqual(
      rows.map((r) => r.title),
      ["在庫引当"],
    );
  });

  test("別名(alias)でもヒットする", async () => {
    const titles = (await hybridSearch("オーダー")).map((r) => r.title);
    assert.ok(titles.includes("受注"));
  });

  test("limit で件数を制限できる", async () => {
    const rows = await hybridSearch("受注", { limit: 1 });
    assert.equal(rows.length, 1);
  });

  test("excerpt は 400 文字に切り詰められる", async () => {
    await seedKnowledge({ context: "sales", title: "長文", body: "受注 ".repeat(500) });
    const rows = await hybridSearch("長文");
    const hit = rows.find((r) => r.title === "長文");
    assert.ok(hit);
    assert.ok(hit.excerpt.length <= 400);
  });
});
```

- [ ] **Step 2: テストを実行**

Run: `docker compose up -d && pnpm test`
Expected: 追加 7 件を含む全テストが PASS

- [ ] **Step 3: `CLAUDE.md` のコマンド一覧に 1 行追加**

`pnpm run typecheck` の行の直後に追加:

```
pnpm test                      # テスト実行(要 docker compose up -d。koto_test を作り直して単体+DB統合を直列実行)
```

- [ ] **Step 4: 最終検証(スペックの検証ゴールを確認)**

Run: `docker compose up -d && pnpm test && pnpm run typecheck && pnpm run lint`
Expected: すべて成功

開発 DB が汚れていないことの確認:

Run: `docker compose exec db psql -U koto -d koto -c "select count(*) from knowledge"`
Expected: テスト実行前と同じ件数(テストは koto_test のみに書き込む)

- [ ] **Step 5: Commit**

```bash
git add tests/integration/search.test.ts CLAUDE.md
git commit -m "test: hybridSearch の DB 統合テストを追加し CLAUDE.md にテストコマンドを記載"
```
