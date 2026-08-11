# 設計 — DATABASE_URL の検証とエラーメッセージ

> 記録日: 2026-08-11
> 対象: `docs/フィードバック_2026-08-10_mindstock承認作業.md` の 5.1(`DATABASE_URL` が壊れていてもフォールバックが効かず、原因が分からないエラーが出る)
> 前提環境: Node.js(ESM)、`pg` 8 系

フィードバックの優先度表で「中」の #6。単独で閉じる小さな変更として扱う。

## 1. 何が壊れているか

`~/.claude.json` の koto MCP 設定で `DATABASE_URL` の値が `...`(プレースホルダのまま)になっていたとき、出たエラーはこれだけだった。

```
エラー: getaddrinfo EAI_AGAIN base
```

ホスト名 `base` はどの設定ファイルにも書かれていないので、原因の見当が付かない。追跡すると 2 段階の問題が重なっている。

**(a) 既定値へのフォールバックが発動しない。** `packages/core/src/db.ts:4` は次のとおり。

```ts
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://koto:koto@localhost:5432/koto",
});
```

`??` は null / undefined しか拾わないため、`...` のような壊れた値でも空文字 `""` でも右辺に落ちない。

**(b) 失敗する場所が起動から遠い。** `pg` は接続文字列を `new URL(str, "postgres://base")` で解釈する。`...` は base 付きなので相対パス扱いとなり、ホストが `base` になる。これが `EAI_AGAIN base` の正体。しかも `new pg.Pool()` は接続を張らないので Pool 生成は成功し、MCP は接続成功として扱われる。**実際の失敗は最初のツール呼び出しまで遅れる。**

## 2. 決めたこと

### 2.1 不正値はフォールバックせずエラーで止める

フィードバック 5.1 は「明示的なエラー」と「フォールバックを効かせる」を両論併記していたが、**エラーで止める**方を採る。

ユーザーは `DATABASE_URL` を意図して書いている。その値が壊れているときに黙って既定の `localhost:5432/koto` へ繋ぐと、**意図しない DB に draft を書き込む**。知識基盤は書き込みを伴うので、繋がらないことより繋ぎ先を間違えることの方が害が大きい。

未設定(`undefined`)のときだけは従来どおり既定値へフォールバックする。これは「ローカルで `docker compose up` しただけで動く」課金ゼロ・設定ゼロの初期構成を支えている挙動なので変えない。

### 2.2 空文字もエラーにする

`DATABASE_URL=`(空文字)は「指定していない」ではなく「値が消えている」として扱い、エラーにする。

`.env` や MCP 登録に変数名だけが残っている状態は、たいてい書き換えの途中か貼り付けの失敗である。未設定と同じに扱うと 2.1 と同じ事故(意図しない DB への書き込み)が起きる。実装上も `new URL("")` が投げるので、パース不能と同じ経路で自然に落ちる。

### 2.3 判定は「パース不能」と「スキーム違い」の 2 つだけ

`new URL()` の実測結果:

```
"..."                                      -> throw ERR_INVALID_URL
""                                         -> throw ERR_INVALID_URL
"postgres://koto:koto@localhost:5432/koto" -> ok  protocol=postgres:  host="localhost"
"postgresql://a:b@h:5432/d"                -> ok  protocol=postgresql: host="h"
"http://localhost/koto"                    -> ok  protocol=http:      host="localhost"
"postgres:///koto"                         -> ok  protocol=postgres:  host=""
"postgres://user:pass@/koto?host=/var/run/postgresql" -> throw ERR_INVALID_URL(new URL 単体では通らない)
"/var/run/postgresql koto"                            -> throw ERR_INVALID_URL
```

したがって判定はこの 2 つで足りる。

1. `new URL(raw)` が投げる → 不正(`...` と `""` がここで捕まる)
2. `url.protocol` が `postgres:` / `postgresql:` 以外 → 不正(`http://` がここで捕まる)

**ホスト名の有無は見ない。** フィードバック 5.1 の提案は「パースできない / ホストが取れない場合」だったが、Unix ドメインソケット接続の `postgres:///koto?host=/var/run/postgresql` はホストが空文字のまま正当である。ホストの有無を条件に入れると、この正当な構成を弾く。

**ただし `new URL()` 単体では、認証情報付きの空ホスト URL(`postgres://user:pass@/koto?host=...`)を通せない。** 空ホスト直後の `@` が構文エラーになるため。libpq でソケット接続に認証を付けるときはこの書き方が標準的で、`postgres:///db?host=...` よりむしろ一般的である。ここを弾くと、現在のエラーメッセージ(「`postgres://ユーザー:パスワード@ホスト:ポート/DB名` の形式で指定してください」)がまさにその形式で書いた人を誤誘導することになる。

