-- search_text から aliases の JSON キー名を除き、全文索引をマルチカラム化する
-- (旧スキーマで初期化済みの DB 向け。001_schema.sql と同じ結果になる)

create or replace function koto_alias_names(jsonb) returns text
  language sql immutable strict as $$
  select coalesce(string_agg(a->>'name', ' '), '')
    from jsonb_array_elements($1) a
$$;

-- 生成列の式は ALTER で変更できないため列を作り直す。
-- v_knowledge_approved が select * で search_text に依存しているので先に落とす。
drop view v_knowledge_approved;
drop index idx_knowledge_fulltext;
alter table knowledge drop column search_text;

alter table knowledge add column search_text text generated always as (
  title || ' ' || coalesce(english_name, '') || ' ' || koto_alias_names(aliases) || ' ' || body
) stored;

create index idx_knowledge_fulltext on knowledge using pgroonga (
  search_text,
  status  pgroonga_text_term_search_ops_v2,
  context pgroonga_text_term_search_ops_v2,
  type    pgroonga_text_term_search_ops_v2
);

create view v_knowledge_approved as
  select * from knowledge where status = 'approved';
