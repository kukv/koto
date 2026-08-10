import {
  addRelation,
  approve,
  findEnglishNameConflicts,
  getKnowledge,
  hybridSearch,
  listContexts,
  pendingReviews,
  propose,
  proposeUpdate,
  reject,
  setVerification,
  upsertContext,
} from "@kukv/koto-core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type ReviewTarget, requireHumanApproval } from "./elicit.js";
import { validateEnglishName } from "./english-name.js";

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

/** 確認ダイアログに出す最小情報を取り出す(見つからなければ null) */
async function reviewTarget(id: string): Promise<ReviewTarget | null> {
  const rec = await getKnowledge(id, false);
  if (!rec) return null;
  const updatedAt =
    rec.updated_at instanceof Date ? rec.updated_at.toISOString() : String(rec.updated_at);
  return {
    id,
    type: String(rec.type),
    context: String(rec.context),
    title: String(rec.title),
    body: String(rec.body),
    status: String(rec.status),
    review_notes: rec.review_notes == null ? null : String(rec.review_notes),
    english_name_conflicts: await findEnglishNameConflicts(id),
    updated_at: updatedAt,
  };
}

export function createKotoServer(): McpServer {
  const server = new McpServer({ name: "koto", version: "0.1.0" });

  server.registerTool(
    "search_knowledge",
    {
      title: "業務知識の検索",
      description:
        "業務知識DBをハイブリッド検索(キーワード+ベクトル)する。クエリは単語・キーワードを空白区切りで指定すること(複数語はAND条件)。自然文の文章は語に分割されないためヒットしない。要件定義・設計・実装・命名の前に必ず関連知識を検索すること。既定では承認済み(approved)のみ返す。結果には検証レベル(none/internal/expert)が含まれる。法令・税務など専門家確認が必要な領域でexpert未満の知識に依拠する場合、その成果物に不確かさの注記を引き継ぐこと。",
      inputSchema: {
        query: z.string().describe("検索クエリ。単語を空白区切りで(例:「世帯 招待」)。文章は不可"),
        context: z.string().optional().describe("コンテキスト(部署・領域)で絞り込み"),
        type: z.enum(["term", "rule", "decision", "requirement", "faq", "event"]).optional(),
        include_drafts: z.boolean().optional().describe("trueで未承認(draft)も検索対象に含める"),
        limit: z.number().int().min(1).max(30).optional(),
      },
    },
    async (args) => {
      try {
        const rows = await hybridSearch(args.query, {
          context: args.context,
          type: args.type,
          includeDrafts: args.include_drafts,
          limit: args.limit,
        });
        // 空配列だけ返すとエージェントが「関連知識なし」と誤って報告するため、直し方を添える
        if (rows.length === 0) {
          return text(
            "該当なし。クエリが文章の場合は単語に分けて再検索してください(「世帯に招待で参加する」→「世帯 招待」)。複数語はAND条件なので、広く探すときは語を減らします。",
          );
        }
        return text(rows);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_knowledge",
    {
      title: "知識の詳細取得",
      description:
        "知識レコード1件の全文と、関連グラフ(関連用語・ルール)を1ホップ展開して取得する。",
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
          .record(z.string(), z.unknown())
          .optional()
          .describe('由来 例: {"kind":"hearing","ref":"営業部 田中さん 2026-08-07"}'),
        review_notes: z.string().optional().describe("要確認事項があれば記載"),
      },
    },
    async (args) => {
      try {
        const invalid = validateEnglishName(args.type, args.english_name);
        if (invalid) return text(`エラー: ${invalid}`);
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
        // english_name の要否は type で決まるため、更新でも対象レコードの type を見て検証する
        if (changes.english_name !== undefined) {
          const rec = await getKnowledge(id, false);
          if (!rec) return text(`知識レコードが見つかりません: ${id}`);
          const invalid = validateEnglishName(String(rec.type), changes.english_name);
          if (invalid) return text(`エラー: ${invalid}`);
        }
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
      description:
        "承認待ち(draft)・要確認(needs_review)の知識レコード一覧。total は絞り込み後の全件数で、items の件数より多い場合は残りが打ち切られている — そのときは「これで全部」と報告せず、context や type で絞るか limit を上げて残りを確認すること。review_notes は200字で切り詰められ、切れている場合は末尾に「…」が付く。全文は get_knowledge で取れる。",
      inputSchema: {
        context: z.string().optional().describe("コンテキスト(部署・領域)で絞る"),
        type: z
          .enum(["term", "rule", "decision", "requirement", "faq", "event"])
          .optional()
          .describe("種別で絞る"),
        limit: z.number().int().positive().optional().describe("返す最大件数(既定100)"),
      },
    },
    async (args) => {
      try {
        return text(await pendingReviews(args));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "approve_knowledge",
    {
      title: "知識の承認",
      description:
        "レビュー待ちの知識を承認し、検索の既定対象にする。承認すると未解決の確認事項(review_notes)はクリアされ、代わりに note が承認根拠として残る。note には何を読んで裏を取ったかを具体的に書くこと(この記録自体が後から参照される知識になる)。実行するとユーザーに確認ダイアログが出る。ユーザーが承認しなければ何も変更されない。承認するかどうかの判断は必ずユーザーに委ねること。",
      inputSchema: {
        id: z.string().uuid(),
        note: z
          .string()
          .min(1)
          .describe("承認根拠。何を読んで裏を取ったかを具体的に書く。記録に残る"),
      },
    },
    async ({ id, note }) => {
      try {
        const target = await reviewTarget(id);
        if (!target) return text(`知識レコードが見つかりません: ${id}`);
        if (target.status === "deprecated") {
          return text(`却下済み(deprecated)の知識です。対象になりません: ${id}`);
        }
        const outcome = await requireHumanApproval(server, "この知識を承認しますか?", target, {
          label: "承認根拠",
          text: note,
        });
        if (!outcome.ok) return text(outcome.message);
        return text(await approve(id, outcome.reviewer, note, target.updated_at));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "reject_knowledge",
    {
      title: "知識の却下",
      description:
        "レビューで却下する。物理削除はせず deprecated にし、却下理由を記録として残す。実行するとユーザーに確認ダイアログが出る。reason には「なぜ誤りなのか」を具体的に書くこと(この理由自体が後から参照される知識になる)。",
      inputSchema: {
        id: z.string().uuid(),
        reason: z.string().describe("却下する理由。記録に残る"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ id, reason }) => {
      try {
        const target = await reviewTarget(id);
        if (!target) return text(`知識レコードが見つかりません: ${id}`);
        if (target.status === "deprecated") {
          return text(`却下済み(deprecated)の知識です。対象になりません: ${id}`);
        }
        const outcome = await requireHumanApproval(
          server,
          `この知識を却下しますか?\n却下理由: ${reason}`,
          target,
        );
        if (!outcome.ok) return text(outcome.message);
        return text(await reject(id, reason, outcome.reviewer, target.updated_at));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "verify_knowledge",
    {
      title: "検証レベルの設定",
      description:
        "知識の検証レベルを設定する。internal=社内で確認済 / expert=外部専門家(税理士・弁護士等)が確認済。承認(status)とは別軸で、内容をどこまで信用してよいかを表す。expert は実際に専門家の確認を得た場合にのみ使うこと。note には誰に何を確認したかを具体的に書くこと(記録に残る)。設定すると未解決の確認事項(review_notes)はクリアされ、代わりに note が検証根拠として残る。実行するとユーザーに確認ダイアログが出る。",
      inputSchema: {
        id: z.string().uuid(),
        level: z.enum(["internal", "expert"]),
        note: z.string().min(1).describe("検証根拠。誰に何を確認したかを具体的に書く。記録に残る"),
      },
    },
    async ({ id, level, note }) => {
      try {
        const target = await reviewTarget(id);
        if (!target) return text(`知識レコードが見つかりません: ${id}`);
        if (target.status === "deprecated") {
          return text(`却下済み(deprecated)の知識です。対象になりません: ${id}`);
        }
        const outcome = await requireHumanApproval(
          server,
          `この知識の検証レベルを ${level} にしますか?`,
          target,
          { label: "検証根拠", text: note },
        );
        if (!outcome.ok) return text(outcome.message);
        return text(await setVerification(id, level, outcome.reviewer, note, target.updated_at));
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}
