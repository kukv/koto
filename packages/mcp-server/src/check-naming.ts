import { type ForbiddenAlias, forbiddenAliases } from "@kukv/koto-core";

/** DB が固まっても編集作業を止めないための上限 */
const DB_TIMEOUT_MS = 3000;

/**
 * PostToolUse の入力から、今回書き込まれたテキストだけを取り出す。
 * ファイル全体を見ないのは、既存コードの禁止表記まで指摘すると
 * 無関係な編集のたびにノイズが出るため。
 */
export function writtenText(hookInput: unknown): string | null {
  const input = hookInput as { tool_name?: string; tool_input?: Record<string, unknown> } | null;
  const toolInput = input?.tool_input;
  if (!toolInput) return null;
  const value =
    input?.tool_name === "Write"
      ? toolInput.content
      : input?.tool_name === "Edit"
        ? toolInput.new_string
        : null;
  return typeof value === "string" ? value : null;
}

export function findForbiddenHits(text: string, forbidden: ForbiddenAlias[]): ForbiddenAlias[] {
  return forbidden.filter((f) => text.includes(f.name));
}

export function formatWarning(hits: ForbiddenAlias[]): string {
  const lines = hits.map(
    (h) => `- 「${h.name}」は禁止表記です。正しくは「${h.title}」(${h.context})`,
  );
  return `koto: 書き込んだ内容に使ってはいけない表記が含まれています。\n${lines.join("\n")}`;
}

/**
 * フック本体。終了コード 2 で stderr の内容がエージェントに返る(PostToolUse なので阻止ではなく指摘)。
 * 知識基盤の警告が作業を止めるのは本末転倒なので、失敗はすべて握りつぶして 0 を返す。
 */
export async function checkNaming(raw: string): Promise<0 | 2> {
  try {
    const text = writtenText(JSON.parse(raw));
    if (!text) return 0;
    const forbidden = await Promise.race([
      forbiddenAliases(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), DB_TIMEOUT_MS).unref()),
    ]);
    if (!forbidden) return 0;
    const hits = findForbiddenHits(text, forbidden);
    if (hits.length === 0) return 0;
    console.error(formatWarning(hits));
    return 2;
  } catch {
    return 0;
  }
}
