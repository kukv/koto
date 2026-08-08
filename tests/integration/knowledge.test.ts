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
