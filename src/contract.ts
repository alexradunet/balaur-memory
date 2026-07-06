/**
 * The Store contract — the reviewable shape of the library, held by the
 * compiler: `class Store implements StoreContract` (store.ts), so this
 * surface and the shipped one can never drift.
 *
 * Everything is SYNCHRONOUS (DESIGN.md): bun:sqlite is sync, personal scale
 * is sub-millisecond, and the one truly async concern — embedding text —
 * lives in hosts. Vectors in, never models.
 */

import type { Conflict, Decision, Outcome, Pending, Proposal } from "./consent.ts";
import type { EntityContext } from "./entities.ts";
import type { ForgetReport } from "./lifecycle.ts";
import type { Validity } from "./spine.ts";
import type { Edge, EdgeId, Node, NodeId, NodeTypeSpec, Props, Status, Surfacing } from "./types.ts";

/** Tunables for the recall ranking blend; conformance pins the defaults. */
export interface RankingConfig {
  readonly lambda: number; // recency decay per day (importance-dampened)
  readonly reinforcement: number; // use_count weight (default 0.2)
  readonly rrfK: number; // reciprocal-rank fusion constant (default 60)
}

export interface RecallOptions {
  readonly type?: string; // restrict to one node type (e.g. "memory")
  readonly limit?: number; // default 8
  /** Host-embedded query vector: enables cosine fusion over putVector data. */
  readonly queryVector?: Float32Array;
  /** Vector-space identity; required with queryVector. */
  readonly model?: string;
}

/** Metadata-only health snapshot — candidates, never actions. */
export interface DoctorReport {
  readonly activeCount: number;
  readonly pendingCount: number;
  readonly acceptRate30d: number | null; // null: no decisions in window
  readonly deadWeightCandidates: readonly NodeId[]; // dormant ≠ dead — review only
  readonly staleCandidates: readonly NodeId[];
  readonly duplicateCandidates: ReadonlyArray<readonly [NodeId, NodeId]>;
  readonly queueOldestDays: number | null;
}

/** The draft contract. Phase 1 ships `class Store implements StoreContract`. */
export interface StoreContract {
  // --- the spine ---

  /** Register or update a node type (I1: bornStatus is the consent split). */
  registerType(spec: NodeTypeSpec): void;
  /** Owner-authored write — born active, provenance mandatory (I10). */
  createNode(input: {
    type: string;
    title: string;
    body?: string;
    props?: Props;
    importance?: number;
    surfacing?: Surfacing;
    origin: string;
    author?: string;
  }): Node;
  /** Fetch by id regardless of status — hosts gate display. */
  getNode(id: NodeId): Node;
  /** Edit an ACTIVE owner-authored node in place. */
  updateNode(id: NodeId, patch: { title?: string; body?: string; props?: Props }): Node;
  /** Idempotent on (source, target, type). */
  /** Idempotent on (source, target, type). Optional world-time validity
   * window (TEMPORAL.md): declared, never inferred (I15); strict ISO;
   * system edge types refuse it. */
  link(source: NodeId, target: NodeId, type?: string, context?: string, validity?: Validity): Edge;
  /** This fact stopped being true: sets valid_until (default now), keeps
   * the row. Refuses system edge types (I15), already-closed edges, and
   * until <= valid_from. */
  closeEdge(id: EdgeId, until?: string): Edge;
  /** 1-hop active set (I3). */
  /** 1-hop active set (I3, I2 on traversal), currently-valid edges by
   * default; asOf time-travels the world (TEMPORAL.md). */
  neighborhood(id: NodeId, asOf?: string): Node[];

  // --- the consent boundary ---

  /** The write-time gate (I4): created | merged_pending | exists_active. */
  propose(p: Proposal): Outcome;
  /** Park a change to an active node without applying it. */
  proposeEdit(
    id: NodeId,
    change: { fields?: Record<string, string>; archive?: boolean; origin: string; author?: string },
  ): void;
  /** Everything awaiting the owner, oldest first, with conflict hints. */
  pendingQueue(): Pending[];
  /** Apply the owner's verdict; compound verdicts run ordered + audited (I5). */
  decide(id: NodeId, decision: Decision): Node;
  /** Recompute hints for one pending item (also embedded in pendingQueue). */
  conflictsFor(id: NodeId): Conflict[];

  // --- recall ---

  /** Ranked retrieval over active, surfaceable nodes (I2): FTS × recency ×
   * importance × reinforcement; RRF-fused with cosine when a queryVector is
   * supplied. Deterministic without one — and that is not a degraded mode. */
  recall(terms: readonly string[], opts?: RecallOptions): Node[];
  /** Cross-type recall over all active, surfaceable knowledge. */
  search(terms: readonly string[], limit?: number): Node[];
  /** Record that recalled knowledge was actually used (feeds ranking + doctor). */
  touch(id: NodeId): void;

  // --- lifecycle ---

  /** Move through the status FSM (owner action; validates I8 terminality). */
  transition(id: NodeId, to: Status): Node;
  setSurfacing(id: NodeId, s: Surfacing): void;
  /** Suppress everywhere, ask-twice to view, optional re-review date. */
  quarantine(id: NodeId, reviewAt?: string): void;
  /** The honest erasure cascade (I6/I7). */
  forget(id: NodeId): ForgetReport;

  // --- identity, phase A: names (docs/ENTITIES.md) ---

  /** Record a name the node also answers to (owner verb; active nodes;
   * idempotent; audited content-free — the alias text never enters the log). */
  addAlias(id: NodeId, alias: string): void;
  removeAlias(id: NodeId, alias: string): void;
  /** All names the node answers to (normalized), alphabetical. */
  aliasesOf(id: NodeId): string[];
  /** Who is "Ana"? Exact-normalized candidates within one type — the owner
   * picks, the library never does. I2: never invisible, ask resolves. */
  resolveRef(type: string, text: string): Node[];
  /** Walk merged_into chains to the living end; non-merged returns itself. */
  survivorOf(id: NodeId): Node;
  /** Deterministic candidate generation (R1 title, R2 token-subset, R3
   * alias) writing identity questions to the queue — owner/host-scheduled,
   * never ambient. Returns questions added (≤ cap). */
  suggestIdentities(type: string, cap?: number): number;
  /** The owner's identity verdict. "same": the compound merge — survivor
   * chosen by argument order, never a heuristic; the duplicate becomes a
   * content-preserving merged husk. "different": permanent no_match (I9).
   * Returns the kept node. */
  decideIdentity(keep: NodeId, other: NodeId, verdict: "same" | "different"): Node;
  /** The bounded peer card (Phase D): the node, its names, and its 1-hop
   * active, always-surfaced neighborhood ranked by recency, hard-capped —
   * each peer carrying the raw edges that connect it, so hosts can render
   * "Ana — sister_of — …". A pure read: nothing audited, touched, written. */
  entityContext(id: NodeId, limit?: number, asOf?: string): EntityContext;

  // --- lineage & vectors & measurement ---

  /** Register a derived artifact's sources (artifact/source: node id or host ref). */
  recordDerivation(artifact: string, sources: readonly string[]): void;
  /** Derived artifacts whose sources changed or were forgotten. */
  staleDerivations(): string[];
  /** Maintain the vector sidecar — host-computed vectors only. */
  putVector(id: NodeId, model: string, vec: Float32Array): void;
  deleteVectors(model?: string): void;
  /** Rebuild index.db from memory.db (I13 — always safe, always exact). */
  rebuildIndex(): void;
  /** Metadata-only health report — reports, never acts. */
  doctor(now?: Date): DoctorReport;
}
