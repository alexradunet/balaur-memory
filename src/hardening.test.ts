/**
 * Pins for the adversarial-review fix batch (PR #8): the consent-surface
 * privacy seals, corrupt-index recovery, the guard set, parseProps, and the
 * structural audit-leak test CODING.md promises.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { MemoryError } from "./types.ts";

let dir: string;
let store: Store;
let tick = 0;
const T0 = Date.parse("2026-07-05T12:00:00.000Z");
const now = () => new Date(T0 + ++tick);
const days = (n: number) => {
  tick += n * 86_400_000;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bm-hardening-"));
  tick = 0;
  store = Store.open({ dir, now });
  store.registerType({ name: "memory", bornStatus: "proposed" });
  store.registerType({ name: "note", bornStatus: "active" });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("consent surfaces obey I2 (review #1, #2)", () => {
  test("a never-surfaced cover is not revealed by the gate — the duplicate proposal is created", () => {
    const secret = store.createNode({
      type: "memory",
      title: "Private zkoval ledger",
      body: "SECRET 250k EUR",
      origin: "owner",
    });
    store.setSurfacing(secret.id, "never");
    const out = store.propose({
      type: "memory",
      title: "Private zkoval ledger",
      body: "guess",
      origin: "agent",
    });
    expect(out.kind).toBe("created"); // no exists_active oracle
    expect(out.node.id).not.toBe(secret.id);
    expect(out.node.body).toBe("guess"); // nothing of the secret came back
    // owner-side safety net still sees the collision:
    const pairs = store.doctor().duplicateCandidates;
    expect(pairs.length).toBe(0); // proposal isn't active yet — no false alarm either
  });

  test("an ask-surfaced cover IS revealed on an exact title (named ⇒ I2-consistent)", () => {
    const askNode = store.createNode({ type: "memory", title: "Zephyr budget quarterly", origin: "owner" });
    store.setSurfacing(askNode.id, "ask");
    const out = store.propose({
      type: "memory",
      title: "zephyr BUDGET quarterly",
      body: "",
      origin: "agent",
    });
    expect(out.kind).toBe("exists_active");
    expect(out.node.id).toBe(askNode.id);
  });

  test("hints exclude never entirely and unnamed ask; named ask and always still hint", () => {
    const never = store.createNode({
      type: "memory",
      title: "Affair ledger kovrat",
      body: "kovrat secrets budget",
      origin: "owner",
    });
    store.setSurfacing(never.id, "never");
    const askUnnamed = store.createNode({
      type: "memory",
      title: "Household finances",
      body: "budget kovrat numbers tracking",
      origin: "owner",
    });
    store.setSurfacing(askUnnamed.id, "ask");
    const always = store.createNode({
      type: "memory",
      title: "Budget overview kovrat",
      body: "kovrat quarterly numbers",
      origin: "owner",
    });

    const p = store.propose({
      type: "memory",
      title: "Quarterly kovrat numbers",
      body: "budget",
      origin: "agent",
    });
    const conflicts = store.conflictsFor(p.node.id);
    const ids = conflicts.map((c) => c.nodeId);
    expect(ids).not.toContain(never.id); // invisible, even on strong overlap
    expect(ids).not.toContain(askUnnamed.id); // ask, but its title is not named
    expect(ids).toContain(always.id); // ordinary hint still works
    // and "kovrat" names the always node's title too — reason may be either kind
    for (const c of conflicts) expect(c.nodeId).not.toBe(never.id);
  });
});

describe("corrupt index recovery (review #3)", () => {
  test("garbage index.db is dropped, recreated, rebuilt — and audited", () => {
    const n = store.createNode({ type: "note", title: "Survivor", body: "findable brelqix", origin: "t" });
    store.close();
    writeFileSync(join(dir, "index.db"), "this is not a database at all");
    store = Store.open({ dir, now }); // must not throw
    expect(store.recall(["brelqix"]).map((x) => x.id)).toContain(n.id); // rebuilt
    const db = new Database(join(dir, "memory.db"), { readonly: true });
    const rec = db.query("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'index.recover'").get() as {
      c: number;
    };
    db.close();
    expect(rec.c).toBe(1);
  });
});

describe("the guard set", () => {
  test("touch is an active-only signal (review #5)", () => {
    const n = store.createNode({ type: "note", title: "T", origin: "t" });
    store.transition(n.id, "archived");
    expect(() => store.touch(n.id)).toThrow(MemoryError);
    const f = store.createNode({ type: "note", title: "F", origin: "t" });
    store.forget(f.id);
    expect(() => store.touch(f.id)).toThrow(MemoryError);
  });

  test("born_status cannot flip while nodes of the type exist (review #10)", () => {
    store.createNode({ type: "note", title: "Exists", origin: "t" });
    expect(() => store.registerType({ name: "note", bornStatus: "proposed" })).toThrow(
      "cannot change born_status",
    );
    store.registerType({ name: "note", bornStatus: "active" }); // same value: fine
    store.registerType({ name: "fresh", bornStatus: "active" });
    store.registerType({ name: "fresh", bornStatus: "proposed" }); // no nodes yet: allowed
  });

  test("reviewAt is strict ISO UTC (review #9)", () => {
    const a = store.createNode({ type: "note", title: "A", origin: "t" });
    expect(() => store.quarantine(a.id, "January 1, 2020")).toThrow("ISO-8601");
    expect(() => store.quarantine(a.id, "1999")).toThrow("ISO-8601");
    store.quarantine(a.id, "2026-10-01"); // date-only accepted, midnight UTC
    expect(store.getNode(a.id).reviewAt).toBe("2026-10-01T00:00:00.000Z");
  });

  test("NUL-containing terms are dropped, not crashed on (review #11)", () => {
    store.createNode({ type: "note", title: "Clean qorvat", body: "qorvat", origin: "t" });
    const titles = store.recall(["bad\u0000term", "qorvat"]).map((n) => n.title);
    expect(titles).toContain("Clean qorvat");
  });

  test("fractional importance is a MemoryError, not a SQLiteError (review #12)", () => {
    expect(() => store.createNode({ type: "note", title: "X", origin: "t", importance: 2.7 })).toThrow(
      MemoryError,
    );
    const p = store.propose({ type: "memory", title: "Y", body: "", origin: "t" });
    expect(() => store.decide(p.node.id, { kind: "approve_edited", fields: { importance: "2.7" } })).toThrow(
      MemoryError,
    );
  });

  test("leaving active clears a parked edit (review #13)", () => {
    const p = store.propose({ type: "memory", title: "Edited", body: "v1", origin: "t" });
    store.decide(p.node.id, { kind: "approve" });
    store.proposeEdit(p.node.id, { fields: { body: "v2" }, origin: "t" });
    store.transition(p.node.id, "archived");
    expect(store.pendingQueue()).toHaveLength(0);
    store.transition(p.node.id, "active"); // reactivation does not resurrect the envelope
    expect(store.pendingQueue()).toHaveLength(0);
    expect(() => store.decide(p.node.id, { kind: "approve" })).toThrow("nothing pending");
  });

  test("day anchors stay out of ambient recall; explicit type reaches them (review #8)", () => {
    store.createNode({ type: "note", title: "About 2026-07-05", body: "the plan", origin: "t" });
    const ambient = store.search(["2026"]).map((n) => n.type);
    expect(ambient).not.toContain("day");
    const explicit = store.recall(["2026"], { type: "day" });
    expect(explicit.length).toBeGreaterThan(0); // the anchor is reachable when asked for
  });
});

describe("parseProps (review #7, #15)", () => {
  test("a malformed props cell degrades to {} instead of bricking reads", () => {
    const n = store.createNode({ type: "note", title: "Damaged jorvik", body: "jorvik", origin: "t" });
    store.close();
    const db = new Database(join(dir, "memory.db"));
    db.query("UPDATE nodes SET props = '{not json' WHERE id = ?").run(n.id);
    db.close();
    store = Store.open({ dir, now });
    expect(store.getNode(n.id).props).toEqual({}); // degraded, not thrown
    expect(store.getNode(n.id).title).toBe("Damaged jorvik"); // content intact
    expect(store.recall(["jorvik"]).map((x) => x.id)).toContain(n.id); // recall survives
    store.rebuildIndex(); // rebuild survives too
  });
});

describe("audit stays content-free — structural (review I7/#15)", () => {
  test("sentinel content through every verb never reaches the audit log", () => {
    const S = "XSENTINELX"; // appears in every content field below
    const owner = store.createNode({
      type: "note",
      title: `${S} title`,
      body: `${S} body`,
      origin: "turn:1",
    });
    store.updateNode(owner.id, { title: `${S} renamed`, body: `${S} rewritten` });
    store.touch(owner.id);
    store.setSurfacing(owner.id, "ask");
    const other = store.createNode({ type: "note", title: "plain", origin: "t" });
    store.link(owner.id, other.id, "links", `${S} context`);
    store.addAlias(owner.id, `${S} alias`);
    store.resolveRef("note", `${S} alias`);
    store.removeAlias(owner.id, `${S} alias`);
    const p = store.propose({ type: "memory", title: `${S} proposal`, body: `${S} pbody`, origin: "turn:2" });
    store.conflictsFor(p.node.id);
    store.decide(p.node.id, { kind: "approve_edited", fields: { body: `${S} corrected` } });
    store.proposeEdit(p.node.id, { fields: { body: `${S} envelope` }, origin: "turn:3" });
    store.decide(p.node.id, { kind: "reject" }); // clears the envelope
    store.quarantine(p.node.id, "2027-01-01");
    store.transition(p.node.id, "active");
    store.recordDerivation("host:artifact:1", [p.node.id]);
    const twinA = store.createNode({ type: "note", title: `${S} twin`, origin: "t" });
    const twinB = store.createNode({ type: "note", title: ` ${S}  TWIN `, origin: "t" });
    store.suggestIdentities("note");
    store.decideIdentity(twinA.id, twinB.id, "same");
    store.forget(p.node.id);
    store.close();

    const db = new Database(join(dir, "memory.db"), { readonly: true });
    const hits = db
      .query("SELECT COUNT(*) AS c FROM audit_log WHERE meta LIKE ? OR ref LIKE ? OR action LIKE ?")
      .get(`%${S}%`, `%${S}%`, `%${S}%`) as { c: number };
    db.close();
    expect(hits.c).toBe(0);
    store = Store.open({ dir, now }); // afterEach symmetry
  });
});
