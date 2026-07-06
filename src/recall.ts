/**
 * Recall: term extraction, the deterministic ranking blend, and vector
 * fusion (DESIGN.md "Recall as fusion"; SCHEMA.md I2).
 *
 * The blend: score = bm25 × recency × importanceBoost × reinforcement
 *   recency        = max(exp(-λeff · days), RECENCY_FLOOR); days since
 *                    last_used ?? updated; λeff = λ · (1 − 0.8·importance/5)
 *                    — importance slows decay (the spacing-effect shape)
 *   importanceBoost= 1 + importance/5
 *   reinforcement  = 1 + r · ln(1 + use_count)
 * The recency floor keeps a perfect lexical match alive at any age — decay
 * demotes, it never erases.
 *
 * I2 surfacing semantics enforced here:
 *   always → ambient recall eligible
 *   ask    → returned only when a query term literally names a word of its
 *            title (never via broad body/vector matching)
 *   never  → unreachable here (getNode only)
 */

import type { RankingConfig, RecallOptions } from "./contract.ts";
import { allVectors, cosine } from "./indexdb/vectors.ts";
import type { Ctx } from "./spine.ts";
import type { Node, NodeId, Status, Surfacing } from "./types.ts";
import { MemoryError, parseProps, parseStrictIso } from "./types.ts";

/** Pinned defaults — conformance and the golden fixtures assume these. */
export const DEFAULT_RANKING: RankingConfig = { lambda: 0.02, reinforcement: 0.2, rrfK: 60 };
const RECENCY_FLOOR = 0.05;
const DEFAULT_LIMIT = 8;
const CANDIDATE_FACTOR = 4; // over-fetch lexical candidates before re-ranking

// --- term extraction (optional helpers — hosts may bring their own terms) ---

/** English + Romanian fillers that survive a length gate but carry no salience. */
const STOPWORDS = new Set(
  (
    "the and for you your this that with have has was were what when where which would could should about there " +
    "their they them then than some something anything everything nothing just like want need know think going " +
    "been being will from mine ours today tomorrow really very much more please thanks thank okay into over under " +
    "after before again still also well tell make made can cant dont its are not but all any how who out get got " +
    "este sunt care pentru despre acest aceasta atunci acum unde cand cine ceva totul nimic vreau trebuie poate " +
    "foarte mult chiar doar inca dupa inainte azi maine multumesc niste fara cum asta sunt avem este"
  ).split(/\s+/),
);

/**
 * Reduce free text to recall terms: proper nouns first (capitalized tokens
 * beyond the first word, ≥2 chars — names are memory keys), then remaining
 * non-stopword tokens ≥3 chars, longest first. Up to 2 carryover terms from
 * `prior` texts (most recent first) so follow-up turns aren't memory-blind.
 * Cap: 6 terms. Deterministic; FTS OR-semantics tolerate breadth.
 */
export function termsFromText(text: string, prior: readonly string[] = []): string[] {
  const out = extract(text).slice(0, 4);
  const last = prior[prior.length - 1];
  if (last !== undefined) {
    let carried = 0;
    for (const term of extract(last)) {
      if (out.length >= 6 || carried >= 2) break;
      if (!out.some((t) => t.toLowerCase() === term.toLowerCase())) {
        out.push(term);
        carried++;
      }
    }
  }
  return out;
}

function extract(text: string): string[] {
  const rawTokens = text.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
  const proper: string[] = [];
  const plain: string[] = [];
  const seen = new Set<string>();
  rawTokens.forEach((tok, i) => {
    const lower = tok.toLowerCase();
    if (seen.has(lower) || STOPWORDS.has(lower)) return;
    const first = tok[0] ?? "";
    const isProper = i > 0 && tok.length >= 2 && first !== first.toLowerCase();
    if (isProper) {
      seen.add(lower);
      proper.push(tok);
    } else if (lower.length >= 3) {
      seen.add(lower);
      plain.push(lower);
    }
  });
  plain.sort((a, b) => b.length - a.length);
  return [...proper, ...plain];
}

// --- lexical candidates (FTS5 bm25) ---

/** `"term" OR "term"` with FTS5 quote-doubling so user text cannot inject operators. */
function matchExpr(terms: readonly string[]): string {
  return terms
    .map((t) => t.trim())
    .filter((t) => t !== "" && !t.includes("\u0000"))
    .map((t) => `"${t.replaceAll('"', '""')}"`)
    .join(" OR ");
}

export interface Candidate {
  id: string;
  rel: number; // -bm25 rank: higher is better, > 0
}

