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
