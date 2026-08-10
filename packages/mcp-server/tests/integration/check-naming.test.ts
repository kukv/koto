import assert from "node:assert/strict";
import { afterAll, beforeEach, describe, test, vi } from "vitest";
import { checkNaming } from "../../src/check-naming.js";
import { pool, seedDraft, truncateAll } from "../helpers/db.js";

beforeEach(truncateAll);
afterAll(() => pool.end());

/** PostToolUse の入力を組み立てる */
function hookInput(toolName: string, toolInput: Record<string, unknown>): string {
  return JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: toolName,
    tool_input: toolInput,
  });
}

async function seedForbidden(): Promise<void> {
  const id = await seedDraft({
    context: "resident",
    title: "居住者",
    type: "term",
    status: "approved",
  });
  await pool.query(
    `update knowledge set aliases = '[{"name":"住人","kind":"forbidden"}]'::jsonb where id = $1`,
    [id],
  );
}

describe("checkNaming", () => {
  test("禁止表記を書き込んだら 2 を返して指摘を出す", async () => {
    await seedForbidden();
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await checkNaming(hookInput("Write", { content: "住人の一覧を返す" }));

    assert.equal(code, 2);
    assert.match(String(stderr.mock.calls[0][0]), /住人.*居住者/s);
  });

  test("禁止表記が無ければ 0 を返す", async () => {
    await seedForbidden();

    assert.equal(await checkNaming(hookInput("Write", { content: "居住者の一覧を返す" })), 0);
  });

  test("対象外のツールでは DB も引かず 0 を返す", async () => {
    await seedForbidden();

    assert.equal(await checkNaming(hookInput("Bash", { command: "ls" })), 0);
  });

  // フェイルオープン。壊れた入力や DB の失敗で作業を止めない
  test("壊れた入力でも 0 を返す", async () => {
    assert.equal(await checkNaming("これは JSON ではない"), 0);
    assert.equal(await checkNaming(""), 0);
  });
});
