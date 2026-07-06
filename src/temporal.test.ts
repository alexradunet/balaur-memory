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

  test("a v2 store upgrades in place to v3 and keeps its data", () => {
    const a = store.createNode({ type: "person", title: "Upgrader", origin: "o" });
    store.close();
    // wind the schema back to v2: drop the v3 artifacts a fresh store created
    const db = new Database(join(dir, "memory.db"));
    db.run("UPDATE meta SET value = '2' WHERE key = 'schema_version'");
    db.run("DROP TABLE memory_history");
    db.run("ALTER TABLE edges DROP COLUMN valid_from");
    db.run("ALTER TABLE edges DROP COLUMN valid_until");
    db.close();
    store = Store.open({ dir, now }); // migrates 2 → 3
    const db2 = new Database(join(dir, "memory.db"), { readonly: true });
    const v = db2.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
    const hist = db2.query("SELECT COUNT(*) AS c FROM memory_history").get() as { c: number };
    db2.close();
    expect(v.value).toBe("3");
    expect(hist.c).toBe(0);
    expect(store.getNode(a.id).title).toBe("Upgrader"); // data survived
    const b = store.createNode({ type: "person", title: "Post-upgrade", origin: "o" });
    const e = store.link(a.id, b.id, "knows", "", { from: "2026-01-01" }); // new columns work
    expect(e.validFrom).toBe("2026-01-01T00:00:00.000Z");
  });
});
