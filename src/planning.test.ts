import { Database } from "bun:sqlite";
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
  dir = mkdtempSync(join(tmpdir(), "bm-planning-"));
  tick = 0;
  store = Store.open({ dir, now });
  store.registerType({ name: "note", bornStatus: "active" });
  store.registerType({ name: "task", bornStatus: "proposed" });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the appointment with the future (Phase A, I17)", () => {
  test("when through the write paths: validated, normalized, moved, cleared", () => {
    // createNode: date-only normalizes to midnight UTC
    const n = store.createNode({ type: "note", title: "Dentist", when: "2026-08-01", origin: "o" });
    expect(n.when).toBe("2026-08-01T00:00:00.000Z");
    expect(() => store.createNode({ type: "note", title: "Bad", when: "next tuesday", origin: "o" })).toThrow(
      "ISO-8601",
    );

    // updateNode: undefined = unchanged, string = move, null = clear
    const moved = store.updateNode(n.id, { when: "2026-08-02T10:00:00.000Z" });
    expect(moved.when).toBe("2026-08-02T10:00:00.000Z");
    const untouched = store.updateNode(n.id, { body: "bring the x-rays" });
    expect(untouched.when).toBe("2026-08-02T10:00:00.000Z");
    const cleared = store.updateNode(n.id, { when: null });
    expect(cleared.when).toBeNull();
    expect(() => store.updateNode(n.id, { when: "garbage" })).toThrow("ISO-8601");

    // propose: an agent-proposed appointment, gated like everything else
    const p = store.propose({
      type: "task",
      title: "Book flights",
      body: "",
      when: "2026-07-08",
      origin: "t",
    });
    expect(p.node.when).toBe("2026-07-08T00:00:00.000Z");
    expect(p.node.status).toBe("proposed");
    expect(() =>
      store.propose({ type: "task", title: "Bad when", body: "", when: "whenever", origin: "t" }),
    ).toThrow("ISO-8601");

    // verdict fields: "when" sets, "" clears (via approve_edited)
    const q = store.propose({ type: "task", title: "Dated later", body: "", origin: "t" });
    const dated = store.decide(q.node.id, {
      kind: "approve_edited",
      fields: { when: "2026-07-09T08:00:00.000Z" },
    });
    expect(dated.when).toBe("2026-07-09T08:00:00.000Z");
    store.proposeEdit(q.node.id, { fields: { when: "" }, origin: "t" });
    const undated = store.decide(q.node.id, { kind: "approve" });
    expect(undated.when).toBeNull();
  });

  test("agenda: half-open window, order, type filter, limit, and I2 off the board", () => {
    const at = (title: string, when: string, type = "note") =>
      store.createNode({ type, title, when, origin: "o" });
    at("At from", "2026-07-06T00:00:00.000Z");
    at("Mid week", "2026-07-08T10:00:00.000Z");
    at("At to", "2026-07-13T00:00:00.000Z"); // exactly `to` — excluded (half-open)
    const ask = at("Ask me", "2026-07-07T09:00:00.000Z");
    store.setSurfacing(ask.id, "ask");
    const never = store.createNode({
      type: "note",
      title: "Never me",
      when: "2026-07-07T10:00:00.000Z",
      surfacing: "never",
      origin: "o",
    });
    const archived = at("Archived", "2026-07-09T10:00:00.000Z");
    store.transition(archived.id, "archived");
    store.propose({ type: "task", title: "Still proposed", body: "", when: "2026-07-08", origin: "t" });
    at("Taskish", "2026-07-10T10:00:00.000Z", "task"); // owner-born on the gated type

    const week = store.agenda("2026-07-06", "2026-07-13");
    expect(week.map((n) => n.title)).toEqual(["At from", "Mid week", "Taskish"]);
    expect(never.when).toBe("2026-07-07T10:00:00.000Z"); // stored fine — just never surfaced

    expect(store.agenda("2026-07-06", "2026-07-13", { type: "task" }).map((n) => n.title)).toEqual([
      "Taskish",
    ]);
    expect(store.agenda("2026-07-06", "2026-07-13", { limit: 1 }).map((n) => n.title)).toEqual(["At from"]);
    expect(() => store.agenda("2026-07-13", "2026-07-06")).toThrow("after");
    expect(() => store.agenda("garbage", "2026-07-13")).toThrow("ISO-8601");
    expect(() => store.agenda("2026-07-06", "2026-07-13", { limit: 0 })).toThrow("positive");
  });

  test("doctor dueCandidates: overdue actives oldest-first, capped, never excluded", () => {
    const overdueB = store.createNode({ type: "note", title: "B", when: "2026-07-03", origin: "o" });
    const overdueA = store.createNode({ type: "note", title: "A", when: "2026-07-01", origin: "o" });
    store.createNode({ type: "note", title: "Future", when: "2026-09-01", origin: "o" });
    const hidden = store.createNode({
      type: "note",
      title: "Hidden due",
      when: "2026-07-02",
      surfacing: "never",
      origin: "o",
    });
    const done = store.createNode({ type: "note", title: "Done", when: "2026-07-02", origin: "o" });
    store.transition(done.id, "archived");

    const due = store.doctor().dueCandidates;
    expect(due).toEqual([overdueA.id, overdueB.id]); // oldest-due first
    expect(due).not.toContain(hidden.id);

    for (let i = 0; i < 25; i++)
      store.createNode({ type: "note", title: `O${i}`, when: "2026-06-01", origin: "o" });
    expect(store.doctor().dueCandidates).toHaveLength(20); // the lens cap
  });

  test("dayAnchor: idempotent, timestamp folds to its UTC day, schedulable", () => {
    const d1 = store.dayAnchor("2026-07-14");
    const d2 = store.dayAnchor("2026-07-14");
    const d3 = store.dayAnchor("2026-07-14T18:30:00.000Z");
    expect(d2.id).toBe(d1.id);
    expect(d3.id).toBe(d1.id);
    expect(d1.type).toBe("day");
    expect(d1.props["date"]).toBe("2026-07-14");
    expect(() => store.dayAnchor("someday")).toThrow("ISO-8601");

    const task = store.createNode({ type: "task", title: "Pack bags", when: "2026-07-14", origin: "o" });
    store.link(task.id, d1.id, "scheduled_on");
    const db = new Database(join(dir, "memory.db"), { readonly: true });
    const edge = db
      .query("SELECT COUNT(*) AS c FROM edges WHERE source = ? AND target = ? AND type = 'scheduled_on'")
      .get(task.id, d1.id) as { c: number };
    const days = db
      .query(
        "SELECT COUNT(*) AS c FROM nodes WHERE type = 'day' AND json_extract(props,'$.date') = '2026-07-14'",
      )
      .get() as { c: number };
    db.close();
    expect(edge.c).toBe(1);
    expect(days.c).toBe(1);
  });

  test("history captures the pre-change when; merged_pending keeps the latest when", () => {
    const n = store.createNode({ type: "note", title: "Deadline", when: "2026-07-20", origin: "o" });
    store.updateNode(n.id, { when: "2026-07-25" }); // slipped
    store.updateNode(n.id, { when: "2026-07-30" }); // slipped again
    const whens = store.history(n.id).map((s) => s.when);
    expect(whens).toEqual(["2026-07-20T00:00:00.000Z", "2026-07-25T00:00:00.000Z"]); // the replay

    const p1 = store.propose({
      type: "task",
      title: "Dentist visit",
      body: "",
      when: "2026-08-01",
      origin: "t1",
    });
    const p2 = store.propose({
      type: "task",
      title: "dentist VISIT",
      body: "moved",
      when: "2026-08-03",
      origin: "t2",
    });
    expect(p2.kind).toBe("merged_pending");
    expect(p2.node.id).toBe(p1.node.id);
    expect(p2.node.when).toBe("2026-08-03T00:00:00.000Z"); // latest wins
  });
});
