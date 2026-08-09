-- 業務知識DB スキーマ v0.1
create extension if not exists pgroonga;
create extension if not exists vector;
create extension if not exists pgcrypto;

-- 別名は name だけを全文検索の対象にする(JSON のキー名を索引に混入させないため)
create function koto_alias_names(jsonb) returns text
  language sql immutable strict as $$
  select coalesce(string_agg(a->>'name', ' '), '')
    from jsonb_array_elements($1) a
$$;

-- コンテキストのマスタ: 置き場所は中央、正しさの判定権限は分散 — をデータで表現する
create table contexts (
  name        text primary key,
  description text,
  owner       text,          -- 承認責任者(部署・ロール)
  expert      text,          -- 外部専門家の確認が必要な領域ならその種別(税理士・弁護士等)
  created_at  timestamptz not null default now()
);

-- 知識レコード: 「チャンク」ではなく 1概念 = 1レコード
create table knowledge (
  id            uuid primary key default gen_random_uuid(),
  type          text not null check (type in ('term','rule','decision','requirement','faq','event')),
  context       text not null references contexts(name), -- 部署・領域(マスタはcontexts)
  title         text not null,                       -- 日本語名
  english_name  text,                                -- コード・テーブル・APIで使う正式名(1つに固定)
  body          text not null,                       -- 定義・ルール・前提・背景 (Markdown)
  aliases       jsonb not null default '[]'::jsonb,  -- [{"name":"メンバー","kind":"synonym"|"forbidden"}]
  examples      text[] not null default '{}',
  status        text not null default 'draft' check (status in ('draft','approved','deprecated')),
  -- 検証レベル: none=未検証 / internal=社内(オーナー)確認済 / expert=外部専門家確認済
  verification  text not null default 'none' check (verification in ('none','internal','expert')),
  verified_by   text,
  verified_at   timestamptz,
  needs_review  boolean not null default false,
  review_notes  text,                                -- 要確認事項・重複候補・却下理由など
  source        jsonb,                               -- {"kind":"document"|"hearing"|"conversation","ref":...}
  created_by    text not null default 'agent',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  embedding     vector(1536),
  -- 全文検索用の結合カラム(別名の name 込みでヒットさせる)
  search_text   text generated always as (
    title || ' ' || coalesce(english_name, '') || ' ' || koto_alias_names(aliases) || ' ' || body
  ) stored,
  -- 多義語はコンテキスト違いの別レコードとして共存させる
  unique (context, type, title)
);

-- status / context / type も索引に載せる。載せないとプランナが btree を選び、
-- 全文一致が Filter に落ちて pgroonga_score() が 0 を返す(順位が失われる)
create index idx_knowledge_fulltext on knowledge using pgroonga (
  search_text,
  status  pgroonga_text_term_search_ops_v2,
  context pgroonga_text_term_search_ops_v2,
  type    pgroonga_text_term_search_ops_v2
);
create index idx_knowledge_context   on knowledge (context, status);
create index idx_knowledge_embedding on knowledge using hnsw (embedding vector_cosine_ops);

-- 関連グラフ: 概念マップ・業務フロー・状態遷移はここから導出する(手書き保守しない)
-- ラベル規約:
--   モノ・用語間 : 意味を表すラベル(「含む」「引当」など) / 「同名別概念」
--   コト(event)間: 「先行」(from が to より先に起きる) / 「取消」(from は to を取り消す)
--   コト → モノ  : 「対象」(from イベントが to を対象とする)
create table knowledge_relations (
  from_id     uuid not null references knowledge(id) on delete cascade,
  to_id       uuid not null references knowledge(id) on delete cascade,
  label       text not null,        -- 「引当」「含む」「同名別概念」など
  cardinality text,                 -- 1, 1..*, * など
  primary key (from_id, to_id, label)
);

-- 全変更履歴: Gitの差分・履歴の代替
create table knowledge_revisions (
  id            bigserial primary key,
  knowledge_id  uuid not null references knowledge(id) on delete cascade,
  snapshot      jsonb not null,     -- 更新前のレコード全体(embedding除く)
  changed_by    text,
  changed_at    timestamptz not null default now()
);

create or replace function trg_knowledge_revision() returns trigger as $$
begin
  insert into knowledge_revisions (knowledge_id, snapshot, changed_by)
  values (old.id, to_jsonb(old) - 'embedding' - 'search_text', current_user);
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

create trigger knowledge_revision
  before update on knowledge
  for each row execute function trg_knowledge_revision();

-- 承認済みだけを見る既定ビュー
create view v_knowledge_approved as
  select * from knowledge where status = 'approved';
