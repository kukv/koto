import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { embed, toVectorLiteral } from "../../src/embeddings.js";

const saved = {
  provider: process.env.EMBEDDING_PROVIDER,
  key: process.env.OPENAI_API_KEY,
};

function setEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  setEnv("EMBEDDING_PROVIDER", saved.provider);
  setEnv("OPENAI_API_KEY", saved.key);
});

describe("embed", () => {
  test("EMBEDDING_PROVIDER=none なら null を返す", async () => {
    setEnv("EMBEDDING_PROVIDER", "none");
    setEnv("OPENAI_API_KEY", "dummy");
    assert.equal(await embed("テスト"), null);
  });

  test("OPENAI_API_KEY 未設定なら null を返す", async () => {
    setEnv("EMBEDDING_PROVIDER", "openai");
    setEnv("OPENAI_API_KEY", undefined);
    assert.equal(await embed("テスト"), null);
  });

  test("正常系: API の埋め込みを返す", async () => {
    setEnv("EMBEDDING_PROVIDER", "openai");
    setEnv("OPENAI_API_KEY", "test-key");
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 }),
    );
    assert.deepEqual(await embed("テスト"), [0.1, 0.2, 0.3]);
  });

  test("API エラーなら null を返す", async () => {
    setEnv("EMBEDDING_PROVIDER", "openai");
    setEnv("OPENAI_API_KEY", "test-key");
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("rate limited", { status: 429 }),
    );
    assert.equal(await embed("テスト"), null);
  });
});

describe("toVectorLiteral", () => {
  test("pgvector リテラル形式に変換する", () => {
    assert.equal(toVectorLiteral([1, -2.5, 3]), "[1,-2.5,3]");
  });
});
