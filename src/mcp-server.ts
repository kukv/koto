import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  addRelation,
  getKnowledge,
  listContexts,
  pendingReviews,
  propose,
  proposeUpdate,
  upsertContext,
} from "./knowledge.js";
import { hybridSearch } from "./search.js";

const server = new McpServer({ name: "koto", version: "0.1.0" });

const text = (v: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof v === "string" ? v : JSON.stringify(v, null, 2),
    },
  ],
});

const fail = (e: unknown) => text(`エラー: ${e instanceof Error ? e.message : String(e)}`);

const aliasSchema = z.object({
  name: z.string(),
  kind: z
    .enum(["synonym", "forbidden"])
    .describe("synonym=同義語 / forbidden=使ってはいけない表記"),
});

server.registerTool(
  "search_knowledge",
  {
    title: "業務知識の検索",
    description:
      "業務知識DBをハイブリッド検索(キーワード+ベクトル)する。要件定義・設計・実装・命名の前に必ず関連知識を検索すること。既定では承認済み(approved)のみ返す。結果には検証レベル(none/internal/expert)が含まれる。法令・税務など専門家確認が必要な領域でexpert未満の知識に依拠する場合、その成果物に不確かさの注記を引き継ぐこと。",
    inputSchema: {
      query: z.string().describe("検索クエリ(日本語可)"),
      context: z.string().optional().describe("コンテキスト(部署・領域)で絞り込み"),
      type: z.enum(["term", "rule", "decision", "requirement", "faq", "event"]).optional(),
      include_drafts: z.boolean().optional().describe("trueで未承認(draft)も検索対象に含める"),
      limit: z.number().int().min(1).max(30).optional(),
    },
  },
  async (args) => {
    try {
      return text(
        await hybridSearch(args.query, {
          context: args.context,
          type: args.type,
          includeDrafts: args.include_drafts,
          limit: args.limit,
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_knowledge",
  {
    title: "知識の詳細取得",
    description: "知識レコード1件の全文と、関連グラフ(関連用語・ルール)を1ホップ展開して取得する。",
    inputSchema: {
      id: z.string().uuid(),
      expand_relations: z.boolean().optional().describe("既定true"),
    },
  },
  async (args) => {
    try {
      const rec = await getKnowledge(args.id, args.expand_relations ?? true);
      return rec ? text(rec) : text(`見つかりません: ${args.id}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_contexts",
  {
    title: "コンテキスト一覧",
    description:
      "登録されているコンテキスト(部署・領域)の一覧。件数に加え、owner(承認責任者)とexpert(外部専門家の要否)を返す。どの領域の知識が存在し、誰が正しさを判定できるかの地図として最初に確認するとよい。",
    inputSchema: {},
  },
  async () => {
    try {
      return text(await listContexts());
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "upsert_context",
  {
    title: "コンテキスト情報の登録・更新",
    description:
      "コンテキスト(部署・領域)のマスタ情報を登録・更新する。「この領域の知識は誰が正しさを判定できるか」自体が組織のドメイン知識であり、ヒアリング等で判明したらここに記録する。owner=承認責任者(部署・ロール)、expert=外部専門家の確認が必要な領域ならその種別(税理士・弁護士等)。未指定の項目は既存値を保持する。",
    inputSchema: {
      name: z.string(),
      description: z.string().optional(),
      owner: z.string().optional().describe("承認責任者(部署・ロール)"),
      expert: z
        .string()
        .optional()
        .describe("外部専門家の確認が必要な場合その種別(税理士・弁護士等)"),
    },
  },
  async (args) => {
    try {
      return text(
        await upsertContext(args.name, {
          description: args.description,
          owner: args.owner,
          expert: args.expert,
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "propose_knowledge",
  {
    title: "新しい知識の提案",
    description:
      "会話や作業で新しく判明した用語・ルール・決定・業務イベント(コト)をdraftとして登録する。人の承認を経てapprovedになる。推測と事実を混ぜず、確認が必要な点はreview_notesに書くこと。近似重複は自動検出され結果に含まれる。eventは業務で起きる出来事(「受注確定」「在庫引当」など)を名詞化して登録する。",
    inputSchema: {
      type: z.enum(["term", "rule", "decision", "requirement", "faq", "event"]),
      context: z.string().describe("コンテキスト(部署・領域)"),
      title: z.string().describe("日本語名"),
      english_name: z.string().optional().describe("コード・テーブル・APIで使う正式英語名"),
      body: z
        .string()
        .describe(
          "定義・ルール・前提・背景 (Markdown)。type=event の場合は「## 概要 / ## アクター(誰が起こすか) / ## 対象(何に対して) / ## 事前条件 / ## 事後条件(何が成立するか) / ## 取消・失敗 / ## 順序・タイミング」の見出し構成で書く。不明な見出しは「要確認」と書く",
        ),
      aliases: z.array(aliasSchema).optional(),
      examples: z.array(z.string()).optional(),
      source: z
        .record(z.unknown())
        .optional()
        .describe('由来 例: {"kind":"hearing","ref":"営業部 田中さん 2026-08-07"}'),
      review_notes: z.string().optional().describe("要確認事項があれば記載"),
    },
  },
  async (args) => {
    try {
      const result = await propose({
        type: args.type,
        context: args.context,
        title: args.title,
        english_name: args.english_name,
        body: args.body,
        aliases: args.aliases,
        examples: args.examples,
        source: args.source,
        review_notes: args.review_notes,
      });
      return text({
        registered: result.id,
        status: "draft",
        duplicates: result.duplicates,
        note: result.duplicates.length
          ? "重複候補があります。統合すべきか人のレビューで判断されます。"
          : "レビュー待ちに追加されました。",
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "propose_update",
  {
    title: "既存知識の更新提案",
    description:
      "既存レコードの定義・ルール等の変更を提案する。変更前の内容は履歴に自動保存され、needs_reviewが立って人のレビュー対象になる。",
    inputSchema: {
      id: z.string().uuid(),
      title: z.string().optional(),
      english_name: z.string().optional(),
      body: z.string().optional(),
      aliases: z.array(aliasSchema).optional(),
      examples: z.array(z.string()).optional(),
      note: z.string().describe("なぜ変更するのかの説明(レビュー用)"),
    },
  },
  async (args) => {
    try {
      const { id, note, ...changes } = args;
      return text(await proposeUpdate(id, changes, note));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "add_relation",
  {
    title: "知識どうしの関連を登録",
    description:
      "知識レコード間の関連を登録する。概念マップ・業務フロー・状態遷移はこの関連から導出される。ラベル規約: モノ・用語間は意味を表すラベル(「含む」「引当」「同名別概念」など) / コト(event)間は「先行」(fromがtoより先に起きる)・「取消」(fromはtoを取り消す) / コト→モノは「対象」(fromイベントがtoを対象とする)。",
    inputSchema: {
      from_id: z.string().uuid(),
      to_id: z.string().uuid(),
      label: z.string(),
      cardinality: z.string().optional().describe("1, 1..*, * など"),
    },
  },
  async (args) => {
    try {
      return text(await addRelation(args.from_id, args.to_id, args.label, args.cardinality));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_pending_reviews",
  {
    title: "レビュー待ち一覧",
    description: "承認待ち(draft)・要確認(needs_review)の知識レコード一覧。",
    inputSchema: {},
  },
  async () => {
    try {
      return text(await pendingReviews());
    } catch (e) {
      return fail(e);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("knowledge-base MCP server running (stdio)");
