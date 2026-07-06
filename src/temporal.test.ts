import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { type EdgeId, MemoryError } from "./types.ts";

let dir: string;
let store: Store;
let tick = 0;
const T0 = Date.parse("2026-07-05T12:00:00.000Z");
const now = () => new Date(T0 + ++tick);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bm-temporal-"));
  tick = 0;
  store = Store.open({ dir, now });
  store.registerType({ name: "person", bornStatus: "active" });
  store.registerType({ name: "org", bornStatus: "active" });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("edge validity (Phase A, I15)", () => {
  test("link takes a window; date-only normalizes; Edge carries both fields", () => {
    const ana = store.createNode({ type: "person", title: "Ana", origin: "o" });
    const co = store.createNode({ type: "org", title: "Siemens", origin: "o" });
    const e = store.link(ana.id, co.id, "works_at", "", { from: "2021-03-01" });
    expect(e.validFrom).toBe("2021-03-01T00:00:00.000Z");
    expect(e.validUntil).toBeNull();
    // undated edges stay the honest default
    const co2 = store.createNode({ type: "org", title: "SideGig", origin: "o" });
    const e2 = store.link(ana.id, co2.id, "advises");
    expect(e2.validFrom).toBeNull();
    expect(e2.validUntil).toBeNull();
  });

  test("validity validation: bad ISO, inverted window, system types refused", () => {
    const a = store.createNode({ type: "person", title: "A", origin: "o" });
    const b = store.createNode({ type: "person", title: "B", origin: "o" });
    expect(() => store.link(a.id, b.id, "knows", "", { from: "next tuesday" })).toThrow("ISO-8601");
    expect(() => store.link(a.id, b.id, "knows", "", { from: "2026-01-01", until: "2025-01-01" })).toThrow(
      "after",
    );
    expect(() => store.link(a.id, b.id, "no_match", "", { from: "2026-01-01" })).toThrow("I15");
  });

  test("closeEdge: default now, custom until, loud on double-close and bad windows", () => {
    const a = store.createNode({ type: "person", title: "A", origin: "o" });
    const b = store.createNode({ type: "org", title: "B Corp", origin: "o" });
    const e = store.link(a.id, b.id, "works_at", "", { from: "2021-03-01" });
    const closed = store.closeEdge(e.id, "2026-01-31");
    expect(closed.validUntil).toBe("2026-01-31T00:00:00.000Z");
    expect(() => store.closeEdge(e.id)).toThrow("already closed");

    const e2 = store.link(a.id, b.id, "advises");
    const closed2 = store.closeEdge(e2.id); // default: the store clock's now
    expect(closed2.validUntil).toMatch(/^2026-07-05T12:00:00\.\d{3}Z$/);

    const e3 = store.link(a.id, b.id, "mentors", "", { from: "2026-06-01" });
    expect(() => store.closeEdge(e3.id, "2026-05-01")).toThrow("after valid_from");
    expect(() => store.closeEdge("01hzzzzzzzzzzzzzzzzzzzzzzz" as EdgeId)).toThrow("no edge");
  });

  test("closeEdge refuses system edge types — no_match stays permanent (I15 guards I9)", () => {
    const a = store.createNode({ type: "person", title: "Radu One", origin: "o" });
    const b = store.createNode({ type: "person", title: "radu one", origin: "o" });
    store.decideIdentity(a.id, b.id, "different");
    const db = new Database(join(dir, "memory.db"), { readonly: true });
    const nm = db.query("SELECT id FROM edges WHERE type = 'no_match'").get() as { id: string };
    const onDay = db.query("SELECT id FROM edges WHERE type = 'on_day' LIMIT 1").get() as { id: string };
    db.close();
    expect(() => store.closeEdge(nm.id as EdgeId)).toThrow("I15");
    expect(() => store.closeEdge(onDay.id as EdgeId)).toThrow("I15");
  });

  test("neighborhood and the peer card live in the present; asOf time-travels", () => {
    const ana = store.createNode({ type: "person", title: "Ana", origin: "o" });
    const siemens = store.createNode({ type: "org", title: "Siemens", origin: "o" });
    const bitdef = store.createNode({ type: "org", title: "Bitdefender", origin: "o" });
    const job1 = store.link(ana.id, siemens.id, "works_at", "", { from: "2021-03-01" });
    store.closeEdge(job1.id, "2026-01-31");
    store.link(ana.id, bitdef.id, "works_at", "", { from: "2026-02-01" });

    expect(store.neighborhood(ana.id).map((n) => n.title)).toEqual(["Bitdefender"]);
    expect(store.neighborhood(ana.id, "2024-06-15T12:00:00.000Z").map((n) => n.title)).toEqual(["Siemens"]);
    expect(store.neighborhood(ana.id, "2020-01-01")).toEqual([]);

    const nowCard = store.entityContext(ana.id);
    expect(nowCard.peers.map((p) => p.node.title)).toEqual(["Bitdefender"]);
    const thenCard = store.entityContext(ana.id, 6, "2024-06-15T12:00:00.000Z");
    expect(thenCard.peers.map((p) => p.node.title)).toEqual(["Siemens"]);
    expect(thenCard.peers[0]?.edges[0]?.validUntil).toBe("2026-01-31T00:00:00.000Z"); // window rides the card

    expect(() => store.neighborhood(ana.id, "whenever")).toThrow("ISO-8601");
    expect(() => store.entityContext(ana.id, 6, "whenever")).toThrow("ISO-8601");
  });

  test("the merge rewires validity along with the edge (edges are not anonymous rows)", () => {
    const keep = store.createNode({ type: "person", title: "Keeper T", origin: "o" });
    const dup = store.createNode({ type: "person", title: "keeper t", origin: "o" });
    const co = store.createNode({ type: "org", title: "OldCo", origin: "o" });
    const e = store.link(dup.id, co.id, "works_at", "", { from: "2019-05-01" });
    store.closeEdge(e.id, "2023-04-30");
    store.decideIdentity(keep.id, dup.id, "same");

    const db = new Database(join(dir, "memory.db"), { readonly: true });
    const moved = db
      .query("SELECT valid_from, valid_until FROM edges WHERE source = ? AND type = 'works_at'")
      .get(keep.id) as { valid_from: string; valid_until: string };
    db.close();
    expect(moved.valid_from).toBe("2019-05-01T00:00:00.000Z");
    expect(moved.valid_until).toBe("2023-04-30T00:00:00.000Z");
    // and the closed job is history, not present: it shows under asOf only
    expect(store.neighborhood(keep.id).map((n) => n.title)).toEqual([]);
    expect(store.neighborhood(keep.id, "2020-01-01").map((n) => n.title)).toEqual(["OldCo"]);
  });

  test("an older store upgrades in place through every delta and keeps its data", () => {
    const a = store.createNode({ type: "person", title: "Upgrader", origin: "o" });
    store.close();
    // wind the schema back to v2: drop everything v3 and v4 created
    const db = new Database(join(dir, "memory.db"));
    db.run("UPDATE meta SET value = '2' WHERE key = 'schema_version'");
    db.run("DROP TABLE memory_history");
    db.run("ALTER TABLE edges DROP COLUMN valid_from");
    db.run("ALTER TABLE edges DROP COLUMN valid_until");
    db.run("DROP INDEX idx_nodes_when");
    db.run("ALTER TABLE nodes DROP COLUMN when_at");
    db.close();
    store = Store.open({ dir, now }); // migrates 2 → 3 → 4
    const db2 = new Database(join(dir, "memory.db"), { readonly: true });
    const v = db2.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
    const hist = db2.query("SELECT COUNT(*) AS c FROM memory_history").get() as { c: number };
    db2.close();
    expect(v.value).toBe("4");
    expect(hist.c).toBe(0);
    expect(store.getNode(a.id).title).toBe("Upgrader"); // data survived
    const b = store.createNode({ type: "person", title: "Post-upgrade", origin: "o" });
    const e = store.link(a.id, b.id, "knows", "", { from: "2026-01-01" }); // v3 columns work
    expect(e.validFrom).toBe("2026-01-01T00:00:00.000Z");
    const c = store.createNode({ type: "person", title: "Scheduled", when: "2026-08-01", origin: "o" });
    expect(c.when).toBe("2026-08-01T00:00:00.000Z"); // v4 column works
  });
});

