export { pool } from "./db.js";
export { EMBEDDING_DIM, embed, toVectorLiteral } from "./embeddings.js";
export {
  type Alias,
  addRelation,
  findDuplicates,
  getKnowledge,
  type KnowledgeType,
  listContexts,
  type ProposeInput,
  pendingReviews,
  propose,
  proposeUpdate,
  setVerification,
  upsertContext,
} from "./knowledge.js";
export { hybridSearch, type SearchOptions } from "./search.js";
