# MCP サーバの配布方式(バンドル + GitHub Releases) 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MCP サーバを esbuild で単一 ESM ファイルにバンドルし、タグ push で GitHub Releases に添付して、他マシンでは `gh release download` の1行だけで導入・更新できるようにする。

**Architecture:** `tsc` の出力 `dist/` を入力に、ラッパーエントリ経由で esbuild がバンドルする(`pg` が CJS のため `createRequire` シムを banner で注入する)。生成物はコミットせず、タグ push で走る CI がビルド → バンドル → スモークテスト → Release 添付までを行う。インストールスクリプトは作らず、README のワンライナーで済ませる。

**Tech Stack:** esbuild 0.28.1 / TypeScript 7 / Node 24 / pnpm workspace / GitHub Actions / `gh` CLI

**設計:** `docs/superpowers/specs/2026-08-09-mcp-distribution-design.md`

## Global Constraints

- パッケージ管理は **pnpm**。`npm` は使わない。
- **esbuild のバージョンは `0.28.1` 固定**(lockfile に既存のバージョン)。上げない。`pnpm-workspace.yaml` の supply-chain 設定(`minimumReleaseAge: 10080` / `trustPolicy` / `strictDepBuilds` / `blockExoticSubdeps` / `strictPeerDependencies`)は緩めない。`allowBuilds` への追記も不要(esbuild は既に登録済み)。
- 新規依存の追加は `package.json` を直接編集し、`pnpm install` で lockfile を更新してコミットする。
- `pnpm run build` は `typecheck` / `test` の前に必須(workspace パッケージが `dist` 越しに解決されるため)。
- `pnpm test` の実行前に `docker compose up -d` で DB が起動していること。
- **バンドル生成物 `koto-mcp.mjs` はコミットしない**(`.gitignore` に追加する)。
- 拡張子は **`.mjs`**。`.js` にすると Node が CJS として解釈して起動に失敗する。
- GitHub Actions の action は既存 `ci.yml` と**同じ pinned SHA** を使う。SHA を新しくしない。
- コメント・出力メッセージは日本語。既存ファイルのスタイルに合わせる。
- 各タスクの最後に `pnpm run lint:fix` を通してからコミットする。

---

## ファイル構成

**新規作成:**

| ファイル | 責務 |
|---|---|
| `packages/mcp-server/bundle-entry.mjs` | esbuild のエントリ。`dist/mcp-server.js` を import するだけ。banner と shebang の衝突を避けるために存在する |
| `packages/mcp-server/scripts/smoke-bundle.mjs` | バンドルを起動し `initialize` / `tools/list` が返ることを検証する。DB 不要 |
| `.github/workflows/release.yml` | タグ push でバンドルを作り Release に添付する |

**変更:**

| ファイル | 変更内容 |
|---|---|
| `packages/mcp-server/package.json` | `esbuild` を devDependencies に追加。`bundle` / `smoke` スクリプトを追加 |
| `.gitignore` | `packages/mcp-server/koto-mcp.mjs` を追加 |
| `biome.json` | `files.includes` に `packages/*/scripts/**/*.mjs` を追加(新規スクリプトを整形・検査の対象に入れる) |
| `README.md` | 「MCPサーバの接続」を「利用のみ」「開発時」の2経路に分ける。DB の扱いを明記 |
| `CLAUDE.md` | コマンド一覧にバンドル生成を追加 |
| `docs/業務知識基盤_設計記録.md` | 決定として追記(既存記述は履歴なので書き換えない) |

---

### Task 1: バンドル生成とスモークテスト

**Files:**
- Create: `packages/mcp-server/scripts/smoke-bundle.mjs`
- Create: `packages/mcp-server/bundle-entry.mjs`
- Modify: `packages/mcp-server/package.json`
- Modify: `.gitignore`
- Modify: `biome.json`

**Interfaces:**
- Produces: `pnpm --filter @kukv/koto-mcp run bundle` が `packages/mcp-server/koto-mcp.mjs` を生成する。`pnpm --filter @kukv/koto-mcp run smoke` が同ファイルを検証し、成功で exit 0 / 失敗で exit 1 を返す。Task 2 の CI はこの2コマンドをそのまま呼ぶ。

**背景(実装者向け):** バンドルには実測で判明した罠が3つある。順に踏まないよう、この順序で作業する。

