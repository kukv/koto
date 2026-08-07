-- 旧スキーマ(event型なし)で初期化済みのDBに適用するマイグレーション
alter table knowledge drop constraint knowledge_type_check;
alter table knowledge add constraint knowledge_type_check
  check (type in ('term','rule','decision','requirement','faq','event'));
