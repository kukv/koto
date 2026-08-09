import { pool } from "@kukv/koto-core";

// 誤って開発 DB に向いたまま truncate しないためのガード
const url = process.env.DATABASE_URL ?? "";
if (!url.endsWith("/koto_test")) {
  throw new Error(`統合テストは koto_test 以外の DB では実行できません: ${url || "(未設定)"}`);
}

export async function truncateAll() {
  await pool.query(
    "truncate contexts, knowledge, knowledge_relations, knowledge_revisions restart identity cascade",
  );
}

/** レビュー待ちの draft を1件作る */
export async function seedDraft(input: {
  context: string;
  title: string;
  type?: string;
  body?: string;
}): Promise<string> {
  await pool.query("insert into contexts (name) values ($1) on conflict (name) do nothing", [
    input.context,
  ]);
  const res = await pool.query(
    `insert into knowledge (type, context, title, body, status, needs_review)
     values ($1,$2,$3,$4,'draft',true) returning id`,
    [input.type ?? "term", input.context, input.title, input.body ?? "本文"],
  );
  return res.rows[0].id as string;
}

export { pool };
