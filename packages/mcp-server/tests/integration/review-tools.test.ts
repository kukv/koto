import assert from "node:assert/strict";
import { afterAll, beforeEach, describe, test, vi } from "vitest";
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
      "reject_knowledge",
      "search_knowledge",
      "upsert_context",
      "verify_knowledge",
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
    assert.equal(row.verified_by, null);
    assert.equal(row.needs_review, true);
  });

  test("確認者名が空なら実行しない", async () => {
    const id = await seedDraft({ context: "sales", title: "受注" });
    const client = await connectWithElicitation(() => ({
      action: "accept",
      content: { reviewer: "  " },
    }));

    const res = await client.callTool({ name: "approve_knowledge", arguments: { id } });

    assert.match(textOf(res), /確認者名/);
    const row = (await pool.query("select * from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.status, "draft");
    assert.equal(row.verified_by, null);
    assert.equal(row.needs_review, true);
  });

  test("elicitation 非対応のクライアントからは実行できない", async () => {
    const id = await seedDraft({ context: "sales", title: "受注" });
    const client = await connect();

    const res = await client.callTool({ name: "approve_knowledge", arguments: { id } });

    assert.match(textOf(res), /確認ダイアログ/);
    const row = (await pool.query("select * from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.status, "draft");
    assert.equal(row.verified_by, null);
    assert.equal(row.needs_review, true);
  });

  test("deprecated なレコードは対象外として拒否され、elicitation は呼ばれない", async () => {
    const id = await seedDraft({ context: "sales", title: "受注", status: "deprecated" });
    const respond = vi.fn(() => ({
      action: "accept" as const,
      content: { reviewer: "野中" },
    }));
    const client = await connectWithElicitation(respond);

    const res = await client.callTool({ name: "approve_knowledge", arguments: { id } });

    assert.match(textOf(res), /却下済み/);
    assert.equal(respond.mock.calls.length, 0);
    const row = (await pool.query("select * from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.status, "deprecated");
    assert.equal(row.verified_by, null);
  });

  test("ダイアログ中に内容が書き換わると承認されない", async () => {
    const id = await seedDraft({ context: "sales", title: "受注" });
    // ダイアログが開いている間(応答が返る前)に、別の操作(propose_update 等)で
    // 対象レコードが書き換わった状況を再現する。approve_knowledge が「ダイアログを
    // 出す前に読んだ target.updated_at」を渡している限り、この書き換えにより
    // 楽観ロックが働いて承認は失敗するはず。
    const client = await connectWithElicitation(async () => {
      await pool.query("update knowledge set body = '書き換え' where id = $1", [id]);
      return { action: "accept", content: { reviewer: "野中" } };
    });

    const res = await client.callTool({ name: "approve_knowledge", arguments: { id } });

    assert.match(textOf(res), /変更された/);
    const row = (await pool.query("select * from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.status, "draft");
    assert.equal(row.verified_by, null);
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

  test("cancel すると DB は変化しない", async () => {
    const id = await seedDraft({ context: "sales", title: "受注" });
    const client = await connectWithElicitation(() => ({ action: "cancel" }));

    const res = await client.callTool({
      name: "reject_knowledge",
      arguments: { id, reason: "理由" },
    });

    assert.match(textOf(res), /承認しませんでした/);
    const row = (await pool.query("select * from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.status, "draft");
    assert.equal(row.verified_by, null);
    assert.equal(row.needs_review, true);
  });

  test("elicitation 非対応のクライアントからは実行できない", async () => {
    const id = await seedDraft({ context: "sales", title: "受注" });
    const client = await connect();

    const res = await client.callTool({
      name: "reject_knowledge",
      arguments: { id, reason: "理由" },
    });

    assert.match(textOf(res), /確認ダイアログ/);
    const row = (await pool.query("select * from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.status, "draft");
    assert.equal(row.verified_by, null);
    assert.equal(row.needs_review, true);
  });
});

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
    const row = (await pool.query("select * from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.verification, "none");
    assert.equal(row.verified_by, null);
    assert.equal(row.needs_review, true);
  });
});
