import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { MemoryError, type NodeId } from "./types.ts";

let dir: string;
let store: Store;
let tick = 0;
const T0 = Date.parse("2026-07-05T12:00:00.000Z");
const now = () => new Date(T0 + ++tick);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bm-consent-"));
  tick = 0;
  store = Store.open({ dir, now });
  store.registerType({ name: "memory", bornStatus: "proposed" });
  store.registerType({ name: "note", bornStatus: "active" });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const mem = (title: string, body = "", importance = 3) =>
  store.propose({ type: "memory", title, body, importance, origin: "turn:t" });

describe("the AUDN gate (I4)", () => {
  test("created → merged_pending (normalized title) → exists_active", () => {
    const first = mem("Lives in Brasov", "moved 2019");
    expect(first.kind).toBe("created");
    expect(first.node.status).toBe("proposed");

    const merged = store.propose({
      type: "memory",
      title: "  lives in  BRASOV ",
      body: "moved in 2019, near the center",
      importance: 4,
      origin: "turn:t2",
    });
    expect(merged.kind).toBe("merged_pending");
    expect(merged.node.id).toBe(first.node.id); // same card, refreshed
    expect(merged.node.body).toBe("moved in 2019, near the center");
    expect(merged.node.importance).toBe(4);
    expect(merged.node.origin).toBe("turn:t2"); // latest provenance wins
    expect(store.pendingQueue()).toHaveLength(1);

    store.decide(first.node.id, { kind: "approve" });
    const noop = mem("Lives in Brasov");
    expect(noop.kind).toBe("exists_active");
    expect(noop.node.id).toBe(first.node.id);
    expect(store.pendingQueue()).toHaveLength(0); // nothing was written
  });

  test("a rejected title does not block a fresh proposal (documented)", () => {
    const p = mem("Prefers tea");
    store.decide(p.node.id, { kind: "reject" });
    expect(mem("Prefers tea").kind).toBe("created");
  });

  test("owner-authored types refuse the gate; owner path stays born-active (I1)", () => {
    expect(() => store.propose({ type: "note", title: "x", body: "", origin: "t" })).toThrow(MemoryError);
    const agent = mem("Sister Ana lives nearby");
    expect(agent.node.status).toBe("proposed"); // agent half of I1
    const owner = store.createNode({ type: "memory", title: "Owner-stated fact", origin: "t" });
    expect(owner.status).toBe("active"); // owner half of I1
  });
});

describe("parked edits", () => {
  test("park, latest wins, gated types + active only, empty change refused", () => {
    const p = mem("Dog is named Rex", "golden retriever");
    store.decide(p.node.id, { kind: "approve" });
    store.proposeEdit(p.node.id, { fields: { body: "golden retriever, 4 years old" }, origin: "turn:e1" });
    store.proposeEdit(p.node.id, { fields: { body: "golden retriever, 5 years old" }, origin: "turn:e2" });
    const q = store.pendingQueue();
    expect(q).toHaveLength(1);
    expect(q[0]?.edit?.fields["body"]).toBe("golden retriever, 5 years old"); // latest wins
    expect(q[0]?.node.body).toBe("golden retriever"); // approved content untouched

    const note = store.createNode({ type: "note", title: "N", origin: "t" });
    expect(() => store.proposeEdit(note.id, { fields: { body: "x" }, origin: "t" })).toThrow(MemoryError);
    expect(() => store.proposeEdit(p.node.id, { origin: "t" })).toThrow("nothing to propose");
  });
});

describe("conflict hints", () => {
  test("title_match and lexical_overlap, capped, self-excluded", () => {
    const a = mem("Trains for the marathon", "long runs every Saturday morning");
    store.decide(a.node.id, { kind: "approve" });
    // owner later creates an exact-title duplicate through the owner path:
    store.createNode({ type: "memory", title: "trains for the  MARATHON", origin: "t" });
    const b = mem("Signed up for a marathon", "the Saturday long runs are paying off");
    const conflicts = store.conflictsFor(b.node.id);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts.length).toBeLessThanOrEqual(2);
    expect(conflicts.map((c) => c.reason)).toContain("lexical_overlap");
    expect(conflicts.every((c) => c.nodeId !== b.node.id)).toBe(true);
    // and the queue embeds them
    const q = store.pendingQueue();
    expect(q[0]?.conflicts.length).toBeGreaterThan(0);
  });
});

