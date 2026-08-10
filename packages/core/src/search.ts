import { pool } from "./db.js";
import { embed, toVectorLiteral } from "./embeddings.js";

export interface SearchOptions {
  context?: string;
  type?: string;
  includeDrafts?: boolean;
  limit?: number;
}

/** like のワイルドカードを打ち消す。エスケープしないと「100%」等で rank 2 が誤発火する */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * 一致種別。順位の第一キーで、pgroonga_score より優先する。
 * スコアが取れない環境に落ちても上位の並びが壊れないための構造でもある。
 */
const MATCH_RANK = `case
    when lower(k.title) = lower($1) then 0
    when lower(coalesce(k.english_name, '')) = lower($1)
      or exists (select 1 from jsonb_array_elements(k.aliases) a
                  where lower(a->>'name') = lower($1)) then 1
    when k.title ilike $4 then 2
    else 3
  end`;

/**
 * 絞り込み条件。status だけは SQL を分岐させる —
 * case 式にするとマルチカラム PGroonga 索引の索引条件にならず、
 * プランナが btree を選んで全文一致が Filter に落ちる(pgroonga_score が 0 になる)。
 */
function filters(includeDrafts: boolean): string {
  const status = includeDrafts ? `k.status <> 'deprecated'` : `k.status = 'approved'`;
  return `${status}
    and ($2::text is null or k.context = $2)
    and ($3::text is null or k.type = $3)`;
}

// aliases を返すのは、誤った語で引いた人に「それは禁止表記で正はこれ」を伝えるため
const COLUMNS = `k.id, k.type, k.context, k.title, k.english_name, k.aliases,
       k.status, k.verification, k.needs_review,
       left(k.body, 400) as excerpt`;

/**
 * キーワード検索(埋め込み無効時の経路)の SQL とパラメータ。
 * プラン退行を検知するテストから EXPLAIN に掛けるため export している。
 */
export function buildKeywordQuery(
  query: string,
  opts: SearchOptions = {},
): { sql: string; params: unknown[] } {
  const q = query.trim();
  const sql = `
    select ${COLUMNS},
           pgroonga_score(k.tableoid, k.ctid) as score
      from knowledge k
     where k.search_text &@~ $1 and ${filters(opts.includeDrafts ?? false)}
     order by ${MATCH_RANK}, score desc, k.updated_at desc
     limit $5`;
  return {
    sql,
    params: [q, opts.context ?? null, opts.type ?? null, `%${escapeLike(q)}%`, opts.limit ?? 10],
  };
}

/**
 * キーワード検索(PGroonga)とベクトル検索の結果を RRF(順位融合)で統合する。
 * 埋め込みが無効な環境ではキーワード検索のみで動作する。
 */
export async function hybridSearch(query: string, opts: SearchOptions = {}) {
  const q = query.trim();
  const vec = await embed(q);

  if (!vec) {
    const { sql, params } = buildKeywordQuery(query, opts);
    const res = await pool.query(sql, params);
    return res.rows;
  }

  const limit = opts.limit ?? 10;
  const where = filters(opts.includeDrafts ?? false);
  // RRF は同じ一致種別の中での並びに使う。融合スコアだけで並べると
  // title 完全一致がベクトル側の順位に引きずられて上位から落ちうる
  const sql = `
    with kw as (
      select k.id, row_number() over (order by ${MATCH_RANK}, pgroonga_score(k.tableoid, k.ctid) desc) as r
        from knowledge k
       where k.search_text &@~ $1 and ${where}
       order by ${MATCH_RANK}, pgroonga_score(k.tableoid, k.ctid) desc
       limit 50
    ),
    vec as (
      select k.id, row_number() over (order by k.embedding <=> $5::vector) as r
        from knowledge k
       where k.embedding is not null and ${where}
       order by k.embedding <=> $5::vector
       limit 50
    ),
    fused as (
      select id, sum(1.0 / (60 + r)) as score
        from (select * from kw union all select * from vec) u
       group by id
    )
    select ${COLUMNS},
           round(f.score::numeric, 4) as score
      from fused f
      join knowledge k on k.id = f.id
     order by ${MATCH_RANK}, f.score desc, k.updated_at desc
     limit $6`;
  const res = await pool.query(sql, [
    q,
    opts.context ?? null,
    opts.type ?? null,
    `%${escapeLike(q)}%`,
    toVectorLiteral(vec),
    limit,
  ]);
  return res.rows;
}
