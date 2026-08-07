import pg from "pg";

export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://knowledge:knowledge@localhost:5432/knowledge",
});
