import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { validateEnglishName } from "../../src/english-name.js";

describe("validateEnglishName", () => {
  test("term / event は english_name が無いとエラー", () => {
    assert.match(String(validateEnglishName("term", undefined)), /english_name/);
    assert.match(String(validateEnglishName("event", "")), /english_name/);
    assert.match(String(validateEnglishName("term", "   ")), /english_name/);
  });

  test("term / event に snake_case が入っていれば通る", () => {
    assert.equal(validateEnglishName("term", "resident"), null);
    assert.equal(validateEnglishName("event", "order_confirmation"), null);
  });

  // 前回の事故そのもの。実装識別子を弾けることを固定する
  test("実装識別子の形は弾く", () => {
    assert.match(String(validateEnglishName("term", "ExternalProductRepository")), /snake_case/);
    assert.match(String(validateEnglishName("term", "MindstockSession.Registered")), /snake_case/);
    assert.match(String(validateEnglishName("term", "lookupByJan")), /snake_case/);
    assert.match(String(validateEnglishName("term", "sales order")), /snake_case/);
    assert.match(String(validateEnglishName("term", "_resident")), /snake_case/);
  });

  test("rule / decision / requirement / faq は english_name を受け付けない", () => {
    for (const type of ["rule", "decision", "requirement", "faq"]) {
      assert.match(String(validateEnglishName(type, "session_guard")), /term \/ event/);
    }
  });

  test("rule / decision / requirement / faq は未指定なら通る", () => {
    assert.equal(validateEnglishName("rule", undefined), null);
    assert.equal(validateEnglishName("faq", ""), null);
  });
});
