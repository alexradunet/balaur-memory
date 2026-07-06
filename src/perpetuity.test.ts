import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { MemoryError } from "./types.ts";

let dir: string;
let store: Store;
let tick = 0;
const T0 = Date.parse("2026-07-05T12:00:00.000Z");
const now = () => new Date(T0 + ++tick);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bm-perpetuity-"));
  tick = 0;
  store = Store.open({ dir, now });
  store.registerType({ name: "note", bornStatus: "active" });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the perpetuity batch (review-3)", () => {
  test("A1: forget clears when_at — a tombstone keeps no appointment", () => {
    const n = store.createNode({
      type: "note",
      title: "Job interview",
      when: "2026-07-10T15:00:00.000Z",
      origin: "o",
    });
    store.forget(n.id);
    expect(store.getNode(n.id).when).toBeNull();
    const db = new Database(join(dir, "memory.db"), { readonly: true });
    const row = db.query("SELECT when_at FROM nodes WHERE id = ?").get(n.id) as { when_at: string | null };
    db.close();
    expect(row.when_at).toBeNull();
  });

  test("A2: re-linking a CLOSED triple refuses loudly; open triples stay idempotent", () => {
    store.registerType({ name: "org", bornStatus: "active" });
    const ana = store.createNode({ type: "note", title: "Ana", origin: "o" });
    const co = store.createNode({ type: "org", title: "Siemens", origin: "o" });
    const e = store.link(ana.id, co.id, "works_at", "", { from: "2020-01-01" });
    // open triple: idempotent, same edge back
    expect(store.link(ana.id, co.id, "works_at").id).toBe(e.id);
    store.closeEdge(e.id, "2023-06-30");
    // closed triple: no silent stale edge — the rehire cannot be swallowed
    expect(() => store.link(ana.id, co.id, "works_at", "", { from: "2026-01-01" })).toThrow("CLOSED");
    expect(() => store.link(ana.id, co.id, "works_at")).toThrow(MemoryError);
    // a different type between the same nodes is untouched
    expect(store.link(ana.id, co.id, "advises").type).toBe("advises");
  });

  test("A3: a file from the future refuses to open — upgrade the library, never downgrade the file", () => {
    store.close();
    const db = new Database(join(dir, "memory.db"));
    db.run("UPDATE meta SET value = '99' WHERE key = 'schema_version'");
    db.close();
    expect(() => Store.open({ dir, now })).toThrow("upgrade the library");
    // corrupt version strings refuse too
    const db2 = new Database(join(dir, "memory.db"));
    db2.run("UPDATE meta SET value = 'garbage' WHERE key = 'schema_version'");
    db2.close();
    expect(() => Store.open({ dir, now })).toThrow(MemoryError);
    // restore sanity so afterEach close() works
    const db3 = new Database(join(dir, "memory.db"));
    db3.run("UPDATE meta SET value = '4' WHERE key = 'schema_version'");
    db3.close();
    store = Store.open({ dir, now });
  });

  test("A4: the day type is reserved — a host cannot redefine the episodic anchor", () => {
    expect(() => store.registerType({ name: "day", bornStatus: "active" })).toThrow("reserved");
    expect(() => store.registerType({ name: " day ", bornStatus: "proposed" })).toThrow("reserved");
    // the anchor still works
    expect(store.dayAnchor("2026-07-14").type).toBe("day");
  });

  test("A5: dueCandidates excludes day nodes even if one ever carries when_at", () => {
    const day = store.dayAnchor("2026-07-01");
    store.close();
    const db = new Database(join(dir, "memory.db"));
    db.run("UPDATE nodes SET when_at = '2026-07-01T00:00:00.000Z' WHERE id = ?", [day.id]);
    db.close();
    store = Store.open({ dir, now });
    const overdue = store.createNode({ type: "note", title: "Real due", when: "2026-07-02", origin: "o" });
    const due = store.doctor().dueCandidates;
    expect(due).toContain(overdue.id);
    expect(due).not.toContain(day.id);
  });

  test("backup(): VACUUM INTO captures fresh WAL writes; restore + rebuild gives full parity", () => {
    const n = store.createNode({
      type: "note",
      title: "Precious qorvath",
      body: "the fact that must survive",
      origin: "o",
    });
    // the write above sits in the WAL — backup must still capture it
    const dir2 = mkdtempSync(join(tmpdir(), "bm-restore-"));
    const target = join(dir2, "memory.db");
    rmSync(dir2, { recursive: true, force: true });
    mkdirSync(dir2);
    store.backup(target);
    expect(() => store.backup(target)).toThrow("never overwrite"); // refuses existing targets

    const restored = Store.open({ dir: dir2, now });
    restored.rebuildIndex();
    expect(restored.getNode(n.id).body).toBe("the fact that must survive");
    expect(restored.recall(["qorvath"]).map((x) => x.id)).toContain(n.id); // full recall parity
    restored.close();
    rmSync(dir2, { recursive: true, force: true });

    // audited content-free: action recorded, no path in the meta
    const db = new Database(join(dir, "memory.db"), { readonly: true });
    const audit = db.query("SELECT meta FROM audit_log WHERE action = 'store.backup'").all() as {
      meta: string;
    }[];
    db.close();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.meta).toBe("{}");
  });

  test("doctor().integrityOk: the file's own health, true on a healthy store", () => {
    store.createNode({ type: "note", title: "Healthy", origin: "o" });
    expect(store.doctor().integrityOk).toBe(true);
  });
});
