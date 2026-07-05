package memory

// Proposal is an agent-authored write awaiting the owner's decision. The
// host renders pending proposals however it likes (cards, CLI, TUI); the
// queue and its lifecycle live here.
type Proposal struct {
	NodeType   string // "memory", "skill", or a host-registered type
	Title      string
	Body       string
	Importance int // 1..5; 0 = not applicable for this type
	WhenToUse  string
	Provenance Provenance
}

// Outcome says how the write-time adjudication gate routed a proposal.
// The gate runs BEFORE anything is written — duplicates and known facts are
// resolved at the front door, not left for recall time.
type Outcome string

const (
	OutcomeCreated       Outcome = "created"        // new proposal awaiting decision
	OutcomeMergedPending Outcome = "merged_pending" // refreshed an existing pending proposal
	OutcomeExistsActive  Outcome = "exists_active"  // no-op; an active node already covers it
)

// Conflict is a hint attached to a pending proposal: an active node the
// proposal may duplicate or contradict. Hints are advisory — the owner
// adjudicates; the library never auto-resolves a conflict.
type Conflict struct {
	NodeID string
	Title  string
	Reason string // "title_match", "lexical_overlap"
}

// Pending is one reviewable item in the consent queue: a proposal, or a
// parked edit to an active node, together with its conflict hints.
type Pending struct {
	Node      Node
	Edit      *EditEnvelope // non-nil: a parked change to an ACTIVE node
	Conflicts []Conflict
}

// EditEnvelope is a parked, agent-proposed change to an active node. The
// approved content is untouched until the owner applies it.
type EditEnvelope struct {
	Fields     map[string]string
	Archive    bool
	Provenance Provenance
}

// Decision is the owner's verdict on a pending item.
type Decision struct {
	Kind       DecisionKind
	Edits      map[string]string // KindApproveEdited: owner-corrected fields
	Supersedes string            // KindApproveSuperseding: active node id to archive+chain
}

type DecisionKind string

const (
	KindApprove            DecisionKind = "approve"
	KindApproveEdited      DecisionKind = "approve_edited"
	KindApproveSuperseding DecisionKind = "approve_superseding"
	KindReject             DecisionKind = "reject"
)
