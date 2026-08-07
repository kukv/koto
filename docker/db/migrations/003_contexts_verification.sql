-- コンテキストのマスタ化と検証レベルの追加(旧スキーマで初期化済みのDB向け)
create table if not exists contexts (
  name        text primary key,
  description text,
  owner       text,
  expert      text,
  created_at  timestamptz not null default now()
);

-- 既存knowledgeのcontextをマスタへ吸い上げる
insert into contexts (name)
  select distinct context from knowledge
  on conflict (name) do nothing;

alter table knowledge
  add constraint knowledge_context_fkey
  foreign key (context) references contexts(name);

alter table knowledge
  add column verification text not null default 'none'
    check (verification in ('none','internal','expert')),
  add column verified_by text,
  add column verified_at timestamptz;
