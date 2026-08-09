import { pool } from "./db.js";
import { embed, toVectorLiteral } from "./embeddings.js";

export type KnowledgeType = "term" | "rule" | "decision" | "requirement" | "faq" | "event";

export interface Alias {
  name: string;
  kind: "synonym" | "forbidden";
}

export interface ProposeInput {
  type: KnowledgeType;
  context: string;
  title: string;
  english_name?: string;
  body: string;
  aliases?: Alias[];
  examples?: string[];
  source?: Record<string, unknown>;
  created_by?: string;
  review_notes?: string;
}

/** 近似重複の検出: 同名/別名の完全一致 + 埋め込み類似 */
export async function findDuplicates(title: string, context: string, vec: number[] | null) {
  const seen = new Map<string, Record<string, unknown>>();

  const byName = await pool.query(
    `select id, title, context, type, status from knowledge
     where context = $2
       and (lower(title) = lower($1)
         or exists (
           select 1 from jsonb_array_elements(aliases) a
           where lower(a->>'name') = lower($1)))`,
    [title, context],
  );
  for (const r of byName.rows) {
    seen.set(r.id, { ...r, reason: "同名または別名が一致" });
  }

  if (vec) {
    const bySim = await pool.query(
      `select id, title, context, type, status,
              round((1 - (embedding <=> $1::vector))::numeric, 3) as similarity
       from knowledge
       where embedding is not null
       order by embedding <=> $1::vector
       limit 3`,
      [toVectorLiteral(vec)],
    );
    for (const r of bySim.rows) {
      if (Number(r.similarity) >= 0.82 && !seen.has(r.id)) {
        seen.set(r.id, { ...r, reason: `埋め込み類似度 ${r.similarity}` });
      }
    }
  }
  return [...seen.values()];
}

/** 新しい知識を draft として提案する(承認されるまで検索の既定対象外) */
export async function propose(input: ProposeInput) {
  const vec = await embed(`${input.title} ${input.english_name ?? ""} ${input.body}`);
  const duplicates = await findDuplicates(input.title, input.context, vec);
  const notes =
    [
      input.review_notes,
      duplicates.length
        ? `重複候補: ${duplicates.map((d) => `${d.title}(${d.id})`).join(", ")}`
        : null,
    ]
      .filter(Boolean)
      .join("\n") || null;

  // 未知のコンテキストはマスタに自動登録される(owner未設定として可視化され、後で埋める)
  await pool.query(`insert into contexts (name) values ($1) on conflict (name) do nothing`, [
    input.context,
  ]);

  const res = await pool.query(
    `insert into knowledge
       (type, context, title, english_name, body, aliases, examples,
        status, needs_review, review_notes, source, created_by, embedding)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7,'draft',true,$8,$9::jsonb,$10,$11::vector)
     returning id`,
    [
      input.type,
      input.context,
      input.title,
      input.english_name ?? null,
      input.body,
      JSON.stringify(input.aliases ?? []),
      input.examples ?? [],
      notes,
      input.source ? JSON.stringify(input.source) : null,
      input.created_by ?? "agent",
      vec ? toVectorLiteral(vec) : null,
    ],
  );
  return { id: res.rows[0].id as string, duplicates };
}

/** 既存レコードへの更新提案。履歴はトリガで自動保存、needs_review が立つ */
export async function proposeUpdate(id: string, changes: Partial<ProposeInput>, note?: string) {
  const cur = await pool.query(`select * from knowledge where id = $1`, [id]);
  if (cur.rowCount === 0) throw new Error(`知識レコードが見つかりません: ${id}`);
  const row = cur.rows[0];

  const merged = {
    title: changes.title ?? row.title,
    english_name: changes.english_name ?? row.english_name,
    body: changes.body ?? row.body,
    aliases: changes.aliases ?? row.aliases,
    examples: changes.examples ?? row.examples,
  };
  const contentChanged =
    changes.title !== undefined || changes.body !== undefined || changes.english_name !== undefined;
  const vec = contentChanged
    ? await embed(`${merged.title} ${merged.english_name ?? ""} ${merged.body}`)
    : null;

  await pool.query(
    `update knowledge
        set title = $2, english_name = $3, body = $4,
            aliases = $5::jsonb, examples = $6,
            needs_review = true,
            review_notes = coalesce(review_notes || E'\n', '') || $7,
            embedding = coalesce($8::vector, embedding),
            -- 内容が変わったら検証レベルは未検証に戻す(専門家確認は旧版に対するもの)
            verification = case when $9::boolean then 'none' else verification end,
            verified_by  = case when $9::boolean then null else verified_by end,
            verified_at  = case when $9::boolean then null else verified_at end
      where id = $1`,
    [
      id,
      merged.title,
      merged.english_name,
      merged.body,
      JSON.stringify(merged.aliases),
      merged.examples,
      `更新提案: ${note ?? "(メモなし)"}`,
      vec ? toVectorLiteral(vec) : null,
      contentChanged,
    ],
  );
  return { id };
}