そこで `new URL(raw)` が失敗したときは `pg-connection-string`(`pg` が内部で使う接続文字列パーサ)と同じ再試行を挟む。`pg-connection-string@2.14.0` の `index.js:26-29` は `new URL()` が失敗すると `str.replace('@/', '@___DUMMY___/')` でダミーホストを差し込んで再試行しており、これは認証情報付きの空ホスト URL を通すための専用コードである。同じ再試行を `new URL(raw)` の catch に入れ、通ったときはスキーム検査だけを行って(ダミーを混ぜた文字列ではなく)`raw` をそのまま返す。両方失敗したら従来どおり形式エラーを投げる。

判定の数自体は変わらず、引き続き「パース不能」「スキーム違い」の 2 つのままで、パース不能側の判定内部に `pg` と同じ再試行が挟まる形になる。

この結果、`pg` が受け付ける非 URL 形式は非対応になる。具体的には `socket:/var/run/postgresql?db=koto` のような URL 以外のスキームに加え、先頭が `/` の libpq 形式(`/var/run/postgresql koto`)も対象で、これは `@/` 再試行を入れても救えない(`@` を含まないため)。koto が文書化している接続形式は `postgres://` だけなので、許容する制限として扱う。

### 2.4 検証は `db.ts` の読み込み時に行い、throw する

接続文字列を解決する純粋関数を `db.ts` に置き、`pool` 生成の引数に噛ませる。**`pool` を作る場所と検証する場所を同じにする**ことで、経路によって検証が漏れることがなくなる。

エントリポイント(`packages/mcp-server/src/mcp-server.ts`)で検証して `process.exit(1)` する案も検討したが採らない。`core` を直接使う経路(テスト、将来の別ツール)で検証が効かず、`db.ts` を読んだだけでは検証があることが分からない。

`db.ts` は `server.ts` → `core` の連鎖で起動時に読み込まれるため、throw は MCP サーバの起動失敗として stderr に出る。「最初のツール呼び出しまで失敗が遅れる」(1 の (b))はこれで解消される。

### 2.5 エラーメッセージに生値を含めない

メッセージは環境変数名と期待する形式だけを示し、**受け取った値そのものは出さない**。

```
DATABASE_URL の形式が不正です。postgres://ユーザー:パスワード@ホスト:ポート/DB名 の形式で指定してください(例: postgres://koto:koto@localhost:5432/koto)
```

スキーム違いのときだけ、検出したスキームを添える(`postgres:` / `postgresql:` を期待しましたが `http:` でした)。スキームは認証情報を含まないので出しても安全であり、`http://` と書いた人には決定的な手がかりになる。

生値を含める案は採らない。壊れているのはあくまで**形式**であって、`postgres://koto:本物のパスワード@host/db` の一部が欠けただけの文字列は十分にありうる。それを stderr へ出すと MCP クライアントのログに認証情報が残る。

生値が無くても、5.1 が問題にした「ホスト名 `base` はどこにも書いていない」という迷子状態は解消される。どの環境変数が悪いのかと、正しい形はどれかが両方示されるため。

### 2.6 命名警告フックがエラー終了するようになる(意図的な受け入れ)

`packages/mcp-server/src/check-naming.ts:1` は `@kukv/koto-core` を静的 import しており、`packages/mcp-server/src/mcp-server.ts:5` も `server.js` を静的 import している。そのため `db.ts` の throw は `checkNaming()` の `try` に入る前、モジュール読み込みの時点で起きる。`DATABASE_URL` の形式が不正な間は、Write/Edit のたびにフックプロセスがエラー終了する(PostToolUse なので編集自体は止まらないが、毎回ノイズが出る)。

これを意図的な振る舞いとして受け入れる。README:94 が約束しているフェイルオープン(「DB に繋がらないときは何もしません」)は接続の失敗に向けたもので、知識基盤の警告のために編集作業を止めない趣旨である。一方 `DATABASE_URL` の形式が不正な状態は接続の失敗ではなく設定のミスであり、この状態では MCP サーバ自体も起動しない。黙って無視するより、フックのエラーとして見えている方がよい。

フェイルオープンを復元するには `check-naming.ts` の `@kukv/koto-core` import と `mcp-server.ts` の `server.js` import を両方とも動的 import に変える必要があり、この設計の範囲を超える。

## 3. 変更の内容

### 3.1 `packages/core/src/db.ts`

