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

/** レビュー待ちの draft を1件作る(status を指定すれば draft 以外でも作れる) */
export async function seedDraft(input: {
  context: string;
  title: string;
  type?: string;
  body?: string;
  status?: string;
  review_notes?: string;
}): Promise<string> {
  await pool.query("insert into contexts (name) values ($1) on conflict (name) do nothing", [
    input.context,
  ]);
  const status = input.status ?? "draft";
  const res = await pool.query(
    `insert into knowledge (type, context, title, body, status, needs_review, review_notes)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [
      input.type ?? "term",
      input.context,
      input.title,
      input.body ?? "本文",
      status,
      status === "draft",
      input.review_notes ?? null,
    ],
  );
  return res.rows[0].id as string;
}

export { pool };
