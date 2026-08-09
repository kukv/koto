import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, test } from "vitest";
import { hybridSearch } from "../../src/search.js";
import { pool, seedKnowledge, truncateAll } from "../helpers/db.js";

beforeAll(async () => {
  await truncateAll();
  await seedKnowledge({
    context: "sales",
    title: "受注",
    body: "顧客からの注文を受け付けること",
    aliases: [{ name: "オーダー", kind: "synonym" }],
  });
  await seedKnowledge({
    context: "sales",
    type: "event",
    title: "在庫引当",
    body: "受注に対して在庫を確保する",
  });
  await seedKnowledge({ context: "support", title: "問い合わせ", body: "顧客からの質問" });
  await seedKnowledge({
    context: "sales",
    title: "見積",
    body: "受注前に金額を提示する",
    status: "draft",
  });
  await seedKnowledge({
    context: "sales",
    title: "旧受注",
    body: "廃止された受注の概念",
    status: "deprecated",
  });
});
afterAll(() => pool.end());

describe("hybridSearch(キーワード検索経路)", () => {
  test("既定では approved のみが返る(draft / deprecated は除外)", async () => {
    const titles = (await hybridSearch("受注")).map((r) => r.title);
    assert.ok(titles.includes("受注"));
    assert.ok(titles.includes("在庫引当")); // body の「受注」にヒット
    assert.ok(!titles.includes("見積")); // draft
    assert.ok(!titles.includes("旧受注")); // deprecated
  });

  test("includeDrafts で draft が含まれ deprecated は除外のまま", async () => {
    const titles = (await hybridSearch("受注", { includeDrafts: true })).map((r) => r.title);
    assert.ok(titles.includes("見積"));
    assert.ok(!titles.includes("旧受注"));
  });

  test("context で絞り込める", async () => {
    const rows = await hybridSearch("顧客", { context: "support" });
    assert.deepEqual(
      rows.map((r) => r.title),
      ["問い合わせ"],
    );
  });

  test("type で絞り込める", async () => {
    const rows = await hybridSearch("受注", { type: "event" });
    assert.deepEqual(
      rows.map((r) => r.title),
      ["在庫引当"],
    );
  });

  test("別名(alias)でもヒットする", async () => {
    const titles = (await hybridSearch("オーダー")).map((r) => r.title);
    assert.ok(titles.includes("受注"));
  });

  test("limit で件数を制限できる", async () => {
    const rows = await hybridSearch("受注", { limit: 1 });
    assert.equal(rows.length, 1);
  });

  test("excerpt は 400 文字に切り詰められる", async () => {
    await seedKnowledge({ context: "sales", title: "長文", body: "受注 ".repeat(500) });
    const rows = await hybridSearch("長文");
    const hit = rows.find((r) => r.title === "長文");
    assert.ok(hit);
    assert.ok(hit.excerpt.length <= 400);
  });
});

describe("search_text 生成列", () => {
  test("aliases の JSON キー名は全文索引に入らない", async () => {
    await seedKnowledge({
      context: "sales",
      title: "注文書",
      body: "顧客に提示する書面",
      aliases: [{ name: "オーダーシート", kind: "synonym" }],
    });
    const res = await pool.query(
      "select count(*)::int as n from knowledge where search_text &@~ 'synonym'",
    );
    assert.equal(res.rows[0].n, 0);
  });

  test("aliases の name は全文索引に入る", async () => {
    const res = await pool.query(
      "select count(*)::int as n from knowledge where search_text &@~ 'オーダーシート'",
    );
    assert.equal(res.rows[0].n, 1);
  });
});