1. `pg` は CJS で `require("events")` を呼ぶため、ESM 出力のままでは実行時に `Dynamic require of "events" is not supported` で落ちる。banner で `createRequire` を注入して解決する。`--format=cjs` は `dist/mcp-server.js` の top-level await のため esbuild が拒否するので選べない。
2. `dist/mcp-server.js` の先頭には shebang があり、banner はその**前**に挿入されるため shebang が2行目に来て構文エラーになる。shebang を持たないラッパーエントリを噛ませて回避する(esbuild は非エントリファイルの shebang を落とす)。MCP 登録は `node <path>` で呼ぶので、生成物に shebang は不要。
3. `pg` のオプショナル依存 `pg-native` と `cloudflare:sockets` は解決できないので `--external:` で外す。

- [ ] **Step 1: スモークテストを書く**

`packages/mcp-server/scripts/smoke-bundle.mjs` を新規作成:

```js
// バンドルしたサーバを起動し、initialize と tools/list が正常に返ることを確認する。
// require シムの漏れや外部化漏れといったバンドル固有の失敗は通常のテストでは検出できないため、
// リリース前のゲートとして必要。DB には接続しない。
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_TOOL_COUNT = 11;
const TIMEOUT_MS = 30_000;

const bundlePath = join(dirname(dirname(fileURLToPath(import.meta.url))), "koto-mcp.mjs");

let finished = false;

function fail(message) {
  if (finished) return;
  finished = true;
  console.error(`smoke: ${message}`);
  process.exit(1);
}

function pass(message) {
  finished = true;
  console.log(`smoke: ${message}`);
  process.exit(0);
}

const child = spawn(process.execPath, [bundlePath], {
  env: {
    ...process.env,
    DATABASE_URL: "postgres://smoke:smoke@127.0.0.1:1/smoke",
    KOTO_REVIEWER: "smoke",
  },
  stdio: ["pipe", "pipe", "inherit"],
});

const timer = setTimeout(() => {
  child.kill("SIGKILL");
  fail(`${TIMEOUT_MS}ms 以内に応答がありませんでした`);
}, TIMEOUT_MS);
timer.unref();

child.on("error", (err) => fail(`起動できませんでした: ${err.message}`));
child.on("exit", (code) => fail(`応答を返す前に終了しました (code=${code})`));

let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim() === "") continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail(`JSON-RPC として解釈できない出力: ${line}`);
      return;
    }
    if (message.id !== 2) continue;
    const tools = message.result?.tools;
    if (!Array.isArray(tools)) {
      fail(`tools/list が失敗しました: ${line}`);
      return;
    }
    if (tools.length !== EXPECTED_TOOL_COUNT) {
      fail(`ツール数が ${EXPECTED_TOOL_COUNT} ではありません: ${tools.length} 本`);
      return;
    }
    child.kill("SIGKILL");
    pass(`ツール ${tools.length} 本を確認しました`);
  }
});

child.stdin.write(
  `${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0" },
    },
  })}\n`,
);
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
```

- [ ] **Step 2: スモークテストが失敗することを確認**

Run: `node packages/mcp-server/scripts/smoke-bundle.mjs; echo "exit=$?"`

Expected: バンドルが存在しないため失敗する。`smoke: 起動できませんでした: ...` または `smoke: 応答を返す前に終了しました (code=1)` が出て `exit=1`。

- [ ] **Step 3: ラッパーエントリを作る**

`packages/mcp-server/bundle-entry.mjs` を新規作成:

```js
// esbuild のバンドル用エントリ。
// dist/mcp-server.js を直接エントリにすると、その先頭の shebang が banner の後ろ(2行目)に
// 置かれて構文エラーになるため、shebang を持たないこのファイルを噛ませる。
import "./dist/mcp-server.js";
```

- [ ] **Step 4: bundle / smoke スクリプトと devDependency を追加**

`packages/mcp-server/package.json` の `scripts` に2行、`devDependencies` に1行を追加する。JSON なので `--banner:js=` の中の二重引用符は `\"` でエスケープし、引数全体をシェルのシングルクォートで囲む(この引用符の組み合わせは実測で確認済み):

```json
  "scripts": {
    "build": "tsc",
    "bundle": "esbuild bundle-entry.mjs --bundle --platform=node --target=node24 --format=esm --outfile=koto-mcp.mjs --external:pg-native --external:cloudflare:sockets '--banner:js=import{createRequire as __cr}from\"node:module\";const require=__cr(import.meta.url);'",
    "smoke": "node scripts/smoke-bundle.mjs",
    "typecheck": "tsc --noEmit",
    "typecheck:tests": "tsc -p tsconfig.test.json",
    "start": "node dist/mcp-server.js"
  },
```

