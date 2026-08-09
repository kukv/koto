import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, test, vi } from "vitest";
import { hybridSearch } from "../../src/search.js";
import { pool, seedKnowledge, truncateAll } from "../helpers/db.js";

const DIM = 1536;
/**
 * 先頭 2 要素だけで向きを決めるベクトル。
 * 直交ベクトル同士はコサイン距離が等しくなるため、順位に差をつけるには角度を変える必要がある
 */
const v = (x: number, y: number) =>
  Array.from({ length: DIM }, (_, n) => (n === 0 ? x : n === 1 ? y : 0));

// 埋め込みを有効にした経路を通すため、クエリのベクトルを固定値で返す。
// vi.mock は vitest がファイル先頭へ巻き上げるので、static import でもモックが効く
vi.mock("../../src/embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/embeddings.js")>();
  return { ...actual, embed: vi.fn(async () => v(1, 0)) };
});

beforeAll(async () => {
  await truncateAll();
  // ベクトル順位・一致種別・RRF スコアを意図的に食い違わせる:
  //   「在庫」    = title 完全一致(rank 0)、kw 1 位。ベクトルはクエリから最も遠い(vec 3 位)
  //   「在庫引当」= title 部分一致(rank 2)、kw 2 位(本文中の「在庫」出現回数が多い)。ベクトルはクエリと同一で最も近い(vec 1 位)
  //   「在庫表」  = title 部分一致(rank 2)、kw 3 位。ベクトルは中間の角度(vec 2 位)
  // RRF スコアだけで並べると「在庫引当」が最上位になる(下の "title 完全一致が..." テストの前提 assert で実測して確認する)。
  // 一致種別が優先されれば「在庫」が 1 位になる
  await seedKnowledge({
    context: "hy",
    title: "在庫",
    body: "在庫 の話を詳しく述べる。在庫 は重要である",
    embedding: v(0, 1),
  });
  await seedKnowledge({
    context: "hy",
    title: "在庫引当",
    body: "在庫 を確保する。在庫 の引当処理を行う。在庫 数を更新する。在庫 管理は重要である。",
    embedding: v(1, 0),
  });
  await seedKnowledge({
    context: "hy",
    title: "在庫表",
    body: "在庫 の一覧を表示する。",
    embedding: v(1, 1),
  });
  // 「在庫引当」と「在庫表」はどちらも一致種別 rank 2 で、その中の並びは pgroonga_score(本文の
  // 「在庫」出現回数)で決まるはず。しかしこの context の行数が数件しかないと、プランナが
  // idx_knowledge_fulltext(PGroonga)より安いと判断して btree(idx_knowledge_context)を選び、
  // pgroonga_score が全行 0 になって出現回数が順位に反映されない(実測で確認済み)。
  // ノイズ行を足して行数を増やし、PGroonga 索引が確実に選ばれるようにする
  for (let i = 0; i < 5; i++) {
    await seedKnowledge({
      context: "hy",
      title: `ノイズ${i}`,
      body: `検索語とは関係ない内容${i}`,
    });
  }
});
afterAll(() => pool.end());

describe("hybridSearch(ベクトル併用経路)", () => {
  test("エラーなく結果が返る", async () => {
    const rows = await hybridSearch("在庫", { context: "hy" });
    assert.ok(rows.length > 0);
  });

  test("title 完全一致がベクトル順位より優先される", async () => {
    const rows = await hybridSearch("在庫", { context: "hy" });

    // 前提: RRF スコアだけで並べると「在庫引当」が最上位になる配置になっている。
    // ここが崩れると下の assert は何も検証しなくなるので、前提自体を確かめる
    const byScore = [...rows].sort((a, b) => Number(b.score) - Number(a.score));
    assert.equal(
      byScore[0].title,
      "在庫引当",
      "seed が RRF 優位の配置になっていない(テストの前提が崩れている)",
    );

    // それでも実際の 1 位は title 完全一致の「在庫」
    assert.equal(rows[0].title, "在庫");
  });
});
