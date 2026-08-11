import pg from "pg";

const DEFAULT_CONNECTION_STRING = "postgres://koto:koto@localhost:5432/koto";
const ALLOWED_PROTOCOLS = ["postgres:", "postgresql:"];
const FORMAT_HINT =
  "postgres://ユーザー:パスワード@ホスト:ポート/DB名 の形式で指定してください" +
  "(例: postgres://koto:koto@localhost:5432/koto)";

/**
 * DATABASE_URL を解決する。未設定なら既定値、形式が不正なら投げる。
 *
 * pg は接続文字列を new URL(str, "postgres://base") で解釈するため、`...` のような壊れた値でも
 * ホスト base として通る。new pg.Pool() は接続を張らないので生成も成功し、最初のクエリで初めて
 * `EAI_AGAIN base` として失敗する。起動時に弾いて原因を名指しする。
 *
 * 不正値を既定値へフォールバックさせないのは、意図しない DB に draft を書き込む方が、
 * 繋がらないことより害が大きいため。エラーメッセージに受け取った値は含めない(認証情報が残る)。
 */
export function resolveConnectionString(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_CONNECTION_STRING;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`DATABASE_URL の形式が不正です。${FORMAT_HINT}`);
  }
  // ホストの有無は見ない。postgres:///db?host=/var/run/postgresql は空ホストのまま正当
  if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
    throw new Error(
      `DATABASE_URL のスキームが不正です。postgres: または postgresql: を期待しましたが ${url.protocol} でした。${FORMAT_HINT}`,
    );
  }
  return raw;
}

export const pool = new pg.Pool({
  connectionString: resolveConnectionString(process.env.DATABASE_URL),
});
