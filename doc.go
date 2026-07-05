// Package memory is a consent-gated, lineage-tracked, forgettable memory
// layer for personal AI: the layer above storage.
//
// The library owns durable state and its lifecycle — nodes, edges, proposals,
// provenance, surfacing policy, forgetting — over plain SQLite. It never
// calls a model: extraction, summarization, and reflection are host concerns;
// this package gives their outputs deterministic, auditable places to land
// and a consent boundary to cross.
//
// THE CONSENT BOUNDARY is the load-bearing contract: agent-authored writes
// enter as proposals (StatusProposed) and become part of memory only through
// an owner decision (Decide). Owner-authored writes are born active. The
// boundary is enforced in the data layer — recall and traversal never surface
// a proposed, rejected, quarantined, or forgotten node as fact.
//
// Package layout (target shape; phases in docs/MIGRATION.md):
//
//	memory        the public façade: Store, options, consent verbs
//	memory/node   the spine: nodes, edges, status FSM, type registry
//	memory/recall FTS5 index + ranking blend + optional embedder fusion
//	memory/lineage provenance edges and derived-artifact sources
//	memory/doctor  self-measurement: quality signals, health report
//
// The draft API surface lives in contract.go until Phase 1 replaces it with
// a concrete *Store.
package memory