```ts
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
    // pg-connection-string@2.14.0 index.js:26-29 は new URL() 失敗時に
    // str.replace('@/', '@___DUMMY___/') で再試行する。認証情報付きの Unix ソケット接続
    // (postgres://user:pass@/koto?host=/var/run/postgresql)は libpq の標準的な書き方で、
    // 単体の new URL() では空ホスト直後の @ が構文エラーになるため、pg と同じ救済を入れる。
    try {
      url = new URL(raw.replace("@/", "@___DUMMY___/"));
    } catch {
      throw new Error(`DATABASE_URL の形式が不正です。${FORMAT_HINT}`);
    }
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
```

`resolveConnectionString` は export する。単体テストから呼ぶためであり、他のモジュールから使う想定は無い。

`packages/core/src/index.ts` の公開 API には**追加しない**。パッケージ利用者向けの機能ではなく、`db.ts` の内部検証だからである。テストは `db.js` を直接 import する(既存の `tests/unit/embeddings.test.ts` も `../../src/embeddings.js` を直接読んでいる)。

### 3.2 波及しないもの

- `vitest.config.ts` は `test.env` で `DATABASE_URL` を注入しているため、既存テストは影響を受けない
- `.env.example` に書かれている接続文字列は `postgres://` 形式で、現行の記述のまま正しく変更しない。`README.md` は接続文字列自体は変更していないが、命名警告フックの節(形式不正時もフックがエラー終了する旨)と MCP サーバの接続の節(起動しないときは `DATABASE_URL` の形式と MCP ログを確認する旨)に 1 文ずつ追記した
- `docker/db/` 配下、マイグレーションには一切触れない

## 4. テスト

`packages/core/tests/unit/db.test.ts` を新規に作る。純粋関数なので DB は不要。

| # | 入力 | 期待 | これが無いと通ってしまう退行 |
|---|---|---|---|
| 1 | `undefined` | 既定値を返す | 未設定でも落ちる実装。設定ゼロで動く初期構成が壊れる |
| 2 | `"..."` | throw | 5.1 の不具合そのもの |
| 3 | `""` | throw | 空文字が既定値へ落ち、意図しない DB に繋ぐ(2.2) |
| 4 | `"http://localhost/koto"` | throw | スキーム検査の欠落。pg 側で分かりにくく失敗する |
| 5 | `"postgres://koto:koto@localhost:5432/koto"` | そのまま返す | 正当な値を弾く実装 |
| 6 | `"postgresql://a:b@h:5432/d"` | そのまま返す | `postgresql:` を許容し忘れる |
| 7 | `"postgres:///koto?host=/var/run/postgresql"` | そのまま返す | ホストの有無を条件に入れ、Unix ソケット接続を弾く(2.3) |
| 8 | `"http://koto:s3cret@localhost/koto"` | throw し、メッセージに `s3cret` が含まれない | 生値を混ぜる実装に戻り、認証情報が stderr に流れる(2.5)。パスワードを含む値を使わないと、この検証は空振りする |
| 9 | `"postgres://koto:s3cret@host:port/db"` | throw し、メッセージに `s3cret` が含まれない | パース失敗の分岐で生値が漏れる。`new URL()` の例外は `err.input` に生値を持つので、`cause` で繋ぐ書き換えが入ると漏れる |
| 10 | `"postgres://user:pass@/koto?host=/var/run/postgresql"` | そのまま返す | 認証情報付きのソケット接続を弾く(2.3) |
| 11 | `"http://user:pass@/koto"` | throw | `@/` 再試行が通ったあとスキーム検査が飛ばされる |

## 5. 本設計が扱わないもの

- 接続の疎通確認(起動時に実際に `select 1` を投げるなど)。形式の検証だけを行う。DB が落ちているケースは元々 `EAI_AGAIN` / `ECONNREFUSED` で意味の分かるエラーが出ており、5.1 の問題ではない
- `pg` の非 URL 形式への対応。`socket:` 等の URL 以外のスキームに加え、先頭が `/` の libpq 形式(`/var/run/postgresql koto`)も非対応(2.3)
- 他の環境変数(`EMBEDDING_PROVIDER` / `OPENAI_API_KEY` / `KOTO_REVIEWER`)の検証。`EMBEDDING_PROVIDER` は既定 `none` で不正値は無効扱いになり、黙って別の場所に書き込む類の事故は起きない
- フィードバックの残項目: 3.2 再 import の扱い、4.4 owner 未設定コンテキストでの承認警告、4.5 レビューをセッションとして扱う概念
- `packages/core/tests/helpers/global-setup.ts:18` の `ADMIN_DATABASE_URL` は `process.env.ADMIN_DATABASE_URL ?? "postgres://..."` のままで、今回直したのと同じ `??` によるフォールバックの穴が残っている。テスト専用のためスコープ外とするが、同じ穴が残っている記録として書いておく
