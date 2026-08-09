import assert from "node:assert/strict";
import { afterAll, beforeEach, describe, test } from "vitest";
import { connect } from "../helpers/client.js";
import { pool, truncateAll } from "../helpers/db.js";

beforeEach(truncateAll);
afterAll(() => pool.end());

describe("createKotoServer", () => {
  test("既存のツールがすべて登録されている", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "add_relation",
      "get_knowledge",
      "get_pending_reviews",
      "list_contexts",
      "propose_knowledge",
      "propose_update",
      "search_knowledge",
      "upsert_context",
    ]);
  });
});
