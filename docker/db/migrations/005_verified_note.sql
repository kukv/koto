-- 判定の根拠(承認根拠・検証根拠)を記録する列を追加する
-- (旧スキーマで初期化済みの DB 向け。001_schema.sql と同じ結果になる)

begin;

alter table knowledge add column verified_note text;

-- v_knowledge_approved は select * だが、列リストはビュー作成時に展開されて固定される。
-- 作り直さないと新規 DB(001_schema.sql)のビューと列が食い違う。
drop view v_knowledge_approved;
create view v_knowledge_approved as
  select * from knowledge where status = 'approved';

commit;
