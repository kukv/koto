import { pool } from "./db.js";
import { getKnowledge, pendingReviews, setVerification } from "./knowledge.js";

const [cmd, id, arg3, arg4] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case "list": {
      const rows = await pendingReviews();
      if (rows.length === 0) {
        console.log("レビュー待ちはありません");
        break;
      }
      for (const r of rows) {
        const flag = r.needs_review ? ", 要確認" : "";
        console.log(
          `${r.id}  [${r.type}/${r.context}] ${r.title}  (${r.status}/${r.verification}${flag})`,
        );
      }
      console.log(`\n${rows.length}件。詳細: npm run review -- show <id>`);
      break;
    }
    case "show": {
      if (!id) throw new Error("idを指定してください");
      console.log(JSON.stringify(await getKnowledge(id), null, 2));
      break;
    }
    case "approve": {
      if (!id) throw new Error("idを指定してください");
      await pool.query(
        `update knowledge
            set status = 'approved', needs_review = false,
                verification = case when verification = 'expert' then 'expert' else 'internal' end,
                verified_by = coalesce($2, verified_by),
                verified_at = now()
          where id = $1`,
        [id, arg3 ?? null],
      );
      console.log(`approved (verification=internal): ${id}`);
      break;
    }
    case "verify": {
      if (!id || (arg3 !== "internal" && arg3 !== "expert")) {
        throw new Error("使い方: verify <id> <internal|expert> [確認者名]");
      }
      await setVerification(id, arg3, arg4);
      console.log(`verified (${arg3}): ${id}`);
      break;
    }
    case "reject": {
      if (!id) throw new Error("idを指定してください");
      await pool.query(
        `update knowledge
            set status = 'deprecated', needs_review = false,
                review_notes = coalesce(review_notes || E'\n', '') || 'レビューで却下'
          where id = $1`,
        [id],
      );
      console.log(`rejected(deprecated): ${id}`);
      break;
    }
    default:
      console.log(
        "使い方: npm run review -- <list | show <id> | approve <id> [確認者名] | verify <id> <internal|expert> [確認者名] | reject <id>>",
      );
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
