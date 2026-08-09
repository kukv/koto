import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface ReviewTarget {
  id: string;
  type: string;
  context: string;
  title: string;
  body: string;
  status: string;
  review_notes: string | null;
  updated_at: string;
}

export type ApprovalOutcome = { ok: true; reviewer: string } | { ok: false; message: string };

/**
 * 人間の確認をクライアント経由で取り、確認者名を受け取る。
 * ダイアログを出せないクライアントでは実行を許可しない(エージェントの自己承認を防ぐため)。
 */
export async function requireHumanApproval(
  server: McpServer,
  message: string,
  target: ReviewTarget,
): Promise<ApprovalOutcome> {
  if (!server.server.getClientCapabilities()?.elicitation) {
    return {
      ok: false,
      message:
        "このクライアントは確認ダイアログ(elicitation)に対応していないため実行できません。承認・却下には人間の確認が必要です。",
    };
  }

  const excerpt = target.body.length > 300 ? `${target.body.slice(0, 300)}…` : target.body;
  const notesExcerpt = target.review_notes
    ? target.review_notes.length > 200
      ? `${target.review_notes.slice(0, 200)}…`
      : target.review_notes
    : null;
  const result = await server.server.elicitInput(
    {
      message: `${message}\n\n[${target.type}/${target.context}] ${target.title} (status: ${target.status})\n\n${excerpt}${notesExcerpt ? `\n\n備考: ${notesExcerpt}` : ""}`,
      requestedSchema: {
        type: "object",
        properties: {
          reviewer: {
            type: "string",
            title: "確認者名",
            description: "この判断をした人の名前(記録に残ります)",
            default: process.env.KOTO_REVIEWER ?? "",
          },
        },
        required: ["reviewer"],
      },
    },
    { timeout: 10 * 60 * 1000 },
  );

  if (result.action !== "accept") {
    return {
      ok: false,
      message: `ユーザーが承認しませんでした(${result.action})。何も変更していません。`,
    };
  }

  const reviewer =
    typeof result.content?.reviewer === "string" ? result.content.reviewer.trim() : "";
  if (!reviewer) {
    return { ok: false, message: "確認者名が入力されなかったため実行しませんでした。" };
  }
  return { ok: true, reviewer };
}
