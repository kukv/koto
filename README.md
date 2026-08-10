# Koto

業務知識基盤 — ユビキタス言語(言)と業務イベント(事)を蓄積・還流する知識リポジトリ

業務知識(ユビキタス言語・ルール・設計判断)を中央DBに蓄積し、MCP経由でAIエージェントに参照・還流させるための雛形(Phase 1: ローカル実験)。

構成: Postgres + PGroonga(日本語全文検索) + pgvector(埋め込み) / TypeScript製MCPサーバ

```
compose.yaml                   DB(PGroonga + pgvector)+ 日次バックアップ
docker/db/init/001_schema.sql  スキーマ(knowledge / relations / revisions)
packages/core/          共有ドメイン層(propose・検索)
packages/mcp-server/    MCPサーバ(11ツール)
packages/tsconfig/      共有tsconfig
```

## セットアップ

```bash
docker compose up -d --build     # DB起動(初回はスキーマ自動適用)
pnpm install
pnpm build                       # 全パッケージをビルド(mcp の実行前に必須)
cp .env.example .env             # キーを記入
```

DBは日次で `./backups/` に pg_dump(カスタム形式、14日分保持)されます。復元は:

```bash
docker compose exec -T db pg_restore -U koto -d koto --clean < backups/<ファイル名>.dump
```

**初期構成は API キーゼロで動きます。** DB(docker)さえ起動していれば、インポート(エージェント対話)・検索・レビューのすべてに課金や API キーは不要です。以下はすべてオプトイン:

- `EMBEDDING_PROVIDER=openai` + `OPENAI_API_KEY` — 埋め込み生成(text-embedding-3-small)を有効化。ベクトル検索と近似重複検出が加わる。未設定(デフォルト)ではキーワード検索(PGroonga)のみで動作

旧版のスキーマで初期化済みのDBには、マイグレーションを番号順に適用:

```bash
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U koto -d koto < docker/db/migrations/002_add_event_type.sql
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U koto -d koto < docker/db/migrations/003_contexts_verification.sql
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U koto -d koto < docker/db/migrations/004_search_text_alias_names.sql
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U koto -d koto < docker/db/migrations/005_verified_note.sql
```

## MCPサーバの接続

### 利用のみ(推奨)

Release からバンドル済みの単一ファイルを取得します。clone も `pnpm build` も不要です(`gh` の認証で private リポジトリからも取得できます)。Node 24 以上が必要です(バンドルは `--target=node24`)。

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

`KOTO_REVIEWER` は承認ダイアログに出す**確認者の候補**です。カンマ区切りで複数指定でき(`KOTO_REVIEWER=野中,田中`)、ダイアログではこの中から選びます。**未設定だと承認・却下・検証レベルの設定ができません**(誰が判断したかを記録できないため)。

### 命名警告フック(任意)

