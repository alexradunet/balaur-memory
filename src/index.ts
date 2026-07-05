/** balaur-memory — public surface. The durable contract is docs/SCHEMA.md. */

export type {
  Conflict,
  Decision,
  EditEnvelope,
  Outcome,
  Pending,
  Proposal,
} from "./consent.ts";
export type {
  DoctorReport,
  ForgetReport,
  RankingConfig,
  RecallOptions,
  StoreContract,
} from "./contract.ts";
export { DEFAULT_RANKING, termsFromText } from "./recall.ts";
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
export { MemoryError, SYSTEM_EDGE_TYPES } from "./types.ts";