`devDependencies` に(既存の並びはアルファベット順なので `@types/node` の前):

```json
    "esbuild": "0.28.1",
```

- [ ] **Step 5: 依存をインストール**

Run: `pnpm install`
Expected: 成功し `pnpm-lock.yaml` に差分が出る。`ERR_PNPM_*` が出たら止めて報告する(supply-chain 設定を緩めて回避してはならない)。

- [ ] **Step 6: `.gitignore` に生成物を追加**

`### node / typescript ###` ブロックの `*.log` の次の行に追加:

```
packages/mcp-server/koto-mcp.mjs
```

- [ ] **Step 7: biome の対象に scripts を追加**

`biome.json` の `files.includes` を次に変更:

```json
  "files": {
    "includes": [
      "packages/*/src/**/*.ts",
      "packages/*/tests/**/*.ts",
      "packages/*/scripts/**/*.mjs",
      "vitest.config.ts"
    ]
  },
```

- [ ] **Step 8: バンドルしてスモークテストが通ることを確認**

Run:
```bash
pnpm run build
pnpm --filter @kukv/koto-mcp run bundle
pnpm --filter @kukv/koto-mcp run smoke
```

Expected: bundle が `koto-mcp.mjs 1.3mb` 前後を出力し、smoke が `smoke: ツール 11 本を確認しました` を出して exit 0。

失敗したときの切り分け:
- `Dynamic require of "events" is not supported` → banner が届いていない。`package.json` の引用符を見直す
- `Invalid or unexpected token` で `#!/usr/bin/env node` が指されている → エントリを `bundle-entry.mjs` ではなく `dist/mcp-server.js` にしている
- `Could not resolve "pg-native"` → `--external:` の指定漏れ

- [ ] **Step 9: 既存を壊していないことを確認**

Run:
```bash
pnpm run lint:fix
pnpm run typecheck
docker compose up -d
pnpm test
```

Expected: すべて成功。`typecheck` と `test` は既存のまま通ること(このタスクは既存コードを変更していない)。

- [ ] **Step 10: コミット**

```bash
git add packages/mcp-server/package.json packages/mcp-server/bundle-entry.mjs packages/mcp-server/scripts/smoke-bundle.mjs pnpm-lock.yaml .gitignore biome.json
git commit -m "feat(mcp): esbuild で単一ファイルにバンドルできるようにする"
```

---

### Task 2: タグ push で Release を作る CI

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: Task 1 の `pnpm --filter @kukv/koto-mcp run bundle` と `... run smoke`
- Produces: `v*` タグを push すると `packages/mcp-server/koto-mcp.mjs` が添付された Release ができる

**背景(実装者向け):** action の SHA は既存 `.github/workflows/ci.yml` からそのままコピーする(新しい SHA を調べて置き換えないこと)。`permissions: contents: write` はこのワークフローだけに与える。既存 `ci.yml` / `security.yml` の `contents: read` は変更しない。lint / typecheck / test を再実行しないのは、タグを PR CI を通った main のコミットに打つ運用が前提だから。

- [ ] **Step 1: ワークフローを書く**

`.github/workflows/release.yml` を新規作成:

```yaml
name: release

# v* タグの push で MCP サーバの単一ファイルバンドルを作り、GitHub Releases に添付する。
# 利用側はこのアセットを gh release download で取得する(clone と pnpm build が不要になる)。
# lint / typecheck / test は再実行しない。タグは PR CI を通った main のコミットに打つ前提。

on:
  push:
    tags:
      - "v*"

# Release の作成にはリポジトリへの書き込みが必要。
permissions:
  contents: write

jobs:
  release:
    name: release
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Setup pnpm
        uses: pnpm/action-setup@0e279bb959325dab635dd2c09392533439d90093 # v6
      - name: Setup Node
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24
          cache: pnpm
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      - name: Build
        run: pnpm build
      - name: Bundle
        run: pnpm --filter @kukv/koto-mcp run bundle
      # バンドル固有の失敗(require シム漏れ・外部化漏れ)は pnpm test では検出できない。
      # 壊れたバンドルを配らないための歯止め。DB は不要。
      - name: Smoke test
        run: pnpm --filter @kukv/koto-mcp run smoke
      - name: Create release
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh release create "$GITHUB_REF_NAME" packages/mcp-server/koto-mcp.mjs --generate-notes
```

- [ ] **Step 2: YAML が壊れていないことを確認**

Run: `node -e "require('node:fs').readFileSync('.github/workflows/release.yml','utf8')" && gh workflow list --limit 20`

