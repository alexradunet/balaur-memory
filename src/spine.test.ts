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
/** Injected clock: +1ms per call so ulids stay ordered, no sleeping. */
const now = () => new Date(T0 + ++tick);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bm-"));
  tick = 0;
  store = Store.open({ dir, now });
  store.registerType({ name: "note", bornStatus: "active" });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("spine: create/read", () => {
  test("owner writes are born active with provenance and a day anchor", () => {
    const n = store.createNode({ type: "note", title: "Hello", body: "World", origin: "turn:t1" });
    expect(n.status).toBe("active");
    expect(n.surfacing).toBe("always");
    expect(n.origin).toBe("turn:t1");
    expect(store.getNode(n.id).title).toBe("Hello");
    // on_day: the anchor edge exists in the record — but day plumbing
    // stays out of the traversal read (review-2 F2)
    const db = new Database(join(dir, "memory.db"), { readonly: true });
    const onDay = db
      .query("SELECT COUNT(*) AS c FROM edges WHERE source = ? AND type = 'on_day'")
      .get(n.id) as { c: number };
    db.close();
    expect(onDay.c).toBe(1);
    expect(store.neighborhood(n.id).map((x) => x.type)).not.toContain("day");
  });

  test("unknown type and empty title are refused", () => {
    expect(() => store.createNode({ type: "ghost", title: "x", origin: "t" })).toThrow(MemoryError);
    expect(() => store.createNode({ type: "note", title: "  ", origin: "t" })).toThrow("title is required");
  });

  test("templates fill and schemas validate", () => {
    store.registerType({
      name: "person",
      bornStatus: "active",
      propsSchema: { name: { type: "string", required: true }, age: { type: "number" } },
      template: { props: { age: 0 } },
    });
    const p = store.createNode({ type: "person", title: "Ana", props: { name: "Ana" }, origin: "t" });
    expect(p.props["age"]).toBe(0); // template filled
    expect(() => store.createNode({ type: "person", title: "Rex", origin: "t" })).toThrow("required");
    expect(() =>
      store.createNode({ type: "person", title: "Bob", props: { name: "Bob", age: "old" }, origin: "t" }),
    ).toThrow("must be a number");
  });
});

describe("spine: update", () => {
  test("edits active owner-authored nodes in place", () => {
    const n = store.createNode({ type: "note", title: "Draft", origin: "t" });
    const u = store.updateNode(n.id, { title: "Final", body: "done" });
    expect(u.title).toBe("Final");
    expect(u.updated > u.created).toBe(true);
  });

  test("owner edits are direct even on consent-gated types; non-active refused (G7)", () => {
    store.registerType({ name: "memory", bornStatus: "proposed" });
    const m = store.createNode({ type: "memory", title: "Owner-stated fact", origin: "t" }); // owner path: active
    const u = store.updateNode(m.id, { title: "Owner-corrected fact" }); // the host authenticates the owner
    expect(u.title).toBe("Owner-corrected fact");
    expect(store.history(m.id)).toHaveLength(1); // still captured (I16)
    const n = store.createNode({ type: "note", title: "Old", origin: "t" });
    store.transition(n.id, "archived");
    expect(() => store.updateNode(n.id, { title: "x" })).toThrow("not active");
  });
});

describe("spine: edges + traversal", () => {
  test("link is idempotent and neighborhood filters to active (I3)", () => {
    const a = store.createNode({ type: "note", title: "A", origin: "t" });
    const b = store.createNode({ type: "note", title: "B", origin: "t" });
    const c = store.createNode({ type: "note", title: "C", origin: "t" });
    const e1 = store.link(a.id, b.id);
    const e2 = store.link(a.id, b.id);
    expect(e1.id).toBe(e2.id); // idempotent: same edge back
    store.link(a.id, c.id);
    store.transition(c.id, "archived");
    const titles = store
      .neighborhood(a.id)
      .map((n) => n.title)
      .sort();
    expect(titles).toContain("B");
    expect(titles).not.toContain("C");
  });
});

describe("spine: FSM + touch + surfacing", () => {
  test("valid moves work; invalid and guarded targets throw", () => {
    const n = store.createNode({ type: "note", title: "N", origin: "t" });
    store.transition(n.id, "archived");
    store.transition(n.id, "active");
    store.transition(n.id, "quarantined");
    store.transition(n.id, "active");
    expect(() => store.transition(n.id, "rejected")).toThrow(MemoryError); // active -/-> rejected
    expect(() => store.transition(n.id, "forgotten")).toThrow(MemoryError); // only forget() may
    expect(() => store.transition(n.id, "merged")).toThrow(MemoryError); // only decide() may
  });

  test("touch bumps usage without touching updated", () => {
    const n = store.createNode({ type: "note", title: "N", origin: "t" });
    store.touch(n.id);
    const after = store.getNode(n.id);
    expect(after.useCount).toBe(1);
    expect(after.lastUsed).not.toBeNull();
    expect(after.updated).toBe(n.updated);
  });

  test("surfacing is a plain axis write", () => {
    const n = store.createNode({ type: "note", title: "N", origin: "t" });
    store.setSurfacing(n.id, "ask");
    expect(store.getNode(n.id).surfacing).toBe("ask");
  });
});

describe("index discipline (I13) + audit (I7/I12)", () => {
  test("index.db is disposable: delete, reopen, rebuild — rows return", () => {
    const n = store.createNode({ type: "note", title: "Findable", body: "needle", origin: "t" });
    store.close();
    rmSync(join(dir, "index.db"), { force: true });
    store = Store.open({ dir, now });
    store.rebuildIndex();
    const idx = new Database(join(dir, "index.db"));
    const row = idx.query("SELECT COUNT(*) AS c FROM nodes_fts WHERE id = ?").get(n.id) as { c: number };
    idx.close();
    expect(row.c).toBe(1);
  });

  test("audit rows are content-free and cover mutations", () => {
    const n = store.createNode({ type: "note", title: "SecretTitle", origin: "t" });
    store.touch(n.id);
    const mem = new Database(join(dir, "memory.db"));
    const rows = mem.query("SELECT action, ref, meta FROM audit_log").all() as {
      action: string;
      ref: string;
      meta: string;
    }[];
    mem.close();
    expect(rows.map((r) => r.action)).toContain("node.create");
    expect(rows.map((r) => r.action)).toContain("node.touch");
    for (const r of rows) expect(r.meta.includes("SecretTitle")).toBe(false); // I7
  });

  test("a closed store refuses work", () => {
    store.close();
    expect(() => store.getNode("nope" as NodeId)).toThrow("store is closed");
    store = Store.open({ dir, now }); // for afterEach symmetry
  });
});