describe("decide (I5)", () => {
  test("approve_edited applies owner corrections, then activates, reindexed", () => {
    const p = mem("Works at Siemens", "since 2021");
    const n = store.decide(p.node.id, {
      kind: "approve_edited",
      fields: { body: "since 2021, Cluj office", importance: "5", when_to_use: "career questions" },
    });
    expect(n.status).toBe("active");
    expect(n.body).toBe("since 2021, Cluj office");
    expect(n.importance).toBe(5);
    expect(n.props["when_to_use"]).toBe("career questions");
    expect(store.recall(["cluj"]).map((x) => x.id)).toContain(n.id); // FTS reindexed
  });

  test("approve_superseding: activate → archive → supersedes edge, in order (I5)", () => {
    const oldFact = mem("Lives in Brasov", "moved there in 2019, lives near the center");
    store.decide(oldFact.node.id, { kind: "approve" });
    const newFact = store.propose({
      type: "memory",
      title: "Lives in Cluj",
      body: "moved to Cluj, lives there now",
      importance: 4,
      origin: "turn:t9",
    });
    const activated = store.decide(newFact.node.id, {
      kind: "approve_superseding",
      supersedes: oldFact.node.id,
    });
    expect(activated.status).toBe("active");
    expect(store.getNode(oldFact.node.id).status).toBe("archived");

    const db = new Database(join(dir, "memory.db"), { readonly: true });
    const edge = db
      .query("SELECT COUNT(*) AS c FROM edges WHERE source = ? AND target = ? AND type = 'supersedes'")
      .get(newFact.node.id, oldFact.node.id) as { c: number };
    const auditRow = db
      .query("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'consent.decide' AND ref = ?")
      .get(newFact.node.id) as { c: number };
    db.close();
    expect(edge.c).toBe(1);
    expect(auditRow.c).toBe(1);

    // the superseded fact leaves ambient recall (I2 composes with I5)
    const titles = store.recall(["lives"]).map((x) => x.title);
    expect(titles).toContain("Lives in Cluj");
    expect(titles).not.toContain("Lives in Brasov");
  });

  test("supersede guards: target must be active, same type, proposals only", () => {
    const p1 = mem("Fact one");
    const p2 = mem("Fact two");
    expect(() => store.decide(p1.node.id, { kind: "approve_superseding", supersedes: p2.node.id })).toThrow(
      "not active",
    );
    store.decide(p1.node.id, { kind: "approve" });
    store.registerType({ name: "skill", bornStatus: "proposed" });
    const s = store.propose({ type: "skill", title: "Weekly review", body: "steps", origin: "t" });
    expect(() => store.decide(s.node.id, { kind: "approve_superseding", supersedes: p1.node.id })).toThrow(
      "within one node type",
    );
  });

  test("edit verdicts: approve applies envelope (archive wins), reject clears untouched", () => {
    const p = mem("Tracks weight weekly", "every Sunday");
    store.decide(p.node.id, { kind: "approve" });

    store.proposeEdit(p.node.id, { fields: { body: "every Monday" }, origin: "t" });
    store.decide(p.node.id, { kind: "reject" });
    expect(store.getNode(p.node.id).body).toBe("every Sunday"); // untouched
    expect(store.pendingQueue()).toHaveLength(0);

    store.proposeEdit(p.node.id, { fields: { body: "ignored" }, archive: true, origin: "t" });
    const archived = store.decide(p.node.id, { kind: "approve" });
    expect(archived.status).toBe("archived"); // archive wins over fields
    expect(archived.body).toBe("every Sunday");
  });

  test("deciding with nothing pending fails; supersede on an edit fails", () => {
    const p = mem("Allergic to penicillin");
    store.decide(p.node.id, { kind: "approve" });
    expect(() => store.decide(p.node.id, { kind: "approve" })).toThrow("nothing pending");
    store.proposeEdit(p.node.id, { fields: { body: "confirmed twice" }, origin: "t" });
    expect(() => store.decide(p.node.id, { kind: "approve_superseding", supersedes: "x" as NodeId })).toThrow(
      "proposals, not parked edits",
    );
  });
});