Expected: ファイルが読め、`gh workflow list` が現在のワークフロー(ci / security)を返す(release はまだ main に無いので出てこない)。

**注記:** ワークフローの実際の動作確認はタグを push するまでできない。Task 4 で行う。

- [ ] **Step 3: コミット**

```bash
git add .github/workflows/release.yml
git commit -m "ci: タグ push でバンドルを Release に添付する"
```

---

### Task 3: ドキュメント更新

**Files:**
- Modify: `README.md`(「MCPサーバの接続」節)
- Modify: `CLAUDE.md`(コマンド一覧)
- Modify: `docs/業務知識基盤_設計記録.md`(末尾に追記)

**Interfaces:**
- Consumes: Task 1 が生成する `koto-mcp.mjs` というアセット名、Task 2 が作る Release

- [ ] **Step 1: README の「MCPサーバの接続」を書き換える**

現在の節(`## MCPサーバの接続` から `ツール一覧:` の行の直前まで)を次で置き換える。`ツール一覧:` の行はそのまま残す:

````markdown
## MCPサーバの接続

### 利用のみ(推奨)

Release からバンドル済みの単一ファイルを取得します。clone も `pnpm build` も不要です(`gh` の認証で private リポジトリからも取得できます)。

```bash
mkdir -p ~/.local/share/koto
gh release download --repo kukv/koto --pattern koto-mcp.mjs --dir ~/.local/share/koto --clobber
claude mcp add koto \
  --env DATABASE_URL=postgres://koto:koto@localhost:5432/koto \
  --env KOTO_REVIEWER=あなたの名前 \
  -- node ~/.local/share/koto/koto-mcp.mjs
# 埋め込みを使う場合のみ: --env EMBEDDING_PROVIDER=openai --env OPENAI_API_KEY=sk-...
```

更新は `gh release download` の行を再実行するだけです(`--clobber` で上書き)。反映は Claude Code の `/mcp reconnect` で足り、再起動は要りません。

**DB は配布に含まれません。** 次のどちらかが必要です:

- **既存マシンの DB に `DATABASE_URL` を向ける** — このマシンでは clone が不要になります
- **clone して `docker compose up -d --build`** — そのマシンに DB を立てます。知識はマシンごとに分かれます

### 開発時

リポジトリを clone して作業する場合は、ビルド済みの `dist` を直接指します。事前に `pnpm build` を実行してください。

```bash
claude mcp add koto \
  --env DATABASE_URL=postgres://koto:koto@localhost:5432/koto \
  --env KOTO_REVIEWER=あなたの名前 \
  -- node /絶対パス/koto/packages/mcp-server/dist/mcp-server.js
```

Claude Desktop (claude_desktop_config.json):

```json
{
  "mcpServers": {
    "koto": {
      "command": "node",
      "args": ["/絶対パス/koto/packages/mcp-server/dist/mcp-server.js"],
      "env": {
        "DATABASE_URL": "postgres://koto:koto@localhost:5432/koto"
      }
    }
  }
}
```

`KOTO_REVIEWER` は承認ダイアログに出す**確認者の候補**です。カンマ区切りで複数指定でき(`KOTO_REVIEWER=野中,田中`)、ダイアログではこの中から選びます。**未設定だと承認・却下・検証レベルの設定ができません**(誰が判断したかを記録できないため)。

### リリース(メンテナ向け)

`v*` タグを push すると CI がバンドルして Release に添付します。

```bash
git tag v0.1.1
git push origin v0.1.1
```
````

- [ ] **Step 2: CLAUDE.md のコマンド一覧に追加**

`pnpm run mcp` の行の次に追加:

```
pnpm --filter @kukv/koto-mcp run bundle   # 配布用の単一ファイル koto-mcp.mjs を生成(要 pnpm run build)
pnpm --filter @kukv/koto-mcp run smoke    # 生成したバンドルの起動確認(ツール11本)
```

- [ ] **Step 3: 設計記録に追記**

`docs/業務知識基盤_設計記録.md` の末尾に追加(既存記述は履歴なので書き換えない):

