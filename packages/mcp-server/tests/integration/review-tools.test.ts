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

    const res = await client.callTool({
      name: "approve_knowledge",
      arguments: { id, note: "コードで裏を取った" },
    });

    assert.match(textOf(res), /approved/);
    const row = (await pool.query("select * from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.status, "approved");
    assert.equal(row.verified_by, "野中");
  });

  test("ユーザーが decline すると DB は変化しない", async () => {
    const id = await seedDraft({ context: "sales", title: "受注" });
    const client = await connectWithElicitation(() => ({ action: "decline" }));

    const res = await client.callTool({
      name: "approve_knowledge",
      arguments: { id, note: "コードで裏を取った" },
    });

    assert.match(textOf(res), /承認しませんでした/);
    const row = (await pool.query("select * from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.status, "draft");
    assert.equal(row.verified_by, null);
    assert.equal(row.needs_review, true);
  });

  // 候補外は SDK が requestedSchema の enum で弾く(サーバ側の照合はそれに依存しないための二重化)。
  // どちらが弾いたかに関わらず、DB が変わらないことがここでの契約。
  test("候補にない確認者が返されたら実行しない", async () => {
    const id = await seedDraft({ context: "sales", title: "受注" });
    const client = await connectWithElicitation(() => ({
      action: "accept",
      content: { reviewer: "候補にない人" },
    }));

    const res = await client.callTool({
      name: "approve_knowledge",
      arguments: { id, note: "コードで裏を取った" },
    });

    assert.match(textOf(res), /候補にない|allowed values/);
    const row = (await pool.query("select * from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.status, "draft");
    assert.equal(row.verified_by, null);
    assert.equal(row.needs_review, true);
  });

  test("確認者名が空で返されたら実行しない", async () => {
    const id = await seedDraft({ context: "sales", title: "受注" });
    const client = await connectWithElicitation(() => ({
      action: "accept",
      content: { reviewer: "  " },
    }));

    const res = await client.callTool({
      name: "approve_knowledge",
      arguments: { id, note: "コードで裏を取った" },
    });

    assert.match(textOf(res), /候補にない|allowed values/);
    const row = (await pool.query("select * from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.status, "draft");
    assert.equal(row.verified_by, null);
    assert.equal(row.needs_review, true);
  });

  test("KOTO_REVIEWER が未設定ならダイアログを出さずに実行を断る", async () => {
    vi.stubEnv("KOTO_REVIEWER", "");
    const id = await seedDraft({ context: "sales", title: "受注" });
    let dialogShown = false;
    const client = await connectWithElicitation(() => {
      dialogShown = true;
      return { action: "accept", content: { reviewer: "野中" } };
    });

    const res = await client.callTool({
      name: "approve_knowledge",
      arguments: { id, note: "コードで裏を取った" },
    });

    assert.equal(dialogShown, false);
    assert.match(textOf(res), /KOTO_REVIEWER/);
    const row = (await pool.query("select status from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.status, "draft");
  });

  test("elicitation 非対応のクライアントからは実行できない", async () => {
    const id = await seedDraft({ context: "sales", title: "受注" });
    const client = await connect();

    const res = await client.callTool({
      name: "approve_knowledge",
      arguments: { id, note: "コードで裏を取った" },
    });

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

    const res = await client.callTool({
      name: "approve_knowledge",
      arguments: { id, note: "コードで裏を取った" },
    });

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

    const res = await client.callTool({
      name: "approve_knowledge",
      arguments: { id, note: "コードで裏を取った" },
    });

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
      arguments: { id: "00000000-0000-0000-0000-000000000000", note: "コードで裏を取った" },
    });

    assert.match(textOf(res), /見つかりません/);
  });

  // 人間が根拠を見てから判定できることが必須化の目的なので、ダイアログの中身を固定する
  test("確認ダイアログのメッセージに承認根拠が出る", async () => {
    const id = await seedDraft({ context: "sales", title: "受注" });
    let shownMessage = "";
    const client = await connectWithElicitation((request) => {
      shownMessage = request.params.message;
      return { action: "accept", content: { reviewer: "野中" } };
    });

    await client.callTool({
      name: "approve_knowledge",
      arguments: { id, note: "OrderService.kt の validate() で裏付けた" },
    });

    assert.match(shownMessage, /承認根拠: OrderService\.kt の validate\(\) で裏付けた/);
  });

  test("note を渡さないとツール呼び出しがエラーになる", async () => {
    const id = await seedDraft({ context: "sales", title: "受注" });
    const client = await connectWithElicitation(() => ({
      action: "accept",
      content: { reviewer: "野中" },
    }));

    // SDK が inputSchema で弾き、isError な CallToolResult としてエラーが返る
    const res = await client.callTool({ name: "approve_knowledge", arguments: { id } });

    assert.match(textOf(res), /Invalid arguments/);
    const row = (await pool.query("select status from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.status, "draft");
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
      arguments: { id, level: "expert", note: "顧問税理士に確認した" },
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
      arguments: { id, level: "expert", note: "顧問税理士に確認した" },
    });

    assert.match(textOf(res), /承認しませんでした/);
    const row = (await pool.query("select * from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.verification, "none");
    assert.equal(row.verified_by, null);
    assert.equal(row.needs_review, true);
  });

  test("確認ダイアログのメッセージに検証根拠が出る", async () => {
    const id = await seedDraft({ context: "legal", title: "源泉徴収" });
    let shownMessage = "";
    const client = await connectWithElicitation((request) => {
      shownMessage = request.params.message;
      return { action: "accept", content: { reviewer: "山田税理士" } };
    });

    await client.callTool({
      name: "verify_knowledge",
      arguments: { id, level: "expert", note: "顧問税理士に口頭で確認した" },
    });

    assert.match(shownMessage, /検証根拠: 顧問税理士に口頭で確認した/);
  });
});

describe("get_pending_reviews", () => {
  test("context で絞り込める", async () => {
    await seedDraft({ context: "sales", title: "営業の下書き" });
    await seedDraft({ context: "legal", title: "法務の下書き" });
    const client = await connect();

    const res = await client.callTool({
      name: "get_pending_reviews",
      arguments: { context: "legal" },
    });

    const payload = JSON.parse(textOf(res));
    assert.equal(payload.total, 1);
    assert.equal(payload.items.length, 1);
    assert.equal(payload.items[0].context, "legal");
  });

  test("type で絞り込める", async () => {
    await seedDraft({ context: "sales", title: "用語", type: "term" });
    await seedDraft({ context: "sales", title: "出来事", type: "event" });
    const client = await connect();

    const res = await client.callTool({
      name: "get_pending_reviews",
      arguments: { type: "event" },
    });

    const payload = JSON.parse(textOf(res));
    assert.equal(payload.total, 1);
    assert.equal(payload.items[0].type, "event");
  });

  // 打ち切りに気づけることがこのツールの要点なので、total が items を上回ることを固定する
  test("limit で打ち切られると total が items の件数を上回る", async () => {
    for (const n of [1, 2, 3]) {
      await seedDraft({ context: "sales", title: `下書き${n}` });
    }
    const client = await connect();

    const res = await client.callTool({
      name: "get_pending_reviews",
      arguments: { limit: 2 },
    });

    const payload = JSON.parse(textOf(res));
    assert.equal(payload.items.length, 2);
    assert.equal(payload.total, 3);
  });

  test("引数なしなら絞り込まずに返す", async () => {
    await seedDraft({ context: "sales", title: "営業の下書き" });
    await seedDraft({ context: "legal", title: "法務の下書き" });
    const client = await connect();

    const res = await client.callTool({ name: "get_pending_reviews", arguments: {} });

    const payload = JSON.parse(textOf(res));
    assert.equal(payload.total, 2);
    assert.equal(payload.items.length, 2);
  });
});
