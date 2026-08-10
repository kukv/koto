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

/**
 * 埋め込みに載せるテキスト。別名も含める —
 * aliases は検索専用の項目であり、キーワード検索でしか効かない状態をなくすため。
 */
export function embeddingSource(input: {
  title: string;
  english_name?: string | null;
  body: string;
  aliases?: Alias[] | null;
}): string {
  const aliasNames = (input.aliases ?? []).map((a) => a.name).join(" ");
  return [input.title, input.english_name ?? "", aliasNames, input.body].filter(Boolean).join(" ");
}

/**
 * 埋め込みを計算し直す変更か。検証レベルのリセット条件とは別物で、aliases はこちらにだけ効く
 * (別名を足しただけで専門家確認を無効にしない)。
 */
export function shouldReembed(changes: Partial<ProposeInput>): boolean {
  return (
    changes.title !== undefined ||
    changes.body !== undefined ||
    changes.english_name !== undefined ||
    changes.aliases !== undefined
  );
}

/**
 * 近似重複の検出: 同名・別名・english_name の完全一致 + 埋め込み類似。
 *
 * context をまたいで見る。同一 context の重複は unique(context, type, title) が防ぐので、
 * ここが受け持つのは「別の言葉が同じ物」(同義語)の方である。多義語(同じ言葉が context で
 * 別物)は english_name が分かれるため、横断しても誤検出にはならない。
 */
