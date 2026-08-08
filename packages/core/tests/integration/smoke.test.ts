import assert from "node:assert/strict";
import { afterAll, test } from "vitest";
import { pool } from "../helpers/db.js";

afterAll(() => pool.end());

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
