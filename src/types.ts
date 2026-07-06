/**
 * Core domain types. The durable contract is docs/SCHEMA.md; these types are
 * its TypeScript projection. Everything here is plain data — no classes, no
 * methods, JSON-safe throughout.
 */

/** Branded id types — a NodeId is not an EdgeId is not a string. */
export type NodeId = string & { readonly __brand: "NodeId" };
export type EdgeId = string & { readonly __brand: "EdgeId" };

/**
 * Node lifecycle (SCHEMA.md "Status semantics"). rejected, forgotten and
 * merged are terminal (I8). "Forgotten" is honest erasure — content is
 * destroyed, not hidden; suppression is what "quarantined" is for.
 */
export type Status = "proposed" | "active" | "archived" | "rejected" | "quarantined" | "forgotten" | "merged";

/**
 * The third axis besides status and importance: whether an active node may
 * surface without being explicitly asked for (I2). Storage consent is not
 * usage consent.
 */
export type Surfacing = "always" | "ask" | "never";

/** Prop values are JSON scalars/objects the host defines per node type. */
export type Props = Readonly<Record<string, unknown>>;

/** One row of the spine. Everything durable is a node. */
export interface Node {
  readonly id: NodeId;
  readonly type: string;
  readonly title: string;
  readonly body: string;
  readonly status: Status;
  readonly surfacing: Surfacing;
  /** 0 = not applicable for this type; 1..5 otherwise. */
  readonly importance: number;
  readonly props: Props;
  /** Provenance: host-defined source ref ("turn:abc", "telegram:fwd:123"). */
  readonly origin: string;
  /** "" = the owner's own words; otherwise a third-party attribution. */
  readonly author: string;
  readonly useCount: number;
  readonly lastUsed: string | null; // ISO-8601 UTC
  readonly reviewAt: string | null; // quarantine re-review date
  readonly created: string;
  readonly updated: string;
}

/**
 * A typed link between nodes. System edge types the library itself writes:
 * on_day, supersedes, merged_into, no_match, derived_from (SCHEMA.md table).
 * `created` is transaction time (when the library learned it); validFrom/
 * validUntil are world time (when it was true — TEMPORAL.md): null from =
 * undated, null until = still true. System edge types are timeless (I15).
 */
export interface Edge {
  readonly id: EdgeId;
  readonly source: NodeId;
  readonly target: NodeId;
  readonly type: string;
  readonly context: string;
  readonly created: string;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
}

export const SYSTEM_EDGE_TYPES = ["on_day", "supersedes", "merged_into", "no_match", "derived_from"] as const;

/** Registration of a node type in the registry (I1: bornStatus is the consent split). */
export interface NodeTypeSpec {
  readonly name: string;
  readonly bornStatus: "active" | "proposed";
  /** prop key → shape; empty = any props allowed. */
  readonly propsSchema?: Readonly<
    Record<string, { type: "string" | "number" | "boolean"; required?: boolean }>
  >;
  readonly template?: { readonly body?: string; readonly props?: Props };
}

/** Content-free audit row (I7/I12): ids, actions, counts, flags — never text. */
export interface AuditEntry {
  readonly at: string;
  readonly actor: "owner" | "agent" | "system";
  readonly action: string;
  readonly ref: string;
  readonly ok: boolean;
  readonly meta: Readonly<Record<string, string | number | boolean>>;
}

/** Shared normalization for titles, aliases, and referent text: lowercase,
 * collapsed whitespace. One rule everywhere identity is compared. */
export function normalizeText(s: string): string {
  return s.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

/** Strict ISO-8601 UTC (the reviewAt rule): full timestamp or date-only
 * (which becomes midnight UTC). Lenient Date.parse silently timezone-
 * shifts human-ish strings — refused here. Returns the normalized ISO
 * string or throws props_invalid. One rule everywhere time is declared. */
export function parseStrictIso(s: string, what: string): string {
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?Z)?$/.test(s))
    throw new MemoryError(
      "props_invalid",
      `${what} must be ISO-8601 UTC (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS[.mmm]Z)`,
    );
  const ms = Date.parse(s.length === 10 ? `${s}T00:00:00.000Z` : s);
  if (Number.isNaN(ms)) throw new MemoryError("props_invalid", `${what} is not a real date`);
  return new Date(ms).toISOString();
}

/**
 * The narrow validator all row-level JSON passes through (CODING.md): a
 * malformed props cell degrades to an empty object instead of bricking
 * every read that touches the row. Title/body stay readable; the doctor's
 * duplicate scan and the host's own inspection find the damage.
 */
export function parseProps(raw: string): Props {
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Props;
    return {};
  } catch {
    return {};
  }
}

/** Typed failure for broken invariants and programmer error — domain forks
 * are return values, not exceptions (DESIGN.md "Errors and outcomes"). */
export class MemoryError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "invalid_transition"
      | "type_unknown"
      | "props_invalid"
      | "store_closed"
      | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "MemoryError";
  }
}
