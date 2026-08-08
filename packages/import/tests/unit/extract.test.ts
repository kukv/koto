import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { isCliAvailable, runClaudeCli } from "../../src/cli.js";
import { chunkDocument, extractCandidates } from "../../src/extract.js";

vi.mock("../../src/cli.js", () => ({
  isCliAvailable: vi.fn(),
  runClaudeCli: vi.fn(),
}));

const savedKey = process.env.ANTHROPIC_API_KEY;
const savedProvider = process.env.EXTRACT_PROVIDER;
const savedModel = process.env.EXTRACT_MODEL;

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restoreEnv("ANTHROPIC_API_KEY", savedKey);
  restoreEnv("EXTRACT_PROVIDER", savedProvider);
  restoreEnv("EXTRACT_MODEL", savedModel);
  vi.clearAllMocks();
});

function mockAnthropicResponse(text: string, status = 200) {
  return async () =>
    new Response(
      status === 200 ? JSON.stringify({ content: [{ type: "text", text }] }) : "bad request",
      { status },
    );
}

/** claude -p --output-format json の応答形式 */
function cliResult(text: string, isError = false) {
  return JSON.stringify({ type: "result", subtype: "success", is_error: isError, result: text });
}

const CANDIDATES_JSON = JSON.stringify([{ type: "term", title: "受注", body: "定義" }]);

describe("extractCandidates: プロバイダ選択", () => {
  test("CLI が利用可能なら CLI 経由で抽出する", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.EXTRACT_PROVIDER;
    vi.mocked(isCliAvailable).mockResolvedValue(true);
    vi.mocked(runClaudeCli).mockResolvedValue(cliResult(CANDIDATES_JSON));
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await extractCandidates("受注に関する文書");

    assert.equal(result[0].title, "受注");
    assert.equal(fetchSpy.mock.calls.length, 0);
    const [prompt] = vi.mocked(runClaudeCli).mock.calls[0];
    assert.ok(prompt.includes("受注に関する文書"));
  });

  test("EXTRACT_MODEL 設定時は CLI にモデル名を渡す", async () => {
    delete process.env.EXTRACT_PROVIDER;
    process.env.EXTRACT_MODEL = "claude-opus-5";
    vi.mocked(isCliAvailable).mockResolvedValue(true);
    vi.mocked(runClaudeCli).mockResolvedValue(cliResult(CANDIDATES_JSON));

    await extractCandidates("文書");

    assert.equal(vi.mocked(runClaudeCli).mock.calls[0][1], "claude-opus-5");
  });

  test("EXTRACT_MODEL 未設定なら CLI のデフォルトモデルに任せる", async () => {
    delete process.env.EXTRACT_PROVIDER;
    delete process.env.EXTRACT_MODEL;
    vi.mocked(isCliAvailable).mockResolvedValue(true);
    vi.mocked(runClaudeCli).mockResolvedValue(cliResult(CANDIDATES_JSON));

    await extractCandidates("文書");

    assert.equal(vi.mocked(runClaudeCli).mock.calls[0][1], undefined);
  });

  test("EXTRACT_PROVIDER=api なら CLI が利用可能でも API を使う", async () => {
    process.env.EXTRACT_PROVIDER = "api";
    process.env.ANTHROPIC_API_KEY = "test-key";
    vi.mocked(isCliAvailable).mockResolvedValue(true);
    vi.spyOn(globalThis, "fetch").mockImplementation(mockAnthropicResponse(CANDIDATES_JSON));

    const result = await extractCandidates("文書");

    assert.equal(result[0].title, "受注");
    assert.equal(vi.mocked(runClaudeCli).mock.calls.length, 0);
  });

  test("EXTRACT_PROVIDER=cli なら API キーがあっても CLI 失敗時にフォールバックしない", async () => {
    process.env.EXTRACT_PROVIDER = "cli";
    process.env.ANTHROPIC_API_KEY = "test-key";
    vi.mocked(runClaudeCli).mockRejectedValue(new Error("claude CLI が見つかりません"));
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await assert.rejects(extractCandidates("文書"), /claude CLI が見つかりません/);
    assert.equal(fetchSpy.mock.calls.length, 0);
  });

  test("CLI 不可で ANTHROPIC_API_KEY ありなら API にフォールバックする", async () => {
    delete process.env.EXTRACT_PROVIDER;
    process.env.ANTHROPIC_API_KEY = "test-key";
    vi.mocked(isCliAvailable).mockResolvedValue(false);
    vi.spyOn(globalThis, "fetch").mockImplementation(mockAnthropicResponse(CANDIDATES_JSON));

    const result = await extractCandidates("文書");

    assert.equal(result[0].title, "受注");
  });

  test("CLI 不可でキーもなければ導線を示すエラーを投げる", async () => {
    delete process.env.EXTRACT_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    vi.mocked(isCliAvailable).mockResolvedValue(false);

    await assert.rejects(extractCandidates("文書"), (err: Error) => {
      assert.match(err.message, /Claude Code/);
      assert.match(err.message, /ANTHROPIC_API_KEY/);
      return true;
    });
  });
});

