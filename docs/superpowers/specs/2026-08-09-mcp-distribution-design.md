# MCP サーバの配布方式(バンドル + GitHub Releases) 設計

日付: 2026-08-09
ステータス: 承認済み

## 背景と目的

koto を他リポジトリでの作業から使うときの障害は3つあった(`2026-08-09-review-mcp-migration-design.md` 参照)。

1. ~~レビューのたびに koto リポジトリへ `cd` する~~ → 承認を MCP ツール化して解消済み
2. MCP 登録が `dist/*.js` の絶対パス指定
3. `git pull` のたびに `pnpm build` が要る

本設計は残る (2)(3) を解消する。CLI 2パッケージの削除により配布対象は `koto-mcp` 1本になっており、単一ファイルへのバンドルが現実的になった。

利用範囲は**自分の複数マシン**であり、チーム配布は想定しない。リポジトリは private のままとする(`gh` が認証を通すため Release からの取得に支障はない)。

## 決定事項

- **esbuild で単一 ESM ファイルにバンドルし、GitHub Releases から配布する**。依存は `@modelcontextprotocol/sdk` / `zod` / `pg` のみで、いずれも純 JS のためバンドル可能(実証済み、1.3MB)。
- **配布対象は MCP サーバのみ**とする。DB 資材(`compose.yaml` / `docker/db/`)とスキル(`skills/koto-import/`)は同梱しない。スキルは clone + シンボリックリンク運用を維持する(`skill-distribution-clone-symlink` の決定)。
- **インストールスクリプトは作らない**。`gh release download` のワンライナーを README に載せるだけにする。実装ゼロで仕組みが透明になり、更新も同じ1行の再実行で済む。
- **Release はタグ push で発行する**。どのマシンにどの版を入れたかが追え、壊れたときは前のタグに戻せる。
- **バージョンをコードに埋め込まない**。`serverInfo.version` は `package.json` 由来の `0.1.0` 固定のままとする。版の識別はタグと Release で足りる。

## バンドル生成

`packages/mcp-server` に esbuild を devDependency として追加する。バージョンは lockfile に既存の **0.28.1** に合わせる。これにより `pnpm-workspace.yaml` の `minimumReleaseAge: 10080` を自動的に満たし、`allowBuilds` の追記も不要になる(vitest 経由で既に登録済み)。

`pnpm run bundle` を追加し、`tsc` の出力 `dist/` を入力にバンドルする。実測で判明した必須事項が3点ある。

**1. オプショナル依存の外部化。** `--external:pg-native --external:cloudflare:sockets`。`pg` が持つオプショナル依存で、いずれも本構成では使わない。

**2. `createRequire` シムを banner に入れる。** `pg` は CJS で `require("events")` を呼ぶため、ESM 出力のままでは実行時に `Dynamic require of "events" is not supported` で落ちる。

```
--banner:js='#!/usr/bin/env node
import{createRequire as __cr}from"node:module";const require=__cr(import.meta.url);'
```

`--format=cjs` にすればシムは不要だが、`dist/mcp-server.js` が top-level await を使っているため esbuild が CJS 出力を拒否する。ESM + シムが唯一の経路である。

**3. ラッパーエントリを1ファイル追加する。** `dist/mcp-server.js` の先頭には shebang があり、banner がその前に挿入されると shebang が2行目に来て構文エラーになる。`packages/mcp-server/bundle-entry.mjs` を新規に置き、

```js
import "./dist/mcp-server.js";
```

これをエントリにする。esbuild は非エントリファイルの shebang を落とすため衝突しない。既存 `src/` の shebang は `package.json` の `bin` フィールドが参照しているので削除しない。

出力は `packages/mcp-server/koto-mcp.mjs`。拡張子を `.mjs` にするのは、`.js` だと Node が CJS として解釈して失敗するためである。`.gitignore` に追加する。

## リリース CI

`.github/workflows/release.yml` を新規に追加する。

- トリガ: `push: tags: ['v*']`
- `permissions: contents: write`(Release 作成に必要。既存 `ci.yml` / `security.yml` の `contents: read` は変更しない)
- action は既存 `ci.yml` と同じ pinned SHA を使う
- 手順: `pnpm install --frozen-lockfile` → `pnpm build` → `pnpm run bundle` → スモークテスト → `gh release create <tag> packages/mcp-server/koto-mcp.mjs`

**スモークテストを挟む。** バンドルに `initialize` と `tools/list` を JSON-RPC で流し、ツールが 11 本返ることを確認する。DB は不要。壊れたバンドルを配らないための歯止めであり、バンドル固有の失敗(上記の require シム漏れ等)は通常の `pnpm test` では検出できないため必要になる。

lint / typecheck / test は再実行しない。タグは PR CI を通った main のコミットに打つ前提とする。

## 利用側の手順

README の「MCPサーバの接続」を2経路に分ける。

**利用のみ(新マシン):**

```bash
mkdir -p ~/.local/share/koto
gh release download --repo kukv/koto --pattern koto-mcp.mjs --dir ~/.local/share/koto --clobber
claude mcp add koto \
  --env DATABASE_URL=postgres://koto:koto@localhost:5432/koto \
  --env KOTO_REVIEWER=あなたの名前 \
  -- node ~/.local/share/koto/koto-mcp.mjs
```

更新は `gh release download` の行を再実行するだけ(`--clobber` で上書き)。反映は `/mcp reconnect`(`koto-mcp-reload-via-reconnect` の通り Claude Code の再起動は不要)。

**開発時:** 従来の clone + `pnpm build` + `dist` 直指定を残す。

**DB について README に明記する。** 配布対象は MCP サーバのみなので、新マシンでは次のいずれかが必要になる。

- 既存マシンの DB へ `DATABASE_URL` を向ける(この場合 clone は不要になる)
- clone して `docker compose up -d --build` でそのマシンに DB を立てる(知識がマシンごとに分断される)

## 検証

1. `pnpm run bundle` が成功する
2. 生成した `koto-mcp.mjs` を `node` で起動し、`initialize` と `tools/list` が正常応答しツールが 11 本返る(手元でこの手順は既に実証済み)
3. `pnpm run typecheck` と `pnpm test` が通る(既存を壊していない)
4. タグを push して Release にアセットが付く
5. 実機確認: ワンライナーで取得したファイルを MCP 登録し、`search_knowledge` が動く

## スコープ外

- DB の一元化。マシンごとに DB が分かれる問題は残す。`DATABASE_URL` の差し替えで共有 DB に移行できる形を保つに留める(Phase 2)
- DB 資材とスキルの同梱、インストールスクリプト、起動時に自己更新するラッパー(いずれも検討の上で除外した)
- MCP サーバの HTTP 化・リモート化(Phase 2)
- npm への publish。`publishConfig` は残っているが、private リポジトリでの自分用配布に publish は不要
