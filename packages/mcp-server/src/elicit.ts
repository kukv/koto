import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface ReviewTarget {
  id: string;
  type: string;
  context: string;
  title: string;
  body: string;
  status: string;
  /**
   * コンテキストの承認責任者。null なら誰がこの知識を判定できるかが未定義であることを警告する。
   * 設定されていれば、その責任者名をダイアログに表示する。
   */
  context_owner: string | null;
  review_notes: string | null;
  /** 同じ english_name を持つ他レコード。統合すべきか別概念かを人に判断させるために出す */
  english_name_conflicts: { context: string; type: string; title: string; status: string }[];
  updated_at: string;
}

export type ApprovalOutcome = { ok: true; reviewer: string } | { ok: false; message: string };

/** ダイアログに追加で載せる根拠(承認根拠・検証根拠)。ラベルは呼び出し側が決める */
export interface ApprovalNote {
  label: string;
  text: string;
}

/**
 * 確認者の候補(環境変数 KOTO_REVIEWER のカンマ区切り)。
 * 自由入力ではなく候補からの選択にすることで、ダイアログを矢印キーで操作できる。
 */
function reviewerCandidates(): string[] {
  return (process.env.KOTO_REVIEWER ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 長い文字列をダイアログに載せる長さに切り詰める(超えていたら末尾に … を付ける) */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 人間の確認をクライアント経由で取り、確認者名を受け取る。
 * ダイアログを出せないクライアントでは実行を許可しない(エージェントの自己承認を防ぐため)。
 *
 * note を渡す場合、エージェントが書いた自由文だからこそレコード情報(本文・備考)より
 * 後ろに置く。ID 取り違えの最終防波堤であるレコード情報が note に押し出されないため。
 */
export async function requireHumanApproval(
  server: McpServer,
  message: string,
  target: ReviewTarget,
  note?: ApprovalNote,
): Promise<ApprovalOutcome> {
  if (!server.server.getClientCapabilities()?.elicitation) {
    return {
      ok: false,
      message:
        "このクライアントは確認ダイアログ(elicitation)に対応していないため実行できません。承認・却下には人間の確認が必要です。",
    };
  }

  const candidates = reviewerCandidates();
  if (candidates.length === 0) {
    return {
      ok: false,
      message:
        "確認者の候補が設定されていないため実行できません。MCP サーバの環境変数 KOTO_REVIEWER に確認者名を設定してください(カンマ区切りで複数指定できます)。",
    };
  }

  const excerpt = truncate(target.body, 300);
  const notesExcerpt = target.review_notes ? truncate(target.review_notes, 200) : null;
  const noteExcerpt = note ? truncate(note.text, 300) : null;
  // 承認責任者の表示はレコード行の直後に置く。レコード情報は ID 取り違えの最終防波堤なので下に押し下げない
  const ownerLine = target.context_owner
    ? `\n承認責任者: ${target.context_owner}`
    : "\n⚠ この領域には承認責任者(owner)が未設定です";
  // 衝突はレコード情報の直後に置く。統合の要否は本文を読んだ流れで判断されるため
  const conflicts = target.english_name_conflicts.length
    ? `\n\n同じ english_name の既存レコード: ${target.english_name_conflicts
        .map((c) => `[${c.type}/${c.context}] ${c.title} (${c.status})`)
        .join(" / ")}`
    : "";
  const result = await server.server.elicitInput(
    {
      message: `${message}\n\n[${target.type}/${target.context}] ${target.title} (status: ${target.status})${ownerLine}\n\n${excerpt}${conflicts}${notesExcerpt ? `\n\n備考: ${notesExcerpt}` : ""}${noteExcerpt ? `\n\n${note ? note.label : ""}: ${noteExcerpt}` : ""}`,
      requestedSchema: {
        type: "object",
        properties: {
          reviewer: {
            type: "string",
            title: "確認者",
            description: "この判断をした人(記録に残ります)",
            enum: candidates,
            default: candidates[0],
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

  // SDK も requestedSchema の enum で検証するが、それに依存せずサーバ側でも候補と照合する
  const reviewer =
    typeof result.content?.reviewer === "string" ? result.content.reviewer.trim() : "";
  if (!candidates.includes(reviewer)) {
    return {
      ok: false,
      message: `候補にない確認者が返されたため実行しませんでした: ${reviewer || "(空)"}`,
    };
  }
  return { ok: true, reviewer };
}
