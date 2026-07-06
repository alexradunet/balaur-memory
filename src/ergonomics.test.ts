import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
  dir = mkdtempSync(join(tmpdir(), "bm-ergo-"));
  tick = 0;
  store = Store.open({ dir, now });
  store.registerType({ name: "note", bornStatus: "active" });
  store.registerType({ name: "task", bornStatus: "proposed" });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("propsPatch (G3)", () => {
  test("merges shallowly, null removes a key, siblings survive, schema still validates", () => {
    const n = store.createNode({
      type: "note",
      title: "Task-ish",
      props: { priority: "high", estimate: 3 },
      origin: "o",
    });
    const patched = store.updateNode(n.id, { propsPatch: { outcome: "done" } });
    expect(patched.props).toEqual({ priority: "high", estimate: 3, outcome: "done" }); // no clobber
    const removed = store.updateNode(n.id, { propsPatch: { estimate: null } });
    expect(removed.props).toEqual({ priority: "high", outcome: "done" }); // null removes

    expect(() => store.updateNode(n.id, { props: { a: 1 }, propsPatch: { b: 2 } })).toThrow("not both");

    store.registerType({
      name: "gauge",
      bornStatus: "active",
      propsSchema: { amount: { type: "number", required: true } },
    });
    const g = store.createNode({ type: "gauge", title: "G", props: { amount: 1 }, origin: "o" });
    expect(() => store.updateNode(g.id, { propsPatch: { amount: "nope" } })).toThrow("must be a number");
    expect(() => store.updateNode(g.id, { propsPatch: { amount: null } })).toThrow("required"); // cannot remove a required prop
  });

  test("history snapshots the pre-patch props", () => {
    const n = store.createNode({ type: "note", title: "P", props: { a: 1 }, origin: "o" });
    store.updateNode(n.id, { propsPatch: { b: 2 } });
    expect(store.history(n.id)[0]?.props).toEqual({ a: 1 });
  });
});

describe("episode (G1)", () => {
  test("the lived-past window: created order, half-open, day-safe, I2", () => {
    const a = store.createNode({ type: "note", title: "Morning thought", origin: "o" });
    store.createNode({ type: "note", title: "Ask me", surfacing: "ask", origin: "o" });
    store.createNode({ type: "note", title: "Never me", surfacing: "never", origin: "o" });
    store.propose({ type: "task", title: "Still proposed", body: "", origin: "t" });
    const b = store.createNode({ type: "note", title: "Evening thought", origin: "o" });
    const arch = store.createNode({ type: "note", title: "Archived thought", origin: "o" });
    store.transition(arch.id, "archived");

    const day = store.episode("2026-07-05", "2026-07-06");
    expect(day.map((n) => n.title)).toEqual(["Morning thought", "Evening thought"]); // order + filters
    expect(day.map((n) => n.type)).not.toContain("day"); // plumbing out
    expect(store.episode("2026-07-06", "2026-07-07")).toEqual([]); // outside the window
    expect(store.episode("2026-07-05", "2026-07-06", { type: "day" }).length).toBeGreaterThan(0); // explicit type reaches anchors
    expect(store.episode("2026-07-05", "2026-07-06", { limit: 1 }).map((n) => n.id)).toEqual([a.id]);
    expect(b.id).not.toBe(a.id);

    expect(() => store.episode("2026-07-06", "2026-07-05")).toThrow("after");
    expect(() => store.episode("whenever", "2026-07-06")).toThrow("ISO-8601");
    expect(() => store.episode("2026-07-05", "2026-07-06", { limit: 0 })).toThrow("positive");
  });

  test("a pure read: walking a month creates no day nodes", () => {
    store.createNode({ type: "note", title: "One entry", origin: "o" });
    const before = store.episode("2026-07-01", "2026-08-01", { type: "day" }).length;
    store.episode("2026-07-01", "2026-08-01");
    store.episode("2026-06-01", "2026-07-01"); // an empty month
    const after = store.episode("2026-07-01", "2026-08-01", { type: "day" }).length;
    expect(after).toBe(before); // no side-effect day creation (the dayAnchor-walk trap, closed)
  });
});

describe("children (G2)", () => {
  test("stated statuses: done steps count toward progress when asked", () => {
    store.registerType({ name: "project", bornStatus: "active" });
    const proj = store.createNode({ type: "project", title: "Trip", origin: "o" });
    const t1 = store.createNode({ type: "task", title: "Book hotel", origin: "o" });
    const t2 = store.createNode({ type: "task", title: "Pack bags", origin: "o" });
    const t3 = store.createNode({ type: "task", title: "Hidden step", surfacing: "never", origin: "o" });
    store.link(t1.id, proj.id, "part_of");
    store.link(t2.id, proj.id, "part_of");
    store.link(t3.id, proj.id, "part_of");
    store.link(proj.id, t2.id, "tracks"); // outgoing from proj — must NOT count (direction)
    store.transition(t1.id, "archived"); // done

    expect(store.children(proj.id, "part_of").map((n) => n.title)).toEqual(["Pack bags"]); // default active
    const all = store.children(proj.id, "part_of", { statuses: ["active", "archived"] });
    expect(all.map((n) => n.title)).toEqual(["Book hotel", "Pack bags"]); // progress 1/2 derivable
    expect(all.map((n) => n.id)).not.toContain(t3.id); // never stays invisible (I2)

    expect(() => store.children(proj.id, " ")).toThrow("required");
    expect(() => store.children(proj.id, "part_of", { statuses: [] })).toThrow("empty");
    expect(() => store.children(proj.id, "part_of", { statuses: ["done" as unknown as "active"] })).toThrow(
      "unknown status",
    );
  });

  test("validity windows apply, with asOf time travel", () => {
    store.registerType({ name: "project", bornStatus: "active" });
    const proj = store.createNode({ type: "project", title: "Team", origin: "o" });
    const old = store.createNode({ type: "note", title: "Former member", origin: "o" });
    const e = store.link(old.id, proj.id, "member_of", "", { from: "2020-01-01" });
    store.closeEdge(e.id, "2024-01-01");
    const cur = store.createNode({ type: "note", title: "Current member", origin: "o" });
    store.link(cur.id, proj.id, "member_of", "", { from: "2024-02-01" });

    expect(store.children(proj.id, "member_of").map((n) => n.title)).toEqual(["Current member"]);
    expect(
      store.children(proj.id, "member_of", { asOf: "2022-06-01T00:00:00.000Z" }).map((n) => n.title),
    ).toEqual(["Former member"]);
  });
});

describe("the owner fast path on gated types (G7)", () => {
  test("snooze is one call; done-with-outcome is two; agents still route through the queue", () => {
    const t = store.createNode({ type: "task", title: "Call Ana", when: "2026-07-08", origin: "o" });
    // snooze: ONE call, no queue theater
    const snoozed = store.updateNode(t.id, { when: "2026-07-10T09:00:00.000Z" });
    expect(snoozed.when).toBe("2026-07-10T09:00:00.000Z");
    expect(store.pendingQueue()).toHaveLength(0); // nothing entered the queue
    // done with outcome: TWO calls
    store.updateNode(t.id, { propsPatch: { outcome: "done" } });
    expect(store.transition(t.id, "archived").status).toBe("archived");
    // the record is intact: both moves captured, audited
    expect(store.history(t.id).map((s) => s.action)).toEqual(["node.update", "node.update"]);
    // the agent path is unchanged: propose still gated, proposeEdit still parks
    const p = store.propose({ type: "task", title: "Agent idea", body: "", origin: "turn:t" });
    expect(p.node.status).toBe("proposed");
  });
});