describe("memory history (Phase B, I16)", () => {
  test("the three capture moments, attributed, replayed oldest-first", () => {
    store.registerType({ name: "memory", bornStatus: "proposed" });
    // moment 1: updateNode on an owner-authored node
    const n = store.createNode({ type: "person", title: "Ana", body: "v1", props: { a: 1 }, origin: "o" });
    store.updateNode(n.id, { body: "v2", props: { b: 2 } });
    const h1 = store.history(n.id);
    expect(h1).toHaveLength(1);
    expect(h1[0]?.body).toBe("v1"); // the PRE-change content
    expect(h1[0]?.props).toEqual({ a: 1 }); // props roundtrip
    expect(h1[0]?.actor).toBe("owner");
    expect(h1[0]?.action).toBe("node.update");

    // moments 2 + 3: the consent verdicts
    const p = store.propose({ type: "memory", title: "Dog fact", body: "a retriever", origin: "turn:t1" });
    store.decide(p.node.id, { kind: "approve_edited", fields: { body: "a retriever, 4yo" } });
    store.proposeEdit(p.node.id, { fields: { body: "a retriever, 5yo" }, origin: "turn:e2" });
    store.decide(p.node.id, { kind: "approve" });
    const h2 = store.history(p.node.id);
    expect(h2.map((s) => s.body)).toEqual(["a retriever", "a retriever, 4yo"]); // oldest first
    expect(h2.map((s) => s.action)).toEqual(["consent.approve_edited", "consent.edit_applied"]);
    expect(h2.map((s) => s.origin)).toEqual(["", "turn:e2"]); // the envelope's provenance rides
    expect(h2.map((s) => s.seq)).toEqual([1, 2]);
  });

  test("non-moments never snapshot: birth, transitions, touch, surfacing, merge, reject", () => {
    store.registerType({ name: "memory", bornStatus: "proposed" });
    const n = store.createNode({ type: "person", title: "Quiet Life", origin: "o" });
    store.touch(n.id);
    store.setSurfacing(n.id, "ask");
    store.transition(n.id, "archived");
    store.transition(n.id, "active");
    expect(store.history(n.id)).toHaveLength(0);

    const p = store.propose({ type: "memory", title: "Rejected fact", body: "x", origin: "t" });
    store.decide(p.node.id, { kind: "reject" }); // no content changed
    expect(store.history(p.node.id)).toHaveLength(0);

    const keep = store.createNode({ type: "person", title: "Keeper H", origin: "o" });
    const dup = store.createNode({ type: "person", title: "keeper h", origin: "o" });
    store.decideIdentity(keep.id, dup.id, "same"); // both contents preserved in place
    expect(store.history(keep.id)).toHaveLength(0);
    expect(store.history(dup.id)).toHaveLength(0); // the husk IS the history
  });

  test("a refused edit snapshots nothing — validation precedes capture", () => {
    store.registerType({
      name: "gauge",
      bornStatus: "proposed",
      propsSchema: { amount: { type: "number", required: true } },
    });
    const p = store.propose({ type: "gauge", title: "G", body: "", props: { amount: 1 }, origin: "t" });
    expect(() =>
      store.decide(p.node.id, { kind: "approve_edited", fields: { amount: "not-a-number" } }),
    ).toThrow(MemoryError);
    expect(store.history(p.node.id)).toHaveLength(0); // nothing changed, nothing captured
  });

  test("forget scrubs history and keeps audit; history stays id-gated", () => {
    const n = store.createNode({ type: "person", title: "Gone Soon", body: "v1", origin: "o" });
    store.updateNode(n.id, { body: "v2" });
    store.setSurfacing(n.id, "never");
    expect(store.history(n.id)).toHaveLength(1); // id-gated like getNode — never-surfaced readable

    store.forget(n.id);
    expect(store.history(n.id)).toHaveLength(0); // I16: history died with the tombstone
    const db = new Database(join(dir, "memory.db"), { readonly: true });
    const hist = db.query("SELECT COUNT(*) AS c FROM memory_history WHERE node_id = ?").get(n.id) as {
      c: number;
    };
    const auditRows = db
      .query("SELECT COUNT(*) AS c FROM audit_log WHERE ref = ? AND action = 'node.update'")
      .get(n.id) as { c: number };
    db.close();
    expect(hist.c).toBe(0);
    expect(auditRows.c).toBe(1); // the content-free record survives

    expect(() =>
      store.history("01hzzzzzzzzzzzzzzzzzzzzzzz" as unknown as Parameters<Store["history"]>[0]),
    ).toThrow("no node");
  });
});
