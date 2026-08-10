import assert from "node:assert/strict";
import { afterAll, beforeEach, describe, test } from "vitest";
import {
  addRelation,
  approve,
  findDuplicates,
  getKnowledge,
  listContexts,
  pendingReviews,
  propose,
  proposeUpdate,
  reject,
  setVerification,
  upsertContext,
} from "../../src/knowledge.js";
import { pool, seedKnowledge, truncateAll } from "../helpers/db.js";

beforeEach(truncateAll);
afterAll(() => pool.end());

/** 楽観ロック用に、現時点の updated_at を ISO 文字列で取得する */
async function currentUpdatedAt(id: string): Promise<string> {
  const res = await pool.query("select updated_at from knowledge where id = $1", [id]);
  return (res.rows[0].updated_at as Date).toISOString();
}

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
    await setVerification(id, "internal", "田中", await currentUpdatedAt(id));
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
    const flaggedId = await seedKnowledge({
      context: "sales",
      title: "要確認",
      status: "approved",
    });
    await pool.query("update knowledge set needs_review = true where id = $1", [flaggedId]);
    await seedKnowledge({ context: "sales", title: "確定済み", status: "approved" });

    const { total, items } = await pendingReviews();
    const ids = items.map((r: { id: string }) => r.id);
    assert.ok(ids.includes(draftId));
    assert.ok(ids.includes(flaggedId));
    assert.equal(items.length, 2);
    assert.equal(total, 2);
  });

  test("context で絞れる", async () => {
    await seedKnowledge({ context: "sales", title: "営業の下書き", status: "draft" });
    await seedKnowledge({ context: "legal", title: "法務の下書き", status: "draft" });

    const { total, items } = await pendingReviews({ context: "legal" });
    assert.equal(total, 1);
    assert.equal(items.length, 1);
    assert.equal(items[0].context, "legal");
  });

  test("type で絞れる", async () => {
    await seedKnowledge({ context: "sales", title: "用語", type: "term", status: "draft" });
    await seedKnowledge({ context: "sales", title: "出来事", type: "event", status: "draft" });

    const { total, items } = await pendingReviews({ type: "event" });
    assert.equal(total, 1);
    assert.equal(items[0].type, "event");
  });

  // total が limit の影響を受けないことが本機能の要点(打ち切りに気づけるようにするため)
  test("limit は返す件数を絞るが total は絞り込み後の全件を返す", async () => {
    for (const n of [1, 2, 3]) {
      await seedKnowledge({ context: "sales", title: `下書き${n}`, status: "draft" });
    }

    const { total, items } = await pendingReviews({ limit: 2 });
    assert.equal(items.length, 2);
    assert.equal(total, 3);
  });

  test("絞り込みと limit を併用すると total は絞り込み後の件数になる", async () => {
    for (const n of [1, 2, 3]) {
      await seedKnowledge({ context: "sales", title: `営業${n}`, status: "draft" });
    }
    await seedKnowledge({ context: "legal", title: "法務", status: "draft" });

    const { total, items } = await pendingReviews({ context: "sales", limit: 1 });
    assert.equal(items.length, 1);
    assert.equal(total, 3);
  });

  test("該当がなければ total 0 と空配列を返す", async () => {
    const { total, items } = await pendingReviews({ context: "存在しないコンテキスト" });
    assert.equal(total, 0);
    assert.deepEqual(items, []);
  });

  test("集計に使う total 列が items に混ざらない", async () => {
    await seedKnowledge({ context: "sales", title: "下書き", status: "draft" });

    const { items } = await pendingReviews();
    assert.ok(!("total" in items[0]));
  });
});

