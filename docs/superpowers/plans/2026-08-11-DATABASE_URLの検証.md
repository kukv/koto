# DATABASE_URL の検証 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 壊れた `DATABASE_URL` を起動時に検出して明示的なエラーで止め、「最初のツール呼び出しまで失敗が遅れて `EAI_AGAIN base` としか出ない」状態を解消する。

**Architecture:** `packages/core/src/db.ts` に接続文字列を解決する純粋関数 `resolveConnectionString` を足し、`pg.Pool` 生成の引数に噛ませる。未設定なら既定値、`new URL()` でパースできないかスキームが `postgres:` / `postgresql:` 以外なら投げる。`pool` を作る場所と検証する場所を同じにすることで、経路によって検証が漏れない。

**Tech Stack:** TypeScript / node-postgres (pg 8.22) / vitest 4

設計の根拠は `docs/superpowers/specs/2026-08-11-DATABASE_URLの検証-design.md` を参照。

## Global Constraints

- パッケージ管理は **pnpm**。`npm` は使わない
- **この worktree で DB を新たに立てない。** メインチェックアウトの `koto-db-1` が port 5432 で稼働しており、衝突する。worktree からは `docker compose` のプロジェクト名がずれるため使わない。DB の状態を見るときは `docker exec -i koto-db-1 psql -U koto -d koto`
- テストの実行には DB が起動している必要がある。vitest の globalSetup が `koto_test` を作り直すため、**単体テストだけを流す場合も DB は要る**
- vitest の設定はリポジトリのルートにあり、パッケージ単位では走らない。1 ファイルを流すのは `pnpm exec vitest run <ファイルパス>`
- `resolveConnectionString` は `packages/core/src/index.ts` の公開 API に**追加しない**。`db.ts` の内部検証であり、パッケージ利用者向けの機能ではない。テストは `../../src/db.js` を直接 import する
- エラーメッセージに**受け取った値を含めない**。壊れているのは形式であって、パスワードを含む文字列が壊れている場合がある(spec 2.5)
- ホスト名の有無は判定に**使わない**。`postgres:///koto?host=/var/run/postgresql`(Unix ドメインソケット)はホストが空文字のまま正当(spec 2.3)
- 最後に `pnpm run lint:fix` を実行してから commit する

---

## ファイル構成

| ファイル | 役割 | 変更 |
|---|---|---|
| `packages/core/src/db.ts` | 接続プールの生成 | 修正(検証関数の追加と適用) |
| `packages/core/tests/unit/db.test.ts` | 検証関数の単体テスト | 新規 |

`packages/core/src/index.ts` / `vitest.config.ts` / `README.md` / `.env.example` / `docker/` 配下は変更しない(spec 3.2)。

## タスクの順序

1 タスクで完結する。検証関数とその適用は同じ deliverable であり、分けても片方だけをレビューで通す意味がない。

---

## Task 1: `DATABASE_URL` の形式を起動時に検証する

**Files:**
- Create: `packages/core/tests/unit/db.test.ts`
- Modify: `packages/core/src/db.ts:1-5`(現在は 5 行しかない。全体を置き換える)

**Interfaces:**
- Consumes: なし(既存タスクへの依存は無い)
- Produces: `resolveConnectionString(raw: string | undefined): string` — `db.ts` から export する。未設定(`undefined`)なら既定値 `"postgres://koto:koto@localhost:5432/koto"` を返し、形式が不正なら `Error` を投げ、正当ならば受け取った文字列をそのまま返す。既存の `export const pool` の型と挙動は変わらない

- [ ] **Step 1: 失敗するテストを書く**

`packages/core/tests/unit/db.test.ts` を新規作成する。同じディレクトリの `embeddings.test.ts` に合わせ、`node:assert/strict` と vitest の `describe` / `test` を使う。