/** 1件取得(関連グラフの1ホップ展開つき) */
export async function getKnowledge(id: string, expandRelations = true) {
  const rec = await pool.query(
    `select id, type, context, title, english_name, body, aliases, examples,
            status, verification, verified_by, verified_at,
            needs_review, review_notes, source, created_by,
            created_at, updated_at
       from knowledge where id = $1`,
    [id],
  );
  if (rec.rowCount === 0) return null;
  const out: Record<string, unknown> = rec.rows[0];

  if (expandRelations) {
    const rel = await pool.query(
      `select r.label, r.cardinality, 'out' as direction,
              k.id, k.title, k.context, k.type, k.status
         from knowledge_relations r join knowledge k on k.id = r.to_id
        where r.from_id = $1
       union all
       select r.label, r.cardinality, 'in',
              k.id, k.title, k.context, k.type, k.status
         from knowledge_relations r join knowledge k on k.id = r.from_id
        where r.to_id = $1`,
      [id],
    );
    out.relations = rel.rows;
  }
  return out;
}

/**
 * 関連の登録。ラベル規約:
 *   モノ・用語間=意味ラベル(「含む」「引当」「同名別概念」等) /
 *   コト間=「先行」「取消」 / コト→モノ=「対象」
 */
export async function addRelation(
  fromId: string,
  toId: string,
  label: string,
  cardinality?: string,
) {
  await pool.query(
    `insert into knowledge_relations (from_id, to_id, label, cardinality)
     values ($1, $2, $3, $4)
     on conflict do nothing`,
    [fromId, toId, label, cardinality ?? null],
  );
  return { from_id: fromId, to_id: toId, label };
}

/** コンテキストのマスタ情報(オーナー・専門家)の登録・更新。未指定の項目は既存値を保持 */
export async function upsertContext(
  name: string,
  fields: { description?: string; owner?: string; expert?: string } = {},
) {
  const res = await pool.query(
    `insert into contexts (name, description, owner, expert)
     values ($1, $2, $3, $4)
     on conflict (name) do update set
       description = coalesce(excluded.description, contexts.description),
       owner       = coalesce(excluded.owner, contexts.owner),
       expert      = coalesce(excluded.expert, contexts.expert)
     returning *`,
    [name, fields.description ?? null, fields.owner ?? null, fields.expert ?? null],
  );
  return res.rows[0];
}

/** 更新対象が存在しないのか、内容が変わっただけなのかを区別してエラーを投げる */
async function throwOptimisticLockError(id: string): Promise<never> {
  const exists = await pool.query(`select 1 from knowledge where id = $1`, [id]);
  if (exists.rowCount === 0) throw new Error(`知識レコードが見つかりません: ${id}`);
  throw new Error(`確認中に内容が変更されたため中止しました。もう一度確認してください: ${id}`);
}

/** レビューを通して承認する(検索の既定対象になる。検証レベルは internal、既に expert なら維持) */
export async function approve(id: string, by: string, expectedUpdatedAt: string) {
  const res = await pool.query(
    `update knowledge
        set status = 'approved', needs_review = false,
            verification = case when verification = 'expert' then 'expert' else 'internal' end,
            verified_by = $2, verified_at = now()
      where id = $1 and date_trunc('milliseconds', updated_at) = $3::timestamptz`,
    [id, by, expectedUpdatedAt],
  );
  if (res.rowCount === 0) await throwOptimisticLockError(id);
  return { id, status: "approved" as const };
}

/** レビューで却下する(物理削除はせず deprecated にし、却下理由を履歴として残す) */
export async function reject(id: string, reason: string, by: string, expectedUpdatedAt: string) {
  const res = await pool.query(
    `update knowledge
        set status = 'deprecated', needs_review = false,
            review_notes = coalesce(review_notes || E'\n', '') || $2
      where id = $1 and date_trunc('milliseconds', updated_at) = $3::timestamptz`,
    [id, `却下(${by}): ${reason}`, expectedUpdatedAt],
  );
  if (res.rowCount === 0) await throwOptimisticLockError(id);
  return { id, status: "deprecated" as const };
}

/** 検証レベルの引き上げ(internal=社内確認済 / expert=専門家確認済) */
export async function setVerification(
  id: string,
  level: "internal" | "expert",
  by: string,
  expectedUpdatedAt: string,
) {
  const res = await pool.query(
    `update knowledge
        set verification = $2, verified_by = $3, verified_at = now(),
            needs_review = false
      where id = $1 and date_trunc('milliseconds', updated_at) = $4::timestamptz`,
    [id, level, by, expectedUpdatedAt],
  );
  if (res.rowCount === 0) await throwOptimisticLockError(id);
  return { id, verification: level };
}

export async function listContexts() {
  const res = await pool.query(
    `select c.name as context, c.description, c.owner, c.expert,
            count(k.id) filter (where k.status = 'approved')      as approved,
            count(k.id) filter (where k.status = 'draft')         as draft,
            count(k.id) filter (where k.verification = 'expert')  as expert_verified,
            array_agg(distinct k.type) filter (where k.id is not null) as types
       from contexts c
       left join knowledge k on k.context = c.name
      group by c.name, c.description, c.owner, c.expert
      order by c.name`,
  );
  return res.rows;
}

export async function pendingReviews() {
  const res = await pool.query(
    `select id, type, context, title, status, verification, needs_review,
            left(coalesce(review_notes, ''), 200) as review_notes,
            created_by, created_at
       from knowledge
      where status = 'draft' or needs_review
      order by created_at asc
      limit 100`,
  );
  return res.rows;
}
