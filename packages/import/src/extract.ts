import { isCliAvailable, runClaudeCli } from "./cli.js";

export interface ExtractedCandidate {
  type: "term" | "rule" | "event" | "faq";
  title: string;
  english_name?: string;
  body: string;
  aliases?: { name: string; kind: "synonym" | "forbidden" }[];
  examples?: string[];
  uncertainties?: string;
}

const SYSTEM = `あなたは業務システムのドメイン知識を抽出する専門家です。
渡された社内文書から、用語(term)・業務ルール(rule)・業務イベント/コト(event)・FAQ(faq)の候補を抽出します。
業務の本体はコト(いつ・誰が・何に対して・何をしたか)にあります。文書に業務の流れ・手順・状態変化が書かれていたら、必ず出来事を名詞化してeventとして抽出してください(例:「受注確定」「在庫引当」)。

出力は必ずJSON配列のみ。コードフェンスや前置き・後書きは一切付けないこと。
各要素の形式:
{
  "type": "term" | "rule" | "event" | "faq",
  "title": "日本語名",
  "english_name": "コードで使う英語名(文書に根拠がなければ省略)",
  "body": "定義・ルール・前提・背景をMarkdownで",
  "aliases": [{"name": "別名や表記揺れ", "kind": "synonym"}],
  "examples": ["具体例"],
  "uncertainties": "文書から読み取れず、ドメインエキスパートへの確認が必要な点"
}

厳守事項:
- 文書に書かれた事実と推測を混ぜない。推測や補完はuncertaintiesに書く。
- 一般的なIT用語・ありふれた言葉は抽出しない。この業務に固有の概念だけを抽出する。
- 同じ言葉が文脈により別物を指す兆候(多義語)があれば、uncertaintiesに必ず記載する。
- eventのbodyは次の見出し構成で書く: ## 概要 / ## アクター(誰が起こすか) / ## 対象(何に対して) / ## 事前条件 / ## 事後条件(何が成立するか) / ## 取消・失敗 / ## 順序・タイミング。文書から読み取れない見出しは本文に「要確認」と書き、uncertaintiesにも記載する。`;

export async function extractCandidates(docText: string): Promise<ExtractedCandidate[]> {
  const provider = process.env.EXTRACT_PROVIDER;
  if (provider === "api") return extractViaApi(docText);
  if (provider === "cli") return extractViaCli(docText);
  if (await isCliAvailable()) return extractViaCli(docText);
  if (process.env.ANTHROPIC_API_KEY) return extractViaApi(docText);
  throw new Error(
    "抽出に使える Claude が見つかりません。Claude Code (claude) をインストールしてログインするか、ANTHROPIC_API_KEY を設定してください",
  );
}

/** Claude Code CLI(サブスクリプション認証)経由で抽出する */
async function extractViaCli(docText: string): Promise<ExtractedCandidate[]> {
  const stdout = await runClaudeCli(
    `${SYSTEM}\n\n以下の文書から知識候補を抽出してください。\n\n${docText}`,
    process.env.EXTRACT_MODEL,
  );
  let result: { is_error?: boolean; result?: string };
  try {
    result = JSON.parse(stdout) as { is_error?: boolean; result?: string };
  } catch {
    throw new Error(`claude CLI の応答を解釈できません:\n${stdout.slice(0, 500)}`);
  }
  if (result.is_error || typeof result.result !== "string") {
    throw new Error(`claude CLI が失敗しました: ${result.result ?? stdout.slice(0, 500)}`);
  }
  return parseCandidates(result.result);
}

/** Anthropic API(従量課金)経由で抽出する */
async function extractViaApi(docText: string): Promise<ExtractedCandidate[]> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY を設定してください");
  const model = process.env.EXTRACT_MODEL ?? "claude-sonnet-4-6";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `以下の文書から知識候補を抽出してください。\n\n${docText}`,
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    content: { type: string; text?: string }[];
  };
  const raw = data.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  return parseCandidates(raw);
}

/** モデル応答テキスト(コードフェンス許容)を候補配列としてパースする */
function parseCandidates(raw: string): ExtractedCandidate[] {
  const clean = raw.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(clean) as ExtractedCandidate[];
  } catch {
    throw new Error(`抽出結果のJSONパースに失敗:\n${clean.slice(0, 500)}`);
  }
}

/** 長い文書を見出し境界でおおまかに分割する */
export function chunkDocument(text: string, maxChars = 12000): string[] {
  if (text.length <= maxChars) return [text];
  const sections = text.split(/(?=^##? )/m);
  const chunks: string[] = [];
  let cur = "";
  for (const s of sections) {
    if (cur.length + s.length > maxChars && cur) {
      chunks.push(cur);
      cur = "";
    }
    cur += s;
  }
  if (cur) chunks.push(cur);
  return chunks;
}
