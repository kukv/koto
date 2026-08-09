# 承認フローの MCP 移管と CLI 廃止 設計

日付: 2026-08-09
ステータス: 承認済み

## 背景と目的

koto を他リポジトリでの作業から使おうとすると、clone した作業コピーへの依存が3つ現れる。

1. レビューのたびに koto リポジトリへ `cd` して `pnpm run review` を叩く
2. MCP 登録が `dist/*.js` の絶対パス指定
3. `git pull` のたびに `pnpm build` が要る

このうち (1) はレビュー CLI の存在そのものが原因である。MCP ツールと突き合わせると、CLI 固有の機能は `approve` / `verify` / `reject` の3つだけで、`list` / `show` は `get_pending_reviews` / `get_knowledge` で代替できる。

設計記録には当初から次の方針がある(`docs/業務知識基盤_設計記録.md:73`)。

> レビュー運用の現実解: CLI直より**エージェントとの対話でレビュー**(「レビュー待ちを見せて」→会話で修正→承認)。人間は判断だけ。

承認系ツールが MCP に無いためにこれが未実装のまま残っていた。本設計はそれを実装し、CLI を廃止する。(2)(3) の配布方式は本設計のスコープ外とし、CLI が消えて配布対象が `koto-mcp` 1本になってから別途設計する。

## 決定事項

- **承認・検証・却下を MCP ツール3本として追加する**(8本 → 11本)。ツールは目的別に分け、1本にまとめない。
- **人間の確認は MCP の elicitation でサーバ側から強制する**。クライアント設定(permission)には依存しない。理由: permission は利用者が settings.json を書き換えれば消えるが、elicitation はサーバのコードを直さない限り外せない。加えて、複数マシンへ permission 設定を配る手間が不要になり、本件の動機である「リポジトリ非依存」に合致する。
- **確認者名は elicitation のフォームで人間に入力させる**。ツール引数では受け取らない。`verified_by` に入るのが人間がその場で打った値になり、エージェントによる捏造が構造的に不可能になる。
- **`packages/cli` と `packages/import` を削除する**。残るパッケージは `core` / `mcp-server` / `tsconfig` の3つ。
- **却下理由を必須にする**。現行 CLI は `review_notes` に固定文言「レビューで却下」を書くだけで、なぜ却下したかが残らない。却下理由は知識そのものなので残す。

## MCP ツール仕様

| ツール | 引数 | 動作 |
|---|---|---|
| `approve_knowledge` | `id` | `status=approved`, `needs_review=false`, `verification` を `internal` に(既に `expert` なら維持)、`verified_by` / `verified_at` を記録 |
| `verify_knowledge` | `id`, `level: internal\|expert` | `verification` を付け替え、`verified_by` / `verified_at` を記録 |
| `reject_knowledge` | `id`, `reason` | `status=deprecated`, `needs_review=false`, `review_notes` に却下理由を追記 |

`verify_knowledge` は `approve` とは別軸のラベル操作である。`status` が「検索に載るか」のゲートであるのに対し、`verification` は「内容をどこまで信用してよいか」を表す。`expert` は外部専門家(税理士・弁護士等)が確認したという主張であり、`approve` より重い。よって3ツールとも同じ強制を掛ける。

## elicitation の流れ

3ツールとも、DB を変更する**前に**クライアントへ elicitation を投げる。

1. クライアントが elicitation capability を宣言していなければ、**実行せず**にその旨をエラーとして返す
2. 対象レコードを取得する(存在しない、または既に対象外の状態ならエラー)
3. タイトル・種別・コンテキスト・本文冒頭を提示し、確認者名の入力フォームを出す。既定値は環境変数 `KOTO_REVIEWER`。確認者名は**必須項目**とする(空のまま確定できると `verified_by` が残らず、誰が判断したかを追えなくなる)
4. `accept` なら core 関数を呼ぶ。`decline` / `cancel` なら「ユーザーが承認しませんでした」を返し、**DB を一切変更しない**

`reject_knowledge` の `reason` はツール引数で受け取る(エージェントが会話の文脈から起草する)。elicitation ダイアログで内容を提示し、人間が見た上で確定させる。

## 実装

**`packages/core/src/knowledge.ts` に関数を追加する。** 現行 CLI にインライン SQL で書かれているロジックを core へ移す。

- `approve(id, by)` — 新規
- `reject(id, reason, by)` — 新規。理由を `review_notes` に追記する点が現行 CLI から変わる
- `setVerification()` — 既存をそのまま流用

MCP サーバ側は「レコード取得 → elicitation → core 関数呼び出し」の薄いラッパにする。

**削除するもの。**

- `packages/cli/` 一式
- `packages/import/` 一式(`tests/unit/extract.test.ts` を含む)
- ルート `package.json` の `import` / `review` スクリプト
- `.env.example` の `EXTRACT_PROVIDER` / `EXTRACT_MODEL` / `ANTHROPIC_API_KEY`

**ドキュメント更新。**

- `README.md` — CLI の節を削除し、レビューを会話で行う手順に差し替える。MCP 登録例に `KOTO_REVIEWER` を追加する
- `CLAUDE.md` — コマンド一覧と構成
- `skills/koto-import/SKILL.md:38` — 「承認(approve)はユーザーの仕事 — 代行しない」を、ツールは呼ぶが判断は確認ダイアログでユーザーが行う旨に調整する
- `docs/業務知識基盤_設計記録.md` — 決定として追記する。既存記述は履歴なので書き換えない

## 検証

- `core` の `approve` / `reject` に DB 統合テストを追加する(既存 `packages/core/tests/integration/knowledge.test.ts` のパターンに従う)
- MCP 層は SDK の `InMemoryTransport` でクライアントを立て、elicitation を `decline` したときに DB が変化しないことを確認する
- `pnpm run typecheck` と `pnpm test` が通ること
- 実機確認: MCP 経由で draft を作り、`approve_knowledge` で確認ダイアログが出ること、承認後に `search_knowledge` の既定検索でヒットすること

## 前提リスク

`@modelcontextprotocol/sdk` 1.30.0 が elicitation をサポートしているかは未確認である。実装の最初のステップで確認し、未対応であれば SDK 更新を検討する。`pnpm-workspace.yaml` の `minimumReleaseAge` 制約で更新できない場合は、elicitation を諦めて permission `ask` による確認(`~/.claude/settings.json` に3ツールを `ask` 指定)へ切り替える判断をユーザーに仰ぐ。

Claude Desktop の elicitation 対応状況も未確認である。未対応の場合、上記の流れ 1 により Desktop からは承認できない。これは意図した挙動として README に明記する。

## スコープ外

- MCP サーバの配布方式(単一ファイルへのバンドル、GitHub Releases 経由の複数マシン展開)。CLI が消えてから別途設計する
- 複数マシンでの DB 一元化。`DATABASE_URL` の差し替えで対応できる形を保つに留める
- 承認の Slack 通知・Web UI 化(Phase 2)
