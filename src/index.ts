/** balaur-memory — public surface. The durable contract is docs/SCHEMA.md. */

export type {
  Conflict,
  Decision,
  EditChange,
  EditEnvelope,
  Outcome,
  Pending,
  Proposal,
} from "./consent.ts";
export type {
  DoctorReport,
  RankingConfig,
  RecallOptions,
  StoreContract,
} from "./contract.ts";
export type { EntityContext, IdentityEvidence, Peer } from "./entities.ts";
export type { ForgetReport } from "./lifecycle.ts";
export { DEFAULT_RANKING, termsFromText } from "./recall.ts";
export type { HistorySnapshot, Validity } from "./spine.ts";
export { SCHEMA_VERSION } from "./storage/schema.ts";
export { ulid } from "./storage/ulid.ts";
export { Store, type StoreOptions } from "./store.ts";
export type {
  AuditEntry,
  Edge,
  EdgeId,
  Node,
  NodeId,
  NodeTypeSpec,
  Props,
  Status,
  Surfacing,
} from "./types.ts";
export { MemoryError, normalizeText, SYSTEM_EDGE_TYPES } from "./types.ts";