`forbidden` に登録した表記をコードに書いたとき、エージェントに指摘を返します。`~/.claude/settings.json` に次を足してください(`DATABASE_URL` は MCP 登録と同じ値)。

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "DATABASE_URL=postgres://koto:koto@localhost:5432/koto node ~/.koto/koto-mcp.mjs check-naming"
          }
        ]
      }
    ]
  }
}
```

書き込んだ内容だけを見ます(ファイル全体は読みません)。DB に繋がらないときは何もしません — 知識基盤の警告で編集作業が止まらないようにするためです。1 文字の禁止表記は誤検知が多いため対象外です。

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

### リリース(メンテナ向け)

`v*` タグを push すると CI がバンドルして Release に添付します。

```bash
git tag -m "リリースの内容" v0.1.1
git push origin v0.1.1
```

タグにメッセージを付けているのは、`tag.gpgSign` を有効にしている環境では軽量タグが作れず `fatal: no tag message?` になるためです。

同名タグの Release が既にあると `gh release create` は失敗します。打ち直す場合は `gh release delete v0.1.1 --yes --cleanup-tag` で Release とタグを削除してからやり直してください。

ツール一覧: `search_knowledge` / `get_knowledge` / `list_contexts` / `upsert_context` / `propose_knowledge` / `propose_update` / `add_relation` / `get_pending_reviews` / `approve_knowledge` / `verify_knowledge` / `reject_knowledge`

## スキルの登録(他リポジトリから使う場合)

文書インポートの抽出規約はスキル `skills/koto-import/` にあります。本リポジトリ内で作業するときは `.claude/skills/` のシンボリックリンクで自動的に読み込まれますが、他のリポジトリでの作業から使う場合は、clone した本リポジトリをユーザースキルとしてリンクします:

```bash
mkdir -p ~/.claude/skills
ln -s /絶対パス/koto/skills/koto-import ~/.claude/skills/koto-import
```

スキルの更新は clone 側で `git pull` するだけで反映されます(リンクの張り直しは不要)。

## 運用の流れ

**導線1: 文書からの初期投入(エージェント対話)**

koto MCP を接続した Claude Code / Claude Desktop に文書を渡して頼みます:

> この docs/仕様書.md を koto に取り込んで。context は sales で

抽出はエージェント自身が行うため、koto 側で LLM API を呼ぶことはありません(課金ゼロ)。抽出の型(コト起点・event の定型見出し・推測の分離など)はリポジトリ同梱のスキル `skills/koto-import/` が与えます(Claude Code へは `.claude/skills/` のシンボリックリンク経由で読み込まれます)。候補はすべて `draft` + `needs_review` で入ります。文書に書いてあったというだけでは承認されません(社内文書は古い・間違っている前提)。読み取れなかった点は `review_notes` に「要確認」として残り、近似重複(同名・別名一致、埋め込み類似)も自動検出されます。

**導線2: ヒアリング**

文書から作った仮説の辞書を持って部署ヒアリングを実施します。エージェントとの対話で策定する場合(ubiquitous-languageスキルのモードB)は、スキルの最終ステップ「Markdown出力」を `propose_knowledge` 呼び出しに差し替えてください。以降、対話で確定した用語が自動でdraft投入されます。

ヒアリングはコト起点(軽量イベントストーミング)で進めるのが効果的です。「一日の業務で何が起きるか」を時系列で語ってもらい、出てきた出来事をeventとして登録しながら、「その『受注』とは何ですか?」とヒト・モノ(用語)を逆引きしていきます。エージェントの定型の問い:「その前には何が起きますか」「それは失敗・取消できますか」「誰がそれをやりますか」。

**レビュー(承認ゲート)**

レビューはエージェントとの対話で行います。

> レビュー待ちを見せて → (内容を確認・修正) → これを承認して

一覧(`get_pending_reviews`)は既定で100件までしか返しません。返り値の `total` が `items` の件数より多いときは残りが打ち切られているので、コンテキストや種別で絞って進めてください(「household の event だけ見せて」)。

承認・却下・検証レベルの設定は MCP ツール(`approve_knowledge` / `reject_knowledge` / `verify_knowledge`)から行いますが、**実行するとサーバが確認ダイアログを出し、ユーザー自身が確認者を選んで承認するまで DB は変更されません**。エージェントが勝手に承認することはできません。確認者の候補は環境変数 `KOTO_REVIEWER` で設定します(未設定だと実行できません)。承認・検証では根拠(何を読んで裏を取ったか)の記載が必須で、確認ダイアログに表示されたうえで記録に残ります。

この確認ダイアログは MCP の elicitation を使っています。elicitation に対応していないクライアントからは、承認・却下・検証レベルの設定は実行できません。お使いのクライアントが対応しているかは各自ご確認ください。

承認済み(approved)だけが検索のデフォルト対象です。検証レベルは3段階(none=未検証 / internal=社内確認済 / expert=専門家確認済)で、レコードの内容が更新されると自動でnoneに戻ります(専門家確認は旧版に対するものだから)。却下は物理削除せず deprecated にし、却下理由を記録に残します。

## 設計メモ

- **1概念 = 1レコード。** チャンク分割はしない。検索はキーワード(PGroonga)+ベクトルのRRF統合。
- **検索クエリは単語で。** PGroonga は本文をbigramで索引するため、文章をそのまま投げると全bigramのAND条件になり事実上ヒットしない(「世帯に招待で参加する」→0件 / 「世帯 招待」→ヒット)。意味で引きたい場合はベクトル検索(`EMBEDDING_PROVIDER=openai`)を有効にする。
- **多義語**は `(context, type, title)` 複合ユニークで、コンテキスト違いの別レコードとして共存。
- **履歴**は更新トリガで `knowledge_revisions` に自動保存。deprecatedは削除せず残す。
- **概念マップ**は `knowledge_relations` から都度導出する(手書き保守しない)。
- **コト(event)中心。** 業務イベントは `type='event'`。本文は「概要 / アクター / 対象 / 事前条件 / 事後条件 / 取消・失敗 / 順序・タイミング」の定型見出しで書く。
- **関連ラベル規約**: モノ・用語間=意味ラベル(「含む」「引当」「同名別概念」等) / コト間=「先行」「取消」 / コト→モノ=「対象」。業務プロセスフローと状態遷移図はこの関連から導出する。
- **注意**: コト中心の知識化と、イベントソーシングという実装方式は別物。設計導出時に安易にイベントソーシングを提案しないこと(この方針自体をdecisionとして登録しておくとよい)。
- **判定権限の分散をデータ化。** 置き場所は中央DBに統一するが、正しさを判定できる人は知識ごとに違う。コンテキストはマスタ(`contexts`)で owner=承認責任者、expert=外部専門家(税理士・弁護士等)を持つ。未知のコンテキストはpropose時に自動登録され、owner未設定として可視化される。Phase 2のレビュー通知(Slack等)のルーティングはこのマスタを根拠にする。
- **不確かさの伝搬。** 検索結果には検証レベルが含まれる。専門家確認が必要な領域でexpert未満の知識に依拠した成果物(要件定義書・設計・実装)には、その旨の注記を引き継ぐ。調査由来(`source.kind="research"`)の知識には出典URLと確認日を必須とし、棚卸しの重点対象にする。
- **実験中の仮決め**: 承認者はあなた1人・外部API利用OK。チーム共有時に、承認フローのUI化・自動承認の範囲・埋め込みモデルの再選定を行う。

## Phase 2 への道筋

DBをSupabase/RDS等へ移し、MCPサーバをリモート(HTTP + OAuth)にすれば、エージェント側の設定変更は接続先の差し替えのみ。承認フローはSlack通知や簡単なWeb UIに置き換える。

## 設計の経緯

設計セッションの記録は [docs/業務知識基盤_設計記録.md](docs/業務知識基盤_設計記録.md) を参照。