```ts
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { resolveConnectionString } from "../../src/db.js";

const DEFAULT = "postgres://koto:koto@localhost:5432/koto";

describe("resolveConnectionString", () => {
  test("未設定なら既定値を返す", () => {
    assert.equal(resolveConnectionString(undefined), DEFAULT);
  });

  test("パースできない値は投げる", () => {
    assert.throws(() => resolveConnectionString("..."), /DATABASE_URL の形式が不正です/);
  });

  // 空文字は「指定していない」ではなく「値が消えている」。既定値へ落とすと意図しない DB に書き込む
  test("空文字は投げる", () => {
    assert.throws(() => resolveConnectionString(""), /DATABASE_URL の形式が不正です/);
  });

  test("postgres 以外のスキームは投げる", () => {
    assert.throws(
      () => resolveConnectionString("http://localhost/koto"),
      /DATABASE_URL のスキームが不正です/,
    );
  });

  // 生値をメッセージに混ぜると、認証情報が MCP クライアントのログに残る
  test("エラーメッセージに受け取った値を含めない", () => {
    assert.throws(
      () => resolveConnectionString("http://koto:s3cret@localhost/koto"),
      (err: unknown) => err instanceof Error && !err.message.includes("s3cret"),
    );
  });

  test("postgres: はそのまま返す", () => {
    assert.equal(resolveConnectionString(DEFAULT), DEFAULT);
  });

  test("postgresql: はそのまま返す", () => {
    const url = "postgresql://a:b@h:5432/d";
    assert.equal(resolveConnectionString(url), url);
  });

  // ホストの有無を条件に入れると、この正当な構成を弾いてしまう
  test("Unix ドメインソケット接続(ホストが空)を弾かない", () => {
    const url = "postgres:///koto?host=/var/run/postgresql";
    assert.equal(resolveConnectionString(url), url);
  });
});
```

- [ ] **Step 2: テストを実行して失敗することを確認する**

DB が起動していることを先に確かめる(globalSetup が `koto_test` を作り直すため、単体テストだけでも必要)。

Run: `docker ps --format '{{.Names}}' | grep koto-db-1`
Expected: `koto-db-1` が出力される。出なければメインのチェックアウト側で DB を起動してもらう

Run: `pnpm exec vitest run packages/core/tests/unit/db.test.ts`
Expected: FAIL。`resolveConnectionString` が `db.ts` から export されていないため、8 件すべてが失敗する(`resolveConnectionString is not a function`、または export が見つからない旨のエラー)

- [ ] **Step 3: 検証関数を実装して pool に適用する**

`packages/core/src/db.ts` の全体を次で置き換える。

```ts
import pg from "pg";

const DEFAULT_CONNECTION_STRING = "postgres://koto:koto@localhost:5432/koto";
const ALLOWED_PROTOCOLS = ["postgres:", "postgresql:"];
const FORMAT_HINT =
  "postgres://ユーザー:パスワード@ホスト:ポート/DB名 の形式で指定してください" +
  "(例: postgres://koto:koto@localhost:5432/koto)";

/**
 * DATABASE_URL を解決する。未設定なら既定値、形式が不正なら投げる。
 *
 * pg は接続文字列を new URL(str, "postgres://base") で解釈するため、`...` のような壊れた値でも
 * ホスト base として通る。new pg.Pool() は接続を張らないので生成も成功し、最初のクエリで初めて
 * `EAI_AGAIN base` として失敗する。起動時に弾いて原因を名指しする。
 *
 * 不正値を既定値へフォールバックさせないのは、意図しない DB に draft を書き込む方が、
 * 繋がらないことより害が大きいため。エラーメッセージに受け取った値は含めない(認証情報が残る)。
 */
export function resolveConnectionString(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_CONNECTION_STRING;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`DATABASE_URL の形式が不正です。${FORMAT_HINT}`);
  }
  // ホストの有無は見ない。postgres:///db?host=/var/run/postgresql は空ホストのまま正当
  if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
    throw new Error(
      `DATABASE_URL のスキームが不正です。postgres: または postgresql: を期待しましたが ${url.protocol} でした。${FORMAT_HINT}`,
    );
  }
  return raw;
}

export const pool = new pg.Pool({
  connectionString: resolveConnectionString(process.env.DATABASE_URL),
});
```

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `pnpm exec vitest run packages/core/tests/unit/db.test.ts`
Expected: PASS。8 件すべて成功

