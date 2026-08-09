import assert from "node:assert/strict";
import { afterAll, beforeEach, describe, test } from "vitest";
import { connect, connectWithElicitation, textOf } from "../helpers/client.js";
import { pool, seedDraft, truncateAll } from "../helpers/db.js";

beforeEach(truncateAll);
afterAll(() => pool.end());

describe("createKotoServer", () => {
  test("既存のツールがすべて登録されている", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "add_relation",
      "approve_knowledge",
      "get_knowledge",
      "get_pending_reviews",
      "list_contexts",
      "propose_knowledge",
      "propose_update",
      "search_knowledge",
      "upsert_context",
    ]);
  });
});

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
