import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { embeddingSource, shouldReembed } from "../../src/knowledge.js";

describe("embeddingSource", () => {
  test("title / english_name / 別名 / body を連結する", () => {
    const text = embeddingSource({
      title: "居住者",
      english_name: "resident",
      body: "mindstock を利用する個人",
      aliases: [
        { name: "住人", kind: "synonym" },
        { name: "テナント", kind: "forbidden" },
      ],
    });

    assert.equal(text, "居住者 resident 住人 テナント mindstock を利用する個人");
  });

  test("english_name も別名も無ければ余分な空白が入らない", () => {
    const text = embeddingSource({ title: "居住者", body: "定義" });

    assert.equal(text, "居住者 定義");
  });
});

describe("shouldReembed", () => {
  test("別名だけの変更でも再計算する(検索専用だが意味検索にも載せるため)", () => {
    assert.equal(shouldReembed({ aliases: [{ name: "住人", kind: "synonym" }] }), true);
  });

  test("本文・タイトル・english_name の変更でも再計算する", () => {
    assert.equal(shouldReembed({ body: "新本文" }), true);
    assert.equal(shouldReembed({ title: "新題" }), true);
    assert.equal(shouldReembed({ english_name: "resident" }), true);
  });

  test("examples だけの変更では再計算しない", () => {
    assert.equal(shouldReembed({ examples: ["例"] }), false);
  });
});
