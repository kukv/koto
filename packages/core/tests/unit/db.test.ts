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
