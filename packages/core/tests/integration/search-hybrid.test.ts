import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, test, vi } from "vitest";
import { hybridSearch } from "../../src/search.js";
import { pool, seedKnowledge, truncateAll } from "../helpers/db.js";

const DIM = 1536;
/** 指定位置だけ 1 の単位ベクトル(ゼロベクトルはコサイン距離が定義できないため使わない) */
const unit = (i: number) => Array.from({ length: DIM }, (_, n) => (n === i ? 1 : 0));

// 埋め込みを有効にした経路を通すため、クエリのベクトルを固定値で返す。
// vi.mock は vitest がファイル先頭へ巻き上げるので、static import でもモックが効く
vi.mock("../../src/embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/embeddings.js")>();
  return { ...actual, embed: vi.fn(async () => unit(0)) };
});

beforeAll(async () => {
  await truncateAll();
  // ベクトル順位と一致種別を意図的に食い違わせる:
  //   「在庫」    = title 完全一致(rank 0)だが、クエリのベクトル unit(0) から遠い
  //   「在庫引当」= title 部分一致(rank 2)だが、クエリのベクトルと同一で最も近い
  // RRF スコアだけで並べると「在庫引当」が上がりうる。一致種別が優先されれば「在庫」が 1 位になる
  await seedKnowledge({
    context: "hy",
    title: "在庫",
    body: "在庫 の話を詳しく述べる。在庫 は重要である",
    embedding: unit(1),
  });
  await seedKnowledge({
    context: "hy",
    title: "在庫引当",
    body: "在庫 を確保する",
    embedding: unit(0),
  });
});
afterAll(() => pool.end());

describe("hybridSearch(ベクトル併用経路)", () => {
  test("エラーなく結果が返る", async () => {
    const rows = await hybridSearch("在庫", { context: "hy" });
    assert.ok(rows.length > 0);
  });

  test("title 完全一致がベクトル順位より優先される", async () => {
    const titles = (await hybridSearch("在庫", { context: "hy" })).map((r) => r.title);
    assert.equal(titles[0], "在庫");
  });
});
