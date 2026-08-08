export { pool } from "./db.js";
export { EMBEDDING_DIM, embed, toVectorLiteral } from "./embeddings.js";
export {
  type Alias,
  type KnowledgeType,
  type ProposeInput,
  addRelation,
  findDuplicates,
  getKnowledge,
  listContexts,
  pendingReviews,
  propose,
  proposeUpdate,
  setVerification,
  upsertContext,
} from "./knowledge.js";
export { type SearchOptions, hybridSearch } from "./search.js";
