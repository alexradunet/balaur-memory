import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cosine } from "./indexdb/vectors.ts";
import { termsFromText } from "./recall.ts";
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
  dir = mkdtempSync(join(tmpdir(), "bm-recall-"));
  tick = 0;
  store = Store.open({ dir, now });
  store.registerType({ name: "note", bornStatus: "active" });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("termsFromText", () => {
  test("drops stopwords in both languages, keeps salient tokens", () => {
    const t = termsFromText("tell me everything about the marathon training");
    expect(t).toContain("marathon");
    expect(t).toContain("training");
    expect(t).not.toContain("everything");
    expect(t).not.toContain("about");
    const ro = termsFromText("vreau ceva despre alergare maine");
    expect(ro).toContain("alergare");
    expect(ro).not.toContain("despre");
  });

  test("proper nouns are kept even when short, first word is not a proper noun", () => {
    const t = termsFromText("I met Ana at the Q3 review");
    expect(t).toContain("Ana");
    expect(t).toContain("Q3");
    expect(t[0]).toBe("Ana"); // proper nouns rank first
    expect(termsFromText("Tomorrow we ride")).not.toContain("Tomorrow");
  });

  test("carries up to two terms from the prior turn, deduped, capped at six", () => {
    const t = termsFromText("should I call her back", ["how is my sister Ana doing after Brasov"]);
    expect(t).toContain("call");
    expect(t).toContain("Ana"); // carryover
    expect(t.length).toBeLessThanOrEqual(6);
    const dedup = termsFromText("Ana called again", ["Ana said hello"]);
    expect(dedup.filter((x) => x.toLowerCase() === "ana")).toHaveLength(1);
  });
});

describe("recall: I2 surfacing semantics", () => {
  test("ambient recall = active + always; ask only when the title is named; never unreachable", () => {
    store.createNode({ type: "note", title: "Alpine trip", body: "the zaffre mountains", origin: "t" });
    const ask = store.createNode({ type: "note", title: "Zaffre ledger", body: "numbers", origin: "t" });
    store.setSurfacing(ask.id, "ask");
    const askHidden = store.createNode({
      type: "note",
      title: "Hidden thing",
      body: "zaffre secrets",
      origin: "t",
    });
    store.setSurfacing(askHidden.id, "ask");
    const never = store.createNode({ type: "note", title: "Zaffre vault", body: "zaffre", origin: "t" });
    store.setSurfacing(never.id, "never");
    const archived = store.createNode({ type: "note", title: "Old zaffre", body: "zaffre", origin: "t" });
    store.transition(archived.id, "archived");

    const titles = store.recall(["zaffre"]).map((n) => n.title);
    expect(titles).toContain("Alpine trip");
    expect(titles).toContain("Zaffre ledger"); // ask, named in title
    expect(titles).not.toContain("Hidden thing"); // ask, body-only match
    expect(titles).not.toContain("Zaffre vault"); // never
    expect(titles).not.toContain("Old zaffre"); // archived
  });

  test("type filter narrows recall; search is cross-type", () => {
    store.registerType({ name: "person", bornStatus: "active" });
    store.createNode({ type: "note", title: "Vermeil note", origin: "t" });
    store.createNode({ type: "person", title: "Vermeil person", origin: "t" });
    expect(store.recall(["vermeil"], { type: "person" }).map((n) => n.title)).toEqual(["Vermeil person"]);
    expect(
      store
        .search(["vermeil"])
        .map((n) => n.title)
        .sort(),
    ).toEqual(["Vermeil note", "Vermeil person"]);
  });
});

describe("recall: the ranking blend", () => {
  test("reinforcement + freshness outrank a dormant equal match", () => {
    const a = store.createNode({ type: "note", title: "Cobalt plan A", body: "cobalt", origin: "t" });
    const b = store.createNode({ type: "note", title: "Cobalt plan B", body: "cobalt", origin: "t" });
    days(120);
    store.touch(b.id);
    store.touch(b.id);
    store.touch(b.id);
    const titles = store.recall(["cobalt"]).map((n) => n.title);
    expect(titles[0]).toBe("Cobalt plan B");
    expect(titles).toContain("Cobalt plan A"); // decayed, never erased (floor)
    expect(a.id).not.toBe(b.id);
  });

  test("importance boosts and slows decay", () => {
    store.createNode({ type: "note", title: "Umber low", body: "umber", origin: "t", importance: 0 });
    store.createNode({ type: "note", title: "Umber high", body: "umber", origin: "t", importance: 5 });
    days(200);
    const titles = store.recall(["umber"]).map((n) => n.title);
    expect(titles[0]).toBe("Umber high");
  });
});

describe("recall: vector fusion (vectors in, never models)", () => {
  const model = "test-embed-v1";
  const vec = (...xs: number[]) => new Float32Array(xs);

  test("cosine known answers", () => {
    expect(cosine(vec(1, 0), vec(1, 0))).toBeCloseTo(1);
    expect(cosine(vec(1, 0), vec(0, 1))).toBeCloseTo(0);
    expect(cosine(vec(1, 0), vec(-1, 0))).toBeCloseTo(-1);
    expect(cosine(vec(1, 0), vec(1, 0, 0))).toBeNull(); // dim mismatch
    expect(cosine(vec(0, 0), vec(1, 0))).toBeNull(); // zero vector
  });

  test("a query vector pulls in semantic matches the terms missed; RRF fuses", () => {
    const lex = store.createNode({ type: "note", title: "Sepia journal", body: "sepia", origin: "t" });
    const sem = store.createNode({
      type: "note",
      title: "Burnout week",
      body: "exhausted after launch",
      origin: "t",
    });
    store.putVector(lex.id, model, vec(1, 0, 0));
    store.putVector(sem.id, model, vec(0.1, 0.99, 0));
    const titles = store.recall(["sepia"], { queryVector: vec(0, 1, 0), model }).map((n) => n.title);
    expect(titles).toContain("Sepia journal"); // lexical hit
    expect(titles).toContain("Burnout week"); // vector-only hit
  });

  test("vector spaces never mix, and ask nodes are not vector-reachable (I2)", () => {
    const other = store.createNode({ type: "note", title: "Other space", body: "x", origin: "t" });
    store.putVector(other.id, "different-model", vec(0, 1, 0));
    const ask = store.createNode({ type: "note", title: "Quiet one", body: "y", origin: "t" });
    store.setSurfacing(ask.id, "ask");
    store.putVector(ask.id, model, vec(0, 1, 0));
    const titles = store.recall([], { queryVector: vec(0, 1, 0), model }).map((n) => n.title);
    expect(titles).not.toContain("Other space");
    expect(titles).not.toContain("Quiet one");
  });

  test("deleteVectors clears a space", () => {
    const n = store.createNode({ type: "note", title: "Gone", body: "z", origin: "t" });
    store.putVector(n.id, model, vec(0, 1));
    store.deleteVectors(model);
    expect(store.recall([], { queryVector: vec(0, 1), model })).toHaveLength(0);
  });
});