export async function findDuplicates(
  title: string,
  englishName: string | null,
  vec: number[] | null,
) {
  const seen = new Map<string, Record<string, unknown>>();

  const byName = await pool.query(
    `select id, title, context, type, status,
            case
              when lower(title) = lower($1) then '同名が一致'
              when exists (select 1 from jsonb_array_elements(aliases) a
                            where lower(a->>'name') = lower($1)
                              and a->>'kind' = 'forbidden') then '禁止表記に一致'
              when exists (select 1 from jsonb_array_elements(aliases) a
                            where lower(a->>'name') = lower($1)) then '別名が一致'
              else 'english_name が一致'
            end as reason
       from knowledge
      where lower(title) = lower($1)
         or exists (select 1 from jsonb_array_elements(aliases) a
                     where lower(a->>'name') = lower($1))
         or ($2::text is not null and lower(english_name) = lower($2))`,
    [title, englishName],
  );
  for (const r of byName.rows) {
    seen.set(r.id, r);
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

/**
 * 同じ english_name を持つ他のレコード(却下済みを除く)。
 * review_notes の重複候補は propose 時点のスナップショットなので、承認の瞬間に引き直す。
 */
export async function findEnglishNameConflicts(id: string) {
  const res = await pool.query(
    `select other.id, other.title, other.context, other.type, other.status
       from knowledge self
       join knowledge other
         on lower(other.english_name) = lower(self.english_name)
        and other.id <> self.id
      where self.id = $1
        and self.english_name is not null
        and other.status <> 'deprecated'
      order by other.context, other.title`,
    [id],
  );
  return res.rows as {
    id: string;
    title: string;
    context: string;
    type: string;
    status: string;
  }[];
}

export interface ForbiddenAlias {
  name: string;
  title: string;
  context: string;
}

/**
 * 承認済みレコードの禁止表記。命名警告フックが 1 回だけ引く。
 * 1 文字の語を外すのは、日本語に単語境界が無く部分一致の誤検知が頻発するため。
 */
export async function forbiddenAliases(): Promise<ForbiddenAlias[]> {
  const res = await pool.query(
    `select a->>'name' as name, k.title, k.context
       from knowledge k, jsonb_array_elements(k.aliases) a
      where k.status = 'approved'
        and a->>'kind' = 'forbidden'
        and length(a->>'name') >= 2
      order by k.context, k.title`,
  );
  return res.rows as ForbiddenAlias[];
}

/** 新しい知識を draft として提案する(承認されるまで検索の既定対象外) */
export async function propose(input: ProposeInput) {
  const vec = await embed(embeddingSource(input));
  const duplicates = await findDuplicates(input.title, input.english_name ?? null, vec);
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
  // 検証レベルのリセットは「内容」が変わったときだけ。aliases は検索専用なので含めない
  const contentChanged =
    changes.title !== undefined || changes.body !== undefined || changes.english_name !== undefined;
  const vec = shouldReembed(changes) ? await embed(embeddingSource(merged)) : null;

  await pool.query(
    `update knowledge
        set title = $2, english_name = $3, body = $4,
            aliases = $5::jsonb, examples = $6,
            needs_review = true,
            review_notes = coalesce(review_notes || E'\n', '') || $7,
            embedding = coalesce($8::vector, embedding),
            -- 内容が変わったら検証レベルは未検証に戻す(専門家確認は旧版に対するもの)
            verification  = case when $9::boolean then 'none' else verification end,
            verified_by   = case when $9::boolean then null else verified_by end,
            verified_at   = case when $9::boolean then null else verified_at end,
            verified_note = case when $9::boolean then null else verified_note end
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
            status, verification, verified_by, verified_at, verified_note,
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

/**
 * レビューを通して承認する(検索の既定対象になる。検証レベルは internal、既に expert なら維持)。
 * 承認は「未解決の確認事項は解決した」という宣言なので review_notes をクリアし、
 * 代わりに note(何を根拠に承認したか)を verified_note に残す。消えた review_notes は
 * revisions に残る。
 *
 * expectedUpdatedAt は楽観ロック用で、getKnowledge が返した updated_at(JS Date)を
 * toISOString() した文字列であることが前提(ms 精度)。to_char 等で作った独自形式の
 * 文字列を渡すと、内容が変わっていなくても一致せず「内容が変更された」扱いになる。
 *
 * deprecated なレコードの承認可否はここでは判定しない(呼び出し側の MCP 層で弾くこと)。
 */
export async function approve(id: string, by: string, note: string, expectedUpdatedAt: string) {
  const res = await pool.query(
    `update knowledge
        set status = 'approved', needs_review = false, review_notes = null,
            verification = case when verification = 'expert' then 'expert' else 'internal' end,
            verified_by = $2, verified_at = now(), verified_note = $3
      -- pg ドライバは timestamptz を ms 精度の Date で返すため、DB 側も ms に丸めて比較する
      where id = $1 and date_trunc('milliseconds', updated_at) = $4::timestamptz`,
    [id, by, note, expectedUpdatedAt],
  );
  if (res.rowCount === 0) await throwOptimisticLockError(id);
  return { id, status: "approved" as const };
}

/**
 * レビューで却下する(物理削除はせず deprecated にし、却下理由を履歴として残す)。
 *
 * expectedUpdatedAt は楽観ロック用で、getKnowledge が返した updated_at(JS Date)を
 * toISOString() した文字列であることが前提(ms 精度)。異なる形式の文字列を渡すと、
 * 内容が変わっていなくても一致せず「内容が変更された」扱いになる。
 */
export async function reject(id: string, reason: string, by: string, expectedUpdatedAt: string) {
  const res = await pool.query(
    `update knowledge
        set status = 'deprecated', needs_review = false,
            review_notes = coalesce(review_notes || E'\n', '') || $2
      -- pg ドライバは timestamptz を ms 精度の Date で返すため、DB 側も ms に丸めて比較する
      where id = $1 and date_trunc('milliseconds', updated_at) = $3::timestamptz`,
    [id, `却下(${by}): ${reason}`, expectedUpdatedAt],
  );
  if (res.rowCount === 0) await throwOptimisticLockError(id);
  return { id, status: "deprecated" as const };
}

/**
 * 検証レベルの引き上げ(internal=社内確認済 / expert=専門家確認済)。
 *
 * expectedUpdatedAt は楽観ロック用で、getKnowledge が返した updated_at(JS Date)を
 * toISOString() した文字列であることが前提(ms 精度)。異なる形式の文字列を渡すと、
 * 内容が変わっていなくても一致せず「内容が変更された」扱いになる。
 */
export async function setVerification(
  id: string,
  level: "internal" | "expert",
  by: string,
  note: string,
  expectedUpdatedAt: string,
) {
  const res = await pool.query(
    `update knowledge
        set verification = $2, verified_by = $3, verified_at = now(), verified_note = $4,
            needs_review = false, review_notes = null
      -- pg ドライバは timestamptz を ms 精度の Date で返すため、DB 側も ms に丸めて比較する
      where id = $1 and date_trunc('milliseconds', updated_at) = $5::timestamptz`,
    [id, level, by, note, expectedUpdatedAt],
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

export interface PendingReviewsOptions {
  context?: string;
  type?: KnowledgeType;
  /** 返す最大件数(既定 100)。total はこの影響を受けない */
  limit?: number;
}

/**
 * レビュー待ち(draft または要確認)の一覧。
 * total は絞り込み後・limit 適用前の件数なので、items の件数より多ければ打ち切られている。
 */
export async function pendingReviews(options: PendingReviewsOptions = {}) {
  const res = await pool.query(
    `select id, type, context, title, status, verification, needs_review,
            -- 途中で切れていることが受け手に伝わるよう、切り詰めたときだけ印を付ける
            case when length(review_notes) > 200 then left(review_notes, 200) || '…'
                 else coalesce(review_notes, '') end as review_notes,
            created_by, created_at,
            -- window 関数は limit より先に評価されるため、絞り込み後の全件数が入る
            count(*) over () as total
       from knowledge
      where (status = 'draft' or needs_review)
        and ($1::text is null or context = $1)
        and ($2::text is null or type = $2)
      order by created_at asc
      limit $3`,
    [options.context ?? null, options.type ?? null, options.limit ?? 100],
  );
  // total は全行に同じ値が付くため、先頭から取り出して各行からは落とす
  const total = res.rows.length === 0 ? 0 : Number(res.rows[0].total);
  const items = res.rows.map(({ total: _total, ...row }) => row);
  return { total, items };
}
