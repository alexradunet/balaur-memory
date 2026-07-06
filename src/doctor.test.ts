import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";

let dir: string;
let store: Store;
let tick = 0;
const T0 = Date.parse("2026-07-05T12:00:00.000Z");
const now = () => new Date(T0 + ++tick);
const days = (n: number) => {
  tick += n * 86_400_000;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bm-doctor-"));
  tick = 0;
  store = Store.open({ dir, now });
  store.registerType({ name: "memory", bornStatus: "proposed" });
  store.registerType({ name: "note", bornStatus: "active" });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const activeMem = (title: string, importance = 3) => {
  const p = store.propose({ type: "memory", title, body: "", importance, origin: "t" });
  return store.decide(p.node.id, { kind: "approve" });
};

describe("doctor: counts and rates", () => {
  test("active excludes day plumbing; pending spans proposals and edits; acceptRate from decisions", () => {
    activeMem("Kept one"); // approve
    const rejected = store.propose({ type: "memory", title: "Refused", body: "", origin: "t" });
    store.decide(rejected.node.id, { kind: "reject" });
    store.propose({ type: "memory", title: "Waiting", body: "", origin: "t" });
    const edited = activeMem("Editable");
    store.proposeEdit(edited.id, { fields: { body: "new" }, origin: "t" });

    const r = store.doctor();
    expect(r.activeCount).toBe(2); // Kept one + Editable — day nodes excluded
    expect(r.pendingCount).toBe(2); // one proposal + one parked edit
    expect(r.acceptRate30d).toBeCloseTo(2 / 3); // approve, reject, approve
    expect(r.queueOldestDays).toBe(0); // everything is fresh
  });

  test("acceptRate windows at 30 days and goes null with no decisions", () => {
    expect(store.doctor().acceptRate30d).toBeNull();
    const p = store.propose({ type: "memory", title: "Old decision", body: "", origin: "t" });
    store.decide(p.node.id, { kind: "reject" });
    days(45); // the rejection falls out of the window
    expect(store.doctor().acceptRate30d).toBeNull();
  });
});

describe("doctor: candidates — review lists, never actions", () => {
  test("dead weight = active, never recalled, aged; touch clears it", () => {
    const dormant = activeMem("Dormant fact");
    const used = activeMem("Used fact");
    days(120);
    store.touch(used.id);
    const r = store.doctor();
    expect(r.deadWeightCandidates).toContain(dormant.id);
    expect(r.deadWeightCandidates).not.toContain(used.id);
    // and nothing changed any status — reports never act:
    expect(store.getNode(dormant.id).status).toBe("active");
  });

  test("stale = always-on knowledge gone unused, plus quarantine past its review date", () => {
    const important = activeMem("Core constraint", 5);
    const casual = activeMem("Casual note", 1);
    const hidden = activeMem("Painful thing");
    store.quarantine(hidden.id, new Date(T0 + tick + 10 * 86_400_000).toISOString());
    days(120); // importance-5 unused 120d; review date long passed
    const r = store.doctor();
    expect(r.staleCandidates).toContain(important.id);
    expect(r.staleCandidates).not.toContain(casual.id); // low importance: dead-weight lens, not stale
    expect(r.staleCandidates).toContain(hidden.id); // review due
  });

  test("duplicates the gate could not stop: owner-path same-type normalized titles", () => {
    const a = activeMem("Trains for the marathon");
    const b = store.createNode({ type: "memory", title: "  trains FOR the marathon ", origin: "owner" });
    store.createNode({ type: "note", title: "Trains for the marathon", origin: "owner" }); // other type: not a pair
    const r = store.doctor();
    expect(r.duplicateCandidates).toHaveLength(1);
    const pair = r.duplicateCandidates[0];
    expect([pair?.[0], pair?.[1]].sort()).toEqual([a.id, b.id].sort());
  });

  test("queueOldestDays tracks the oldest waiting item", () => {
    store.propose({ type: "memory", title: "Ancient proposal", body: "", origin: "t" });
    days(14);
    store.propose({ type: "memory", title: "Fresh proposal", body: "", origin: "t" });
    expect(store.doctor().queueOldestDays).toBe(14);
  });
});