export function lexicalCandidates(
  ctx: Ctx,
  terms: readonly string[],
  kind: string | undefined,
  cap: number,
): Candidate[] {
  if (terms.length === 0) return [];
  const expr = matchExpr(terms);
  if (expr === "") return [];
  // Ambient (untyped) recall excludes day-anchor plumbing (review #8); an
  // explicit type filter — including type:"day" — reaches everything.
  const sql =
    kind === undefined
      ? "SELECT id, -rank AS rel FROM nodes_fts WHERE nodes_fts MATCH ? AND kind != 'day' ORDER BY rank LIMIT ?"
      : "SELECT id, -rank AS rel FROM nodes_fts WHERE nodes_fts MATCH ? AND kind = ? ORDER BY rank LIMIT ?";
  const params = kind === undefined ? [expr, cap] : [expr, kind, cap];
  return ctx.idx.query<{ id: string; rel: number }>(sql, params).map((r) => ({ id: r.id, rel: r.rel }));
}

// --- node loading with the I2 surfacing filter ---

interface RowShape {
  id: string;
  type: string;
  title: string;
  body: string;
  status: string;
  surfacing: string;
  importance: number;
  props: string;
  origin: string;
  author: string;
  use_count: number;
  last_used: string | null;
  review_at: string | null;
  when_at: string | null;
  created: string;
  updated: string;
}

function loadEligible(ctx: Ctx, ids: readonly string[], terms: readonly string[]): Map<string, Node> {
  const out = new Map<string, Node>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => "?").join(", ");
  const rows = ctx.mem.query<RowShape & Record<string, string | number | null>>(
    `SELECT id, type, title, body, status, surfacing, importance, props, origin, author,
            use_count, last_used, review_at, when_at, created, updated
     FROM nodes WHERE id IN (${placeholders})
       AND status = 'active' AND surfacing IN ('always', 'ask')`,
    [...ids],
  );
  const lowered = terms.map((t) => t.toLowerCase());
  for (const r of rows) {
    if (r.surfacing === "ask" && !titleNamed(r.title, lowered)) continue; // I2
    out.set(r.id, rowShapeToNode(r));
  }
  return out;
}

function rowShapeToNode(r: RowShape): Node {
  return {
    id: r.id as NodeId, // brand boundary
    type: r.type,
    title: r.title,
    body: r.body,
    status: r.status as Status,
    surfacing: r.surfacing as Surfacing,
    importance: r.importance,
    props: parseProps(r.props),
    origin: r.origin,
    author: r.author,
    useCount: r.use_count,
    lastUsed: r.last_used,
    reviewAt: r.review_at,
    when: r.when_at,
    created: r.created,
    updated: r.updated,
  };
}

/** An `ask` node is surfaced only when a query term IS a word of its title.
 * Exported: the consent surfaces apply the same I2 rule to hints. */
export function titleNamed(title: string, loweredTerms: readonly string[]): boolean {
  const words = new Set(
    title
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w !== ""),
  );
  return loweredTerms.some((t) => words.has(t));
}

// --- the blend ---

function blendScore(node: Node, rel: number, cfg: RankingConfig, nowMs: number): number {
  const anchor = node.lastUsed ?? node.updated;
  const days = Math.max(0, (nowMs - Date.parse(anchor)) / 86_400_000);
  const lambdaEff = cfg.lambda * (1 - 0.8 * (node.importance / 5));
  const recency = Math.max(Math.exp(-lambdaEff * days), RECENCY_FLOOR);
  const importanceBoost = 1 + node.importance / 5;
  const reinforcement = 1 + cfg.reinforcement * Math.log(1 + node.useCount);
  return rel * recency * importanceBoost * reinforcement;
}

// --- public entry points (Store delegates here) ---