describe("extractCandidates: CLI 経由", () => {
  test("is_error 応答はエラーを投げる", async () => {
    delete process.env.EXTRACT_PROVIDER;
    vi.mocked(isCliAvailable).mockResolvedValue(true);
    vi.mocked(runClaudeCli).mockResolvedValue(cliResult("実行に失敗しました", true));

    await assert.rejects(extractCandidates("文書"), /実行に失敗しました/);
  });

  test("コードフェンス付きの応答も除去してパースする", async () => {
    delete process.env.EXTRACT_PROVIDER;
    vi.mocked(isCliAvailable).mockResolvedValue(true);
    vi.mocked(runClaudeCli).mockResolvedValue(cliResult(`\`\`\`json\n${CANDIDATES_JSON}\n\`\`\``));

    const result = await extractCandidates("文書");

    assert.equal(result[0].type, "term");
  });

  test("JSON でない応答はパース失敗エラーを投げる", async () => {
    delete process.env.EXTRACT_PROVIDER;
    vi.mocked(isCliAvailable).mockResolvedValue(true);
    vi.mocked(runClaudeCli).mockResolvedValue(cliResult("これはJSONではありません"));

    await assert.rejects(extractCandidates("文書"), /JSONパースに失敗/);
  });
});

describe("extractCandidates: API 経由", () => {
  test("EXTRACT_PROVIDER=api で ANTHROPIC_API_KEY 未設定ならエラー", async () => {
    process.env.EXTRACT_PROVIDER = "api";
    delete process.env.ANTHROPIC_API_KEY;
    await assert.rejects(extractCandidates("文書"), /ANTHROPIC_API_KEY/);
  });

  test("コードフェンス付きの応答も除去してパースする", async () => {
    process.env.EXTRACT_PROVIDER = "api";
    process.env.ANTHROPIC_API_KEY = "test-key";
    const json = JSON.stringify([{ type: "faq", title: "質問", body: "回答" }]);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      mockAnthropicResponse(`\`\`\`json\n${json}\n\`\`\``),
    );
    const result = await extractCandidates("文書");
    assert.equal(result[0].type, "faq");
  });

  test("API エラーならエラーを投げる", async () => {
    process.env.EXTRACT_PROVIDER = "api";
    process.env.ANTHROPIC_API_KEY = "test-key";
    vi.spyOn(globalThis, "fetch").mockImplementation(mockAnthropicResponse("", 400));
    await assert.rejects(extractCandidates("文書"), /Anthropic API error: 400/);
  });

  test("JSON でない応答はパース失敗エラーを投げる", async () => {
    process.env.EXTRACT_PROVIDER = "api";
    process.env.ANTHROPIC_API_KEY = "test-key";
    vi.spyOn(globalThis, "fetch").mockImplementation(
      mockAnthropicResponse("これはJSONではありません"),
    );
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
