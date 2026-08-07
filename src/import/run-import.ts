import { readFile } from "node:fs/promises";
import path from "node:path";
import { pool } from "../db.js";
import { propose } from "../knowledge.js";
import { chunkDocument, extractCandidates } from "./extract.js";

const args = process.argv.slice(2);
let context = "general";
const files: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--context") {
    context = args[++i];
  } else {
    files.push(args[i]);
  }
}

if (files.length === 0) {
  console.error(
    "使い方: npm run import -- --context <コンテキスト名> <file.md> [file2.md ...]",
  );
  process.exit(1);
}

for (const file of files) {
  const doc = await readFile(file, "utf-8");
  console.error(`\n== ${file} (${doc.length}文字) ==`);
  const chunks = chunkDocument(doc);
  for (let i = 0; i < chunks.length; i++) {
    console.error(`  チャンク ${i + 1}/${chunks.length}: 抽出中...`);
    const candidates = await extractCandidates(chunks[i]);
    for (const c of candidates) {
      try {
        const { id, duplicates } = await propose({
          type: c.type,
          context,
          title: c.title,
          english_name: c.english_name,
          body: c.body,
          aliases: c.aliases,
          examples: c.examples,
          review_notes: c.uncertainties ? `要確認: ${c.uncertainties}` : undefined,
          source: { kind: "document", ref: path.resolve(file), chunk: i + 1 },
          created_by: "import",
        });
        const dup = duplicates.length ? ` (重複候補 ${duplicates.length}件)` : "";
        console.error(`    + [${c.type}] ${c.title} → draft ${id}${dup}`);
      } catch (e) {
        console.error(
          `    ! [${c.type}] ${c.title} 登録失敗: ${(e as Error).message}`,
        );
      }
    }
  }
}

await pool.end();
console.error("\n完了。`npm run review -- list` でレビューしてください。");