export function recall(ctx: Ctx, terms: readonly string[], opts: RecallOptions = {}): Node[] {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const cfg = DEFAULT_RANKING;
  const nowMs = ctx.now().getTime();
  const cap = limit * CANDIDATE_FACTOR + 16;

  const lex = lexicalCandidates(ctx, terms, opts.type, cap);
  const nodes = loadEligible(
    ctx,
    lex.map((c) => c.id),
    terms,
  );
  const lexRanked = lex
    .filter((c) => nodes.has(c.id))
    .map((c) => ({ id: c.id, score: blendScore(nodes.get(c.id) as Node, c.rel, cfg, nowMs) }))
    .sort((a, b) => b.score - a.score);

  if (opts.queryVector === undefined || opts.model === undefined) {
    return lexRanked.slice(0, limit).map((c) => nodes.get(c.id) as Node);
  }

  // --- vector stage: cosine over stored vectors, then reciprocal-rank fusion.
  // Pure-vector hits cannot "name" a title, so the vector universe is
  // surfacing='always' only (I2).
  const vecs = allVectors(ctx.idx, opts.model);
  const sims: { id: string; sim: number }[] = [];
  for (const [id, vec] of vecs) {
    const sim = cosine(opts.queryVector, vec);
    if (sim !== null) sims.push({ id, sim });
  }
  sims.sort((a, b) => b.sim - a.sim);
  const vecIds = sims.slice(0, cap).map((s) => s.id);
  const vecNodes = loadEligible(ctx, vecIds, []); // no terms → 'ask' rows drop (I2)
  if (opts.type !== undefined) {
    for (const [id, n] of vecNodes) if (n.type !== opts.type) vecNodes.delete(id);
  }
  const vecRanked = vecIds.filter((id) => vecNodes.has(id));

  const rrf = new Map<string, number>();
  lexRanked.forEach((c, i) => rrf.set(c.id, (rrf.get(c.id) ?? 0) + 1 / (cfg.rrfK + i + 1)));
  vecRanked.forEach((id, i) => rrf.set(id, (rrf.get(id) ?? 0) + 1 / (cfg.rrfK + i + 1)));

  const byId = new Map<string, Node>([...nodes, ...vecNodes]);
  return [...rrf.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => byId.get(id) as Node);
}

/** Cross-type recall over all active, surfaceable knowledge. */
export function search(ctx: Ctx, terms: readonly string[], limit = 10): Node[] {
  return recall(ctx, terms, { limit });
}

const DEFAULT_AGENDA_LIMIT = 100;

/**
 * The episodic-past window (review-3 G1): active, always-surfaced nodes by
 * CREATED in [from, to) — what recall is to text and agenda is to the
 * scheduled future, episode is to the lived past ("what happened in
 * March"). Day anchors are excluded when untyped (plumbing; an explicit
 * type:"day" reaches them — the recall convention). A pure read: no
 * side-effect day creation, ever.
 */
export function episode(
  ctx: Ctx,
  from: string,
  to: string,
  opts: { type?: string; limit?: number } = {},
): Node[] {
  const lo = parseStrictIso(from, "from");
  const hi = parseStrictIso(to, "to");
  if (hi <= lo) throw new MemoryError("props_invalid", "to must be after from");
  const limit = opts.limit ?? DEFAULT_AGENDA_LIMIT;
  if (!Number.isInteger(limit) || limit < 1)
    throw new MemoryError("props_invalid", "limit must be a positive integer");
  const typed = opts.type !== undefined;
  const rows = ctx.mem.query<RowShape & Record<string, string | number | null>>(
    `SELECT id, type, title, body, status, surfacing, importance, props, origin, author,
            use_count, last_used, review_at, when_at, created, updated
     FROM nodes
     WHERE created >= ? AND created < ?
       AND status = 'active' AND surfacing = 'always'
       ${typed ? "AND type = ?" : "AND type != 'day'"}
     ORDER BY created ASC, id ASC LIMIT ?`,
    typed ? [lo, hi, opts.type as string, limit] : [lo, hi, limit],
  );
  return rows.map(rowShapeToNode);
}

/**
 * Ambient recall over time (PLANNING.md): active nodes with a scheduled
 * moment in [from, to), ordered when_at ASC then id ASC. I2 applies
 * exactly as in recall — an agenda pull literally names nothing, so only
 * `always`-surfaced nodes appear; `ask` stays off the board (the owner's
 * choice working, not failing) and `never` is invisible here as
 * everywhere. Past windows are the January calendar — time travel the
 * same way asOf is. Both bounds strict ISO (I17's shared time rule).
 */
export function agenda(
  ctx: Ctx,
  from: string,
  to: string,
  opts: { type?: string; limit?: number } = {},
): Node[] {
  const lo = parseStrictIso(from, "from");
  const hi = parseStrictIso(to, "to");
  if (hi <= lo) throw new MemoryError("props_invalid", "to must be after from");
  const limit = opts.limit ?? DEFAULT_AGENDA_LIMIT;
  if (!Number.isInteger(limit) || limit < 1)
    throw new MemoryError("props_invalid", "limit must be a positive integer");
  const typed = opts.type !== undefined;
  const rows = ctx.mem.query<RowShape & Record<string, string | number | null>>(
    `SELECT id, type, title, body, status, surfacing, importance, props, origin, author,
            use_count, last_used, review_at, when_at, created, updated
     FROM nodes
     WHERE when_at IS NOT NULL AND when_at >= ? AND when_at < ?
       AND status = 'active' AND surfacing = 'always'
       ${typed ? "AND type = ?" : ""}
     ORDER BY when_at ASC, id ASC LIMIT ?`,
    typed ? [lo, hi, opts.type as string, limit] : [lo, hi, limit],
  );
  return rows.map(rowShapeToNode);
}
