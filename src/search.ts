import { pool } from "./db.js";
import { embed, toVectorLiteral } from "./embeddings.js";

export interface SearchOptions {
  context?: string;
  type?: string;
  includeDrafts?: boolean;
  limit?: number;
}

// 共通フィルタ: context / type / status(既定は approved のみ)
const FILTERS = `($2::text is null or context = $2)
  and ($3::text is null or type = $3)
  and (case when $4::boolean then status <> 'deprecated' else status = 'approved' end)`;

/**
 * キーワード検索(PGroonga)とベクトル検索の結果を RRF(順位融合)で統合する。
 * 埋め込みが無効な環境ではキーワード検索のみで動作する。
 */
export async function hybridSearch(query: string, opts: SearchOptions = {}) {
  const limit = opts.limit ?? 10;
  const vec = await embed(query);
  const base = [query, opts.context ?? null, opts.type ?? null, opts.includeDrafts ?? false];

  if (vec) {
    const sql = `
      with kw as (
        select id,
               row_number() over (order by pgroonga_score(tableoid, ctid) desc) as r
          from knowledge
         where search_text &@~ $1 and ${FILTERS}
         limit 50
      ),
      vec as (
        select id,
               row_number() over (order by embedding <=> $5::vector) as r
          from knowledge
         where embedding is not null and ${FILTERS}
         limit 50
      ),
      fused as (
        select id, sum(1.0 / (60 + r)) as score
          from (select * from kw union all select * from vec) u
         group by id
      )
      select k.id, k.type, k.context, k.title, k.english_name,
             k.status, k.verification, k.needs_review,
             left(k.body, 400) as excerpt,
             round(f.score::numeric, 4) as score
        from fused f
        join knowledge k on k.id = f.id
       order by f.score desc
       limit $6`;
    const res = await pool.query(sql, [...base, toVectorLiteral(vec), limit]);
    return res.rows;
  }

  const sql = `
    select k.id, k.type, k.context, k.title, k.english_name,
           k.status, k.verification, k.needs_review,
           left(k.body, 400) as excerpt,
           pgroonga_score(k.tableoid, k.ctid) as score
      from knowledge k
     where search_text &@~ $1 and ${FILTERS}
     order by score desc
     limit $5`;
  const res = await pool.query(sql, [...base, limit]);
  return res.rows;
}