```markdown
## 追記 2026-08-09: MCP サーバの配布方式

他リポジトリから koto を使うときの障害のうち、残っていた「MCP 登録が `dist/*.js` の絶対パス」「`git pull` のたびに `pnpm build`」を解消した。esbuild で単一 ESM ファイル(約 1.3MB)にバンドルし、`v*` タグの push で GitHub Releases に添付する。利用側は `gh release download` の1行で導入・更新でき、clone も pnpm も不要になる。リポジトリは private のままでよい(`gh` が認証を通す)。

配布対象は MCP サーバ**だけ**にした。DB 資材とスキルを同梱すれば clone を完全になくせるが、スキルは clone + シンボリックリンクで `git pull` するだけで更新できる利点があり、DB はそもそもマシンごとに立てるべきものではない。新マシンでは既存マシンの DB に `DATABASE_URL` を向ける運用を想定する。この形なら Phase 2 で共有 DB に移すときも接続先の差し替えだけで済む。

インストールスクリプトは作らなかった。利用範囲が自分の複数マシンに限られるため、ワンライナーを README に置くだけで足り、スクリプトを配って更新する手間のほうが大きい。バージョンをコードに埋め込むこともしていない(`serverInfo.version` は `package.json` 由来のまま)。どの版を入れたかはタグと Release で追える。

**バンドルには3つの罠があった。** (a) `pg` が CJS で `require("events")` を呼ぶため ESM 出力に `createRequire` シムを banner で注入する必要がある。`--format=cjs` は top-level await のため選べない。(b) `dist/mcp-server.js` の shebang が banner の後ろに来て構文エラーになるため、shebang を持たないラッパーエントリを噛ませる。(c) `pg` のオプショナル依存 `pg-native` / `cloudflare:sockets` は `--external:` で外す。いずれも通常のテストでは検出できない失敗なので、リリース CI にバンドルを起動してツール11本を確認するスモークテストを置いた。
```

- [ ] **Step 4: リンクと表記を確認**

Run: `grep -n "koto-mcp.mjs\|gh release download\|bundle" README.md CLAUDE.md docs/業務知識基盤_設計記録.md`

Expected: アセット名が `koto-mcp.mjs` で全ファイル一致していること。`.js` と書いた箇所が無いこと。

- [ ] **Step 5: コミット**

```bash
git add README.md CLAUDE.md docs/業務知識基盤_設計記録.md
git commit -m "docs: バンドル配布の手順とリリース運用を追記"
```

---

### Task 4: リリースの実行と実機確認(マージ後)

**Files:** なし(操作のみ)

**Interfaces:**
- Consumes: main にマージされた Task 1〜3

**このタスクはタグ push という外向きの操作を含む。実行前に必ずユーザーに確認する。** Task 1〜3 が main にマージされてから行う。

- [ ] **Step 1: main が最新であることを確認**

Run: `git fetch origin && git log --oneline origin/main -3`
Expected: Task 1〜3 のコミットが `origin/main` に入っている。

- [ ] **Step 2: ユーザーに確認してからタグを push**

タグ名をユーザーに確認する(初回は `v0.1.1` を提案する。`package.json` の `version` は `0.1.0` のままで構わない — 配布物の版とパッケージ版を一致させる運用は取らない)。

```bash
git tag v0.1.1 origin/main
git push origin v0.1.1
```

- [ ] **Step 3: ワークフローの結果を確認**

Run: `gh run list --workflow release.yml --limit 1`
Expected: `completed success`。失敗していたら `gh run view --log-failed` で原因を見る。

- [ ] **Step 4: Release にアセットが付いたことを確認**

Run: `gh release view v0.1.1 --json assets --jq '.assets[].name'`
Expected: `koto-mcp.mjs`

- [ ] **Step 5: ワンライナーで取得して実機確認**

```bash
mkdir -p ~/.local/share/koto
gh release download --repo kukv/koto --pattern koto-mcp.mjs --dir ~/.local/share/koto --clobber
timeout 5 node ~/.local/share/koto/koto-mcp.mjs; echo "exit=$?"
```

Expected: `knowledge-base MCP server running (stdio)` が stderr に出て、stdio の入力待ちのまま 5 秒で timeout に切られる(`exit=124`)。起動さえすればここまでで十分。

続いて MCP 登録を差し替え、Claude Code から `search_knowledge` が動くことを確認する(既存の user スコープ登録は `claude mcp remove koto -s user` で外してから登録し直す。スコープ重複に注意)。

- [ ] **Step 6: 結果をユーザーに報告**

Release の URL と、MCP 経由で検索が動いたことを報告する。

---

## 完了条件

1. `pnpm --filter @kukv/koto-mcp run bundle` で `koto-mcp.mjs` が生成される
2. `pnpm --filter @kukv/koto-mcp run smoke` が `ツール 11 本を確認しました` で exit 0
3. `pnpm run typecheck` と `pnpm test` が通る
4. タグ push で Release にアセットが付く
5. ワンライナーで取得したファイルを MCP 登録して `search_knowledge` が動く
