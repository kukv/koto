import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

// vitest の globalSetup。既存 db コンテナの開発 DB(koto)に管理接続し、
// テスト専用 DB koto_test を作り直す。
// migrations は旧スキーマで初期化済みの既存 DB 向けなので適用しない。
// 001_schema.sql が最新の完全スキーマ(compose の初期化と同一)。
// 索引を壊してプラン退行検知を実験するときは注意: `pnpm test` はこの globalSetup により
// 毎回 koto_test を作り直すため、この setup を外した一時 vitest config(commit 対象外)を
// 使わないと索引の変更が実行の都度消えてしまう。
const SCHEMA_PATH = fileURLToPath(
  new URL("../../../../docker/db/init/001_schema.sql", import.meta.url),
);

export default async function setup() {
  const admin = new pg.Client({
    connectionString: process.env.ADMIN_DATABASE_URL ?? "postgres://koto:koto@localhost:5432/koto",
  });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `DB に接続できません。先に \`docker compose up -d\` を実行してください。\n${String(err)}`,
    );
  }
  await admin.query("drop database if exists koto_test with (force)");
  await admin.query("create database koto_test");
  await admin.end();

  const testDb = new pg.Client({
    connectionString: "postgres://koto:koto@localhost:5432/koto_test",
  });
  await testDb.connect();
  await testDb.query(readFileSync(SCHEMA_PATH, "utf8"));
  await testDb.end();
  console.log("koto_test を初期化しました");
}
