import { readFileSync } from "node:fs";
import pg from "pg";

// 既存 db コンテナの開発 DB(koto)に管理接続し、テスト専用 DB koto_test を作り直す。
// migrations は旧スキーマで初期化済みの既存 DB 向けなので適用しない。
// 001_schema.sql が最新の完全スキーマ(compose の初期化と同一)。
const admin = new pg.Client({
  connectionString: process.env.ADMIN_DATABASE_URL ?? "postgres://koto:koto@localhost:5432/koto",
});
try {
  await admin.connect();
} catch (err) {
  console.error("DB に接続できません。先に `docker compose up -d` を実行してください。");
  console.error(String(err));
  process.exit(1);
}
await admin.query("drop database if exists koto_test with (force)");
await admin.query("create database koto_test");
await admin.end();

const testDb = new pg.Client({
  connectionString: "postgres://koto:koto@localhost:5432/koto_test",
});
await testDb.connect();
await testDb.query(readFileSync("docker/db/init/001_schema.sql", "utf8"));
await testDb.end();
console.log("koto_test を初期化しました");