describe("approve", () => {
  test("承認すると review_notes がクリアされ承認根拠が残る", async () => {
    const id = await seedKnowledge({ context: "sales", title: "受注", status: "draft" });
    await pool.query(
      "update knowledge set needs_review = true, review_notes = '要確認: 出典不明' where id = $1",
      [id],
    );

    await approve(
      id,
      "野中",
      "DisplayName.kt の requireTrimmedWithin(100) で裏付けた",
      await currentUpdatedAt(id),
    );

    const row = (await pool.query("select * from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.review_notes, null);
    assert.equal(row.verified_note, "DisplayName.kt の requireTrimmedWithin(100) で裏付けた");
  });

  // クリアが情報の消失にならないこと(履歴トリガが更新前の値を保存する)を固定する
  test("クリアされた review_notes は revisions に残る", async () => {
    const id = await seedKnowledge({ context: "sales", title: "受注", status: "draft" });
    await pool.query("update knowledge set review_notes = '要確認: 出典不明' where id = $1", [id]);

    await approve(id, "野中", "出典を確認した", await currentUpdatedAt(id));

    const res = await pool.query(
      "select snapshot from knowledge_revisions where knowledge_id = $1 order by id desc limit 1",
      [id],
    );
    assert.equal(res.rows[0].snapshot.review_notes, "要確認: 出典不明");
  });

  test("draft を approved にし verification=internal と確認者を記録する", async () => {
    const id = await seedKnowledge({ context: "sales", title: "受注", status: "draft" });
    await pool.query("update knowledge set needs_review = true where id = $1", [id]);

    const result = await approve(id, "野中", "コードで裏を取った", await currentUpdatedAt(id));

    assert.deepEqual(result, { id, status: "approved" });
    const row = (await pool.query("select * from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.status, "approved");
    assert.equal(row.needs_review, false);
    assert.equal(row.verification, "internal");
    assert.equal(row.verified_by, "野中");
    assert.notEqual(row.verified_at, null);
  });

  test("既に expert のレコードは検証レベルを維持する", async () => {
    const id = await seedKnowledge({ context: "sales", title: "受注", status: "draft" });
    await pool.query("update knowledge set verification = 'expert' where id = $1", [id]);

    await approve(id, "野中", "コードで裏を取った", await currentUpdatedAt(id));

    const row = (await pool.query("select * from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.verification, "expert");
  });

  test("存在しない id はエラーになる", async () => {
    await assert.rejects(
      () =>
        approve(
          "00000000-0000-0000-0000-000000000000",
          "野中",
          "コードで裏を取った",
          new Date().toISOString(),
        ),
      /見つかりません/,
    );
  });

  test("期待した updated_at と食い違うと更新は失敗する", async () => {
    const id = await seedKnowledge({ context: "sales", title: "受注", status: "draft" });
    const staleUpdatedAt = await currentUpdatedAt(id);
    // 確認ダイアログが開いている間に別の変更が入った状況を再現する
    await pool.query("update knowledge set body = '書き換え' where id = $1", [id]);

    await assert.rejects(
      () => approve(id, "野中", "コードで裏を取った", staleUpdatedAt),
      /変更された/,
    );

    const row = (await pool.query("select status from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.status, "draft");
  });
});

describe("reject", () => {
  test("deprecated になり却下理由と確認者が review_notes に残る", async () => {
    const id = await seedKnowledge({ context: "sales", title: "受注", status: "draft" });

    const result = await reject(
      id,
      "営業部の実態と食い違っている",
      "野中",
      await currentUpdatedAt(id),
    );

    assert.deepEqual(result, { id, status: "deprecated" });
    const row = (await pool.query("select * from knowledge where id = $1", [id])).rows[0];
    assert.equal(row.status, "deprecated");
    assert.equal(row.needs_review, false);
    assert.match(row.review_notes, /却下\(野中\): 営業部の実態と食い違っている/);
  });

  test("既存の review_notes は残したまま追記される", async () => {
    const id = await seedKnowledge({ context: "sales", title: "受注", status: "draft" });
    await pool.query("update knowledge set review_notes = '要確認: 出典不明' where id = $1", [id]);

    await reject(id, "出典が確認できなかった", "野中", await currentUpdatedAt(id));

    const row = (await pool.query("select review_notes from knowledge where id = $1", [id]))
      .rows[0];
    assert.match(row.review_notes, /要確認: 出典不明/);
    assert.match(row.review_notes, /却下\(野中\): 出典が確認できなかった/);
  });

  test("存在しない id はエラーになる", async () => {
    await assert.rejects(
      () =>
        reject("00000000-0000-0000-0000-000000000000", "理由", "野中", new Date().toISOString()),
      /見つかりません/,
    );
  });
});

describe("verified_note 列", () => {
  test("knowledge と v_knowledge_approved の両方に verified_note がある", async () => {
    const res = await pool.query(
      `select table_name from information_schema.columns
        where table_schema = 'public'
          and column_name = 'verified_note'
          and table_name in ('knowledge', 'v_knowledge_approved')
        order by table_name`,
    );
    assert.deepEqual(
      res.rows.map((r: { table_name: string }) => r.table_name),
      ["knowledge", "v_knowledge_approved"],
    );
  });
});
