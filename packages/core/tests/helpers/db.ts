import { pool } from "../../src/db.js";

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

export async function seedContext(name: string) {
  await pool.query("insert into contexts (name) values ($1) on conflict (name) do nothing", [name]);
}

export interface SeedKnowledgeInput {
  context: string;
  title: string;
  type?: string;
  body?: string;
  english_name?: string;
  aliases?: { name: string; kind: string }[];
  status?: string;
  /** ベクトル併用経路のテスト用。1536 次元 */
  embedding?: number[];
}

/** approved を含む任意ステータスの knowledge を直接挿入する(propose は draft しか作らないため) */
export async function seedKnowledge(k: SeedKnowledgeInput): Promise<string> {
  await seedContext(k.context);
  const res = await pool.query(
    `insert into knowledge (type, context, title, english_name, body, aliases, status, embedding)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::vector) returning id`,
    [
      k.type ?? "term",
      k.context,
      k.title,
      k.english_name ?? null,
      k.body ?? "本文",
      JSON.stringify(k.aliases ?? []),
      k.status ?? "approved",
      k.embedding ? `[${k.embedding.join(",")}]` : null,
    ],
  );
  return res.rows[0].id as string;
}

export { pool };
