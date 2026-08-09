import assert from "node:assert/strict";
import { afterAll, beforeEach, describe, test } from "vitest";
import { connect, textOf } from "../helpers/client.js";
import { pool, seedDraft, truncateAll } from "../helpers/db.js";

beforeEach(truncateAll);
afterAll(() => pool.end());

describe("search_knowledge", () => {
  test("単語で検索するとヒットする", async () => {
    await seedDraft({
      context: "household",
      title: "招待発行",
      body: "世帯主が、参加者に渡すための招待コードを発行する",
    });
    const client = await connect();

    const res = await client.callTool({
      name: "search_knowledge",
      arguments: { query: "招待", include_drafts: true },
    });

    const rows = JSON.parse(textOf(res));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, "招待発行");
  });

  // PGroonga は bigram で分割するため、自然文は全 bigram の AND になり事実上ヒットしない。
  // 黙って空配列を返すとエージェントが「関連知識なし」と誤って報告するので、直し方を返す。
  test("自然文で 0 件になったら単語に分けるよう促す", async () => {
    await seedDraft({
      context: "household",
      title: "招待発行",
      body: "世帯主が、参加者に渡すための招待コードを発行する",
    });
    const client = await connect();

    const res = await client.callTool({
      name: "search_knowledge",
      arguments: { query: "世帯に招待で参加する", include_drafts: true },
    });

    assert.match(textOf(res), /単語に分けて/);
  });

  test("本当に該当がないときも同じ案内を返す", async () => {
    const client = await connect();

    const res = await client.callTool({
      name: "search_knowledge",
      arguments: { query: "存在しない用語", include_drafts: true },
    });

    assert.match(textOf(res), /該当なし/);
  });
});
