package memory

import "time"

// Store is the DRAFT API contract — the reviewable shape of the library.
// Phase 1 (docs/MIGRATION.md) replaces this interface with a concrete
// *Store over two SQLite files (memory.db + a disposable index.db); the
// interface exists now so the surface can be criticized before it is load-
// bearing. Method-set changes before Phase 1 are free; after, they cost.
type Store interface {
	// --- the spine ---

	// CreateNode writes an owner-authored node (born active) with provenance.
	CreateNode(n Node, p Provenance) (Node, error)
	// GetNode fetches by id regardless of status (hosts gate display).
	GetNode(id string) (Node, error)
	// UpdateNode edits an ACTIVE owner-authored node in place.
	UpdateNode(id string, title, body *string, props map[string]any) (Node, error)
	// Link writes an edge (idempotent on source+target+type).
	Link(source, target, edgeType, context string) (Edge, error)
	// Neighborhood returns the 1-hop active set around a node.
	Neighborhood(id string) ([]Node, error)

	// --- the consent boundary ---

	// Propose runs the write-time adjudication gate and, unless the gate
	// no-ops, parks the item in the consent queue.
	Propose(p Proposal) (Node, Outcome, error)
	// ProposeEdit parks a change to an active node without applying it.
	ProposeEdit(id string, fields map[string]string, archive bool, p Provenance) error
	// PendingQueue lists everything awaiting the owner, with conflict hints.
	PendingQueue() ([]Pending, error)
	// Decide applies the owner's verdict; compound decisions (supersede)
	// commit their whole sequence and audit every step.
	Decide(id string, d Decision) (Node, error)

	// --- recall ---

	// Recall is ranked retrieval over active, surfaceable nodes of one type:
	// FTS5 lexical relevance blended with recency, importance, and
	// reinforcement; fused with embedder cosine when an Embedder is set.
	Recall(terms []string, nodeType string, limit int) ([]Node, error)
	// Search is cross-type recall over all active, surfaceable knowledge.
	Search(terms []string, limit int) ([]Node, error)
	// Touch records that recalled knowledge was actually used.
	Touch(id string) error

	// --- lifecycle ---

	// Transition moves a node through the status FSM (owner action).
	Transition(id string, to Status) (Node, error)
	// SetSurfacing sets the always/ask/never axis on a node.
	SetSurfacing(id string, s Surfacing) error
	// Quarantine suppresses a node everywhere with an optional review date.
	Quarantine(id string, reviewAt *time.Time) error
	// Forget runs the honest cascade: tombstone the node, drop its edges,
	// scrub indexes, flag derived artifacts stale via lineage, and write a
	// content-free audit entry. It returns what it could NOT reach (e.g.
	// prose mentions needing owner review) rather than overclaiming.
	Forget(id string) (ForgetReport, error)

	// --- lineage & measurement ---

	// RecordDerivation registers a derived artifact's sources (lineage).
	RecordDerivation(artifactID string, sourceIDs []string) error
	// StaleDerivations lists derived artifacts whose sources changed.
	StaleDerivations() ([]string, error)
	// Doctor computes the metadata-only health report. It reports; it
	// never acts.
	Doctor(now time.Time) (DoctorReport, error)
}

// ForgetReport is the honest account of a Forget cascade: what was
// tombstoned, what was scrubbed, and what needs the owner (prose mentions,
// exports already written).
type ForgetReport struct {
	Tombstoned    []string // node ids content-destroyed
	EdgesDropped  int
	IndexScrubbed bool
	FlaggedStale  []string // derived artifacts marked stale via lineage
	NeedsOwner    []string // refs the cascade cannot honestly resolve alone
}

// DoctorReport is the metadata-only health snapshot; every field is
// computable without a model call and phrased as candidates, never actions.
type DoctorReport struct {
	ActiveCount, PendingCount int
	AcceptRate30d             float64  // owner decisions: approved / decided
	DeadWeightCandidates      []string // active, never recalled, aged — review, don't auto-archive
	StaleCandidates           []string // possibly superseded by later activity
	DuplicateCandidates       [][2]string
	QueueOldestDays           int
}
