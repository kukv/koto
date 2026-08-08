export const EMBEDDING_DIM = 1536;

/**
 * テキストの埋め込みを生成する。
 * EMBEDDING_PROVIDER=none またはキー未設定なら null を返し、
 * 呼び出し側はキーワード検索のみにフォールバックする。
 */
export async function embed(text: string): Promise<number[] | null> {
  const provider = process.env.EMBEDDING_PROVIDER ?? "openai";
  const key = process.env.OPENAI_API_KEY;
  if (provider === "none" || !key) return null;

  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text.slice(0, 8000),
    }),
  });
  if (!res.ok) {
    console.error(`embedding API error: ${res.status} ${await res.text()}`);
    return null;
  }
  const data = (await res.json()) as { data: { embedding: number[] }[] };
  return data.data[0]?.embedding ?? null;
}

export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
