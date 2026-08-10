import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { findForbiddenHits, formatWarning, writtenText } from "../../src/check-naming.js";

describe("writtenText", () => {
  test("Write は content を取り出す", () => {
    const text = writtenText({ tool_name: "Write", tool_input: { content: "住人を登録する" } });
    assert.equal(text, "住人を登録する");
  });

  test("Edit は new_string を取り出す", () => {
    const text = writtenText({
      tool_name: "Edit",
      tool_input: { old_string: "旧", new_string: "住人" },
    });
    assert.equal(text, "住人");
  });

  // 既存コードの禁止表記まで指摘すると無関係な編集のたびにノイズが出る
  test("Edit の old_string は見ない", () => {
    const text = writtenText({
      tool_name: "Edit",
      tool_input: { old_string: "住人", new_string: "居住者" },
    });
    assert.equal(text, "居住者");
  });

  test("対象外のツールと壊れた入力は null", () => {
    assert.equal(writtenText({ tool_name: "Bash", tool_input: { command: "ls" } }), null);
    assert.equal(writtenText({ tool_name: "Write" }), null);
    assert.equal(writtenText({}), null);
    assert.equal(writtenText(null), null);
  });
});

describe("findForbiddenHits", () => {
  const forbidden = [
    { name: "住人", title: "居住者", context: "resident" },
    { name: "オーダー", title: "受注", context: "sales" },
  ];

  test("含まれている禁止表記だけを返す", () => {
    const hits = findForbiddenHits("住人の一覧を取得する", forbidden);
    assert.deepEqual(hits, [{ name: "住人", title: "居住者", context: "resident" }]);
  });

  test("含まれていなければ空", () => {
    assert.deepEqual(findForbiddenHits("居住者の一覧を取得する", forbidden), []);
  });
});

describe("formatWarning", () => {
  test("禁止表記と正しい表記を並べる", () => {
    const message = formatWarning([{ name: "住人", title: "居住者", context: "resident" }]);
    assert.match(message, /住人/);
    assert.match(message, /居住者/);
    assert.match(message, /resident/);
  });
});
