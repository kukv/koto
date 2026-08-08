import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { chunkDocument, extractCandidates } from "../../src/import/extract.js";

const savedKey = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

function mockAnthropicResponse(text: string, status = 200) {
  return async () =>
    new Response(
      status === 200 ? JSON.stringify({ content: [{ type: "text", text }] }) : "bad request",
      { status },
    );
}

describe("extractCandidates", () => {
  test("ANTHROPIC_API_KEY 未設定ならエラー", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await assert.rejects(extractCandidates("文書"), /ANTHROPIC_API_KEY/);
  });

  test("正常系: JSON 配列をパースして返す", async (t) => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const json = JSON.stringify([{ type: "term", title: "受注", body: "定義" }]);
    t.mock.method(globalThis, "fetch", mockAnthropicResponse(json));
    const result = await extractCandidates("文書");
    assert.equal(result.length, 1);
    assert.equal(result[0].title, "受注");
  });

  test("コードフェンス付きの応答も除去してパースする", async (t) => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const json = JSON.stringify([{ type: "faq", title: "質問", body: "回答" }]);
    t.mock.method(globalThis, "fetch", mockAnthropicResponse(`\`\`\`json\n${json}\n\`\`\``));
    const result = await extractCandidates("文書");
    assert.equal(result[0].type, "faq");
  });

  test("API エラーならエラーを投げる", async (t) => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    t.mock.method(globalThis, "fetch", mockAnthropicResponse("", 400));
    await assert.rejects(extractCandidates("文書"), /Anthropic API error: 400/);
  });

  test("JSON でない応答はパース失敗エラーを投げる", async (t) => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    t.mock.method(globalThis, "fetch", mockAnthropicResponse("これはJSONではありません"));
    await assert.rejects(extractCandidates("文書"), /JSONパースに失敗/);
  });
});

describe("chunkDocument", () => {
  test("maxChars 以下の文書はそのまま 1 チャンク", () => {
    assert.deepEqual(chunkDocument("短い文書"), ["短い文書"]);
  });

  test("見出し境界で分割され、結合すると元の文書に戻る", () => {
    const section = (name: string) => `## ${name}\n${"あ".repeat(30)}\n`;
    const doc = section("一") + section("二") + section("三");
    const chunks = chunkDocument(doc, 40);
    assert.ok(chunks.length > 1);
    assert.equal(chunks.join(""), doc);
    for (const c of chunks) {
      assert.ok(c.startsWith("## "), `チャンクが見出しで始まっていない: ${c.slice(0, 10)}`);
    }
  });
});
