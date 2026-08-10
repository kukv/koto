import assert from "node:assert/strict";
import { afterAll, beforeEach, describe, test } from "vitest";
import { connect, textOf } from "../helpers/client.js";
import { pool, seedDraft, truncateAll } from "../helpers/db.js";

beforeEach(truncateAll);
afterAll(() => pool.end());

describe("propose_knowledge の english_name 検証", () => {
  test("term で english_name が無ければ登録されない", async () => {
    const client = await connect();

    const out = textOf(
      await client.callTool({
        name: "propose_knowledge",
        arguments: { type: "term", context: "resident", title: "居住者", body: "定義" },
      }),
    );

    assert.match(out, /english_name/);
    const res = await pool.query("select count(*) from knowledge");
    assert.equal(Number(res.rows[0].count), 0);
  });

  test("rule に english_name を渡すと登録されない", async () => {
    const client = await connect();

    const out = textOf(
      await client.callTool({
        name: "propose_knowledge",
        arguments: {
          type: "rule",
          context: "resident",
          title: "表示名の文字数制限",
          body: "1〜100 文字",
          english_name: "display_name_limit",
        },
      }),
    );

    assert.match(out, /term \/ event/);
    const res = await pool.query("select count(*) from knowledge");
    assert.equal(Number(res.rows[0].count), 0);
  });

  test("実装識別子の形は登録されない", async () => {
    const client = await connect();

    const out = textOf(
      await client.callTool({
        name: "propose_knowledge",
        arguments: {
          type: "term",
          context: "catalog",
          title: "外部商品情報",
          body: "定義",
          english_name: "ExternalProductRepository",
        },
      }),
    );

    assert.match(out, /snake_case/);
  });

  test("規約どおりなら draft として登録される", async () => {
    const client = await connect();

    const out = textOf(
      await client.callTool({
        name: "propose_knowledge",
        arguments: {
          type: "term",
          context: "resident",
          title: "居住者",
          body: "mindstock を利用する個人",
          english_name: "resident",
        },
      }),
    );

    assert.match(out, /"status": "draft"/);
    const res = await pool.query("select english_name from knowledge");
    assert.equal(res.rows[0].english_name, "resident");
  });

  test("rule は english_name 無しで登録できる", async () => {
    const client = await connect();

    const out = textOf(
      await client.callTool({
        name: "propose_knowledge",
        arguments: {
          type: "rule",
          context: "resident",
          title: "表示名の文字数制限",
          body: "1〜100 文字",
        },
      }),
    );

    assert.match(out, /"status": "draft"/);
  });
});

describe("propose_update の english_name 検証", () => {
  test("rule のレコードに english_name を足せない", async () => {
    const id = await seedDraft({ context: "resident", title: "表示名の文字数制限", type: "rule" });
    const client = await connect();

    const out = textOf(
      await client.callTool({
        name: "propose_update",
        arguments: { id, english_name: "display_name_limit", note: "英語名を足す" },
      }),
    );

    assert.match(out, /term \/ event/);
    const res = await pool.query("select english_name from knowledge where id = $1", [id]);
    assert.equal(res.rows[0].english_name, null);
  });

  test("term の english_name を空にできない", async () => {
    const id = await seedDraft({ context: "resident", title: "居住者", type: "term" });
    await pool.query("update knowledge set english_name = 'resident' where id = $1", [id]);
    const client = await connect();

    const out = textOf(
      await client.callTool({
        name: "propose_update",
        arguments: { id, english_name: "", note: "消す" },
      }),
    );

    assert.match(out, /english_name/);
    const res = await pool.query("select english_name from knowledge where id = $1", [id]);
    assert.equal(res.rows[0].english_name, "resident");
  });

  // english_name を指定しない更新は、既存値が規約違反でも通す(既存 231 件の是正は別サイクル)
  test("english_name を指定しない更新は検証しない", async () => {
    const id = await seedDraft({ context: "resident", title: "居住者", type: "term" });
    const client = await connect();

    const out = textOf(
      await client.callTool({
        name: "propose_update",
        arguments: { id, body: "新しい定義", note: "定義を明確化" },
      }),
    );

    assert.doesNotMatch(out, /エラー/);
    const res = await pool.query("select body from knowledge where id = $1", [id]);
    assert.equal(res.rows[0].body, "新しい定義");
  });
});
