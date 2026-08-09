import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, test } from "vitest";
import { buildKeywordQuery, hybridSearch } from "../../src/search.js";
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

describe("順位付け", () => {
  test("title 完全一致が 1 位、次に別名完全一致、本文だけの一致は下位", async () => {
    await seedKnowledge({ context: "rank", title: "表示名", body: "居住者が名乗る名前" });
    await seedKnowledge({ context: "rank", title: "表示名履歴", body: "過去の名前の並び" });
    await seedKnowledge({
      context: "rank",
      title: "呼び名",
      body: "別の言い方",
      aliases: [{ name: "表示名", kind: "synonym" }],
    });
    await seedKnowledge({
      context: "rank",
      title: "居住者",
      body: "表示名 を持つ人。表示名 は変更できる",
    });

    const titles = (await hybridSearch("表示名", { context: "rank" })).map((r) => r.title);
    assert.equal(titles[0], "表示名"); // rank 0
    assert.equal(titles[1], "呼び名"); // rank 1(別名完全一致)
    assert.equal(titles[2], "表示名履歴"); // rank 2(title 部分一致)
    assert.equal(titles[3], "居住者"); // rank 3(本文のみ)
  });

  test("english_name の完全一致も rank 1 になる", async () => {
    await seedKnowledge({
      context: "en",
      title: "受注伝票",
      body: "注文の記録",
      english_name: "sales_order",
    });
    await seedKnowledge({ context: "en", title: "説明", body: "sales_order について述べる" });
    const titles = (await hybridSearch("sales_order", { context: "en" })).map((r) => r.title);
    assert.equal(titles[0], "受注伝票");
  });

  test("前後の空白があっても完全一致と判定される", async () => {
    const titles = (await hybridSearch("  表示名  ", { context: "rank" })).map((r) => r.title);
    assert.equal(titles[0], "表示名");
  });
});

/** EXPLAIN の plan JSON を再帰的に辿ってノードを集める */
function flattenPlan(node: Record<string, unknown>): Record<string, unknown>[] {
  const children = (node.Plans as Record<string, unknown>[] | undefined) ?? [];
  return [node, ...children.flatMap(flattenPlan)];
}

describe("プラン退行の防御", () => {
  test("既定経路(approved のみ)で全ヒットのスコアが 0 より大きい", async () => {
    const rows = await hybridSearch("受注");
    assert.ok(rows.length > 0, "ヒットが 0 件ではテストにならない");
    for (const r of rows) {
      assert.ok(
        Number(r.score) > 0,
        `${r.title} の score が ${r.score}。PGroonga 索引が使われていない可能性がある`,
      );
    }
  });

  test("既定経路のプランで PGroonga 索引が使われ status が索引条件に入る", async () => {
    const { sql, params } = buildKeywordQuery("受注");
    const res = await pool.query(`explain (format json) ${sql}`, params);
    const nodes = flattenPlan(res.rows[0]["QUERY PLAN"][0].Plan);

    const usesFulltextIndex = nodes.some((n) => n["Index Name"] === "idx_knowledge_fulltext");
    assert.ok(
      usesFulltextIndex,
      `idx_knowledge_fulltext が使われていない: ${JSON.stringify(nodes)}`,
    );

    const cond = nodes.map((n) => String(n["Index Cond"] ?? "")).join(" ");
    assert.ok(cond.includes("&@~"), `全文一致が索引条件に入っていない: ${cond}`);
    assert.ok(cond.includes("status"), `status が索引条件に入っていない: ${cond}`);
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