- [ ] **Step 5: 既存のテストと型検査が壊れていないことを確認する**

Run: `pnpm run build`
Expected: 全パッケージがエラーなく終わる

Run: `pnpm run typecheck`
Expected: エラーなし(新規テストファイルの型も含めて検査される)

Run: `pnpm test`
Expected: 全テストが PASS。`db.test.ts` の 8 件が増え、既存の失敗は無い

- [ ] **Step 6: 手で壊れた値を渡して、意図したエラーが出ることを確認する**

計画どおり実装できていても、モジュールの読み込みだけで実際に止まるかはテストでは分からない(spec 2.4 が解消しようとしている症状はここ)。Step 5 の `pnpm run build` で出力された `dist` を直接読み込んで確かめる。このリポジトリに `tsx` は入っていないので、ソースを直接実行する形は使えない。

修正前の実測はこうだった(壊れた値でも読み込みが成功してしまう)。

```
$ DATABASE_URL=... node -e 'import("./packages/core/dist/db.js").then(m => console.log("読み込み成功: pool =", typeof m.pool))'
読み込み成功: pool = object
```

Run: `DATABASE_URL=... node -e 'import("./packages/core/dist/db.js")' 2>&1 | head -20`
Expected: `DATABASE_URL の形式が不正です。postgres://ユーザー:パスワード@ホスト:ポート/DB名 の形式で指定してください(例: postgres://koto:koto@localhost:5432/koto)` を含むエラーで終わる。`EAI_AGAIN base` は出ない

Run: `DATABASE_URL=http://koto:s3cret@localhost/koto node -e 'import("./packages/core/dist/db.js")' 2>&1 | head -20`
Expected: `DATABASE_URL のスキームが不正です。postgres: または postgresql: を期待しましたが http: でした。` を含むエラーで終わる。出力のどこにも `s3cret` が現れない

- [ ] **Step 7: lint をかけて commit する**

Run: `pnpm run lint:fix`
Expected: 変更が入るか、`Checked N files` で終わる

```bash
git add packages/core/src/db.ts packages/core/tests/unit/db.test.ts
git commit -m "$(cat <<'EOF'
fix(core): 壊れた DATABASE_URL を起動時に弾く

pg は接続文字列を new URL(str, "postgres://base") で解釈するため、`...`
のような値でもホスト base として通り、Pool 生成も成功する。失敗は最初の
クエリまで遅れ、EAI_AGAIN base という追えないエラーだけが出ていた。

起動時に形式を検証して投げる。未設定のときだけ既定値へ落とす。不正値を
フォールバックさせないのは、意図しない DB に draft を書き込む方が繋がらない
ことより害が大きいため。判定はパース不能とスキーム違いの 2 つに絞り、ホストの
有無は見ない(Unix ソケット接続を弾かないため)。メッセージに受け取った値は
含めない(認証情報が stderr に残るため)。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RtRwzdB3vEae9tK6WjzXkS
EOF
)"
```

---

## 完了条件

- `pnpm test` が全件 PASS し、`packages/core/tests/unit/db.test.ts` の 8 件が含まれる
- `pnpm run build` と `pnpm run typecheck` がエラーなく通る
- `DATABASE_URL=...` で `db.ts` を読み込むと、`DATABASE_URL の形式が不正です` から始まるメッセージが出て `EAI_AGAIN base` は出ない
- `packages/core/src/index.ts` に変更が無い
- `README.md` / `.env.example` / `docker/` 配下に変更が無い
