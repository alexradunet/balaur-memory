/**
 * The conformance runner (docs/CONFORMANCE.md): executes *.scenario.json
 * against the PUBLIC API plus raw SQLite reads — never src/ internals beyond
 * the entry point. Any implementation of the schema contract can reimplement
 * this file and run the same scenarios.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Node, NodeId } from "../../src/index.ts";
import { Store } from "../../src/index.ts";

interface Scenario {
  name: string;
  invariants: string[];
  clock: string;
  steps: Step[];
  expect: Expect[];
}

type Step = {
  op: string;
  as?: string;
  advanceMs?: number;
  expectError?: string;
  [key: string]: unknown;
};

interface RecallSpec {
  terms?: string[];
  type?: string;
  limit?: number;
  model?: string;
  queryVector?: number[];
}

type Expect =
  | { bound: string; equals?: unknown; matches?: string }
  | { sql: string; params?: unknown[]; equals: unknown }
  | { recall: RecallSpec; titles?: string[]; titlesInOrder?: string[] }
  | { outcome: string; equals: string }
  | { conflicts: string; reasons: string[] }
  | { report: string; path: string; equals?: unknown; length?: number; contains?: string }
  | { sqlIndex: string; params?: unknown[]; equals: unknown }
  | { neighborhood: string; titlesEqual: string[] };

const DIR = join(import.meta.dir);

function resolveRef(bindings: Map<string, Node>, ref: string): unknown {
  if (!ref.startsWith("@")) return ref;
  const [name, field] = ref.slice(1).split(".");
  const node = bindings.get(name ?? "");
  if (!node) throw new Error(`unbound ref ${ref}`);
  return field ? (node as unknown as Record<string, unknown>)[field] : node;
}

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".scenario.json"))) {
  const scenario = (await Bun.file(join(DIR, file)).json()) as Scenario;

  describe(`conformance ${scenario.invariants.join(",")}`, () => {
    test(scenario.name, () => {
      const dir = mkdtempSync(join(tmpdir(), "bm-conf-"));
      let t = Date.parse(scenario.clock);
      let store = Store.open({ dir, now: () => new Date(++t) });
      const bindings = new Map<string, Node>();
      const outcomes = new Map<string, string>();
      const reports = new Map<string, Record<string, unknown>>();

      try {
        for (const step of scenario.steps) {
          if (step.advanceMs) t += step.advanceMs;
          const run = () => {
            switch (step.op) {
              case "registerType":
                store.registerType({
                  name: step["name"] as string,
                  bornStatus: step["bornStatus"] as "active" | "proposed",
                });
                return undefined;
              case "createNode":
                return store.createNode(step["input"] as Parameters<Store["createNode"]>[0]);
              case "link":
                store.link(
                  (resolveRef(bindings, step["source"] as string) as Node["id"]) ?? ("" as NodeId),
                  resolveRef(bindings, step["target"] as string) as Node["id"],
                );
                return undefined;
              case "transition":
                return store.transition(
                  resolveRef(bindings, step["id"] as string) as Node["id"],
                  step["to"] as Parameters<Store["transition"]>[1],
                );
              case "touch":
                store.touch(resolveRef(bindings, step["id"] as string) as Node["id"]);
                return undefined;
              case "setSurfacing":
                store.setSurfacing(
                  resolveRef(bindings, step["id"] as string) as Node["id"],
                  step["to"] as Parameters<Store["setSurfacing"]>[1],
                );
                return undefined;
              case "propose": {
                const o = store.propose(step["proposal"] as Parameters<Store["propose"]>[0]);
                if (step.as) outcomes.set(step.as, o.kind);
                return o.node;
              }
              case "proposeEdit":
                store.proposeEdit(
                  resolveRef(bindings, step["id"] as string) as Node["id"],
                  step["change"] as Parameters<Store["proposeEdit"]>[1],
                );
                return undefined;
              case "decide": {
                const raw = step["decision"] as {
                  kind: string;
                  supersedes?: string;
                  fields?: Record<string, string>;
                };
                const decision =
                  raw.supersedes !== undefined
                    ? { ...raw, supersedes: resolveRef(bindings, raw.supersedes) }
                    : raw;
                return store.decide(
                  resolveRef(bindings, step["id"] as string) as Node["id"],
                  decision as Parameters<Store["decide"]>[1],
                );
              }
              case "suggestIdentities": {
                const n = store.suggestIdentities(step["type"] as string, step["cap"] as number | undefined);
                if (step.as) outcomes.set(step.as, String(n));
                return undefined;
              }
              case "decideIdentity":
                return store.decideIdentity(
                  resolveRef(bindings, step["keep"] as string) as Node["id"],
                  resolveRef(bindings, step["other"] as string) as Node["id"],
                  step["verdict"] as "same" | "different",
                );
              case "addAlias":
                store.addAlias(
                  resolveRef(bindings, step["id"] as string) as Node["id"],
                  step["alias"] as string,
                );
                return undefined;
              case "putVector":
                store.putVector(
                  resolveRef(bindings, step["id"] as string) as Node["id"],
                  step["model"] as string,
                  new Float32Array(step["vec"] as number[]),
                );
                return undefined;
              case "quarantine":
                store.quarantine(
                  resolveRef(bindings, step["id"] as string) as Node["id"],
                  step["reviewAt"] as string | undefined,
                );
                return undefined;
              case "forget": {
                const rep = store.forget(resolveRef(bindings, step["id"] as string) as Node["id"]);
                if (step.as) reports.set(step.as, rep as unknown as Record<string, unknown>);
                return undefined;
              }
              case "recordDerivation":
                store.recordDerivation(
                  step["artifact"] as string,
                  (step["sources"] as string[]).map((s) =>
                    s.startsWith("@") ? (resolveRef(bindings, s) as string) : s,
                  ),
                );
                return undefined;
              case "rebuildIndex":
                store.rebuildIndex();
                return undefined;
              case "reopenWithoutIndex":
                store.close();
                rmSync(join(dir, "index.db"), { force: true });
                store = Store.open({ dir, now: () => new Date(++t) });
                return undefined;
              default:
                throw new Error(`unknown op ${step.op}`);
            }
          };

          if (step.expectError !== undefined) {
            expect(run).toThrow();
          } else {
            const result = run();
            if (step.as && result) bindings.set(step.as, result as Node);
          }
        }

        const mem = new Database(join(dir, "memory.db"), { readonly: true });
        try {
          for (const ex of scenario.expect) {
            if ("bound" in ex) {
              const value = resolveRef(bindings, `@${ex.bound}`);
              if (ex.matches !== undefined) expect(String(value)).toMatch(new RegExp(ex.matches));
              else expect(value).toEqual(ex.equals);
            } else if ("sql" in ex) {
              const params = (ex.params ?? []).map((p) =>
                typeof p === "string" && p.startsWith("@") ? resolveRef(bindings, p) : p,
              );
              const row = mem.query(ex.sql).get(...(params as (string | number)[])) as Record<
                string,
                unknown
              > | null;
              const first = row === null ? null : Object.values(row)[0];
              expect(first).toEqual(ex.equals);
            } else if ("outcome" in ex) {
              expect(outcomes.get(ex.outcome)).toBe(ex.equals);
            } else if ("report" in ex) {
              const rep = reports.get(ex.report);
              if (!rep) throw new Error(`unbound report ${ex.report}`);
              const value = rep[ex.path];
              if (ex.equals !== undefined) expect(value).toEqual(ex.equals);
              if (ex.length !== undefined) expect((value as unknown[]).length).toBe(ex.length);
              if (ex.contains !== undefined) expect(value as string[]).toContain(ex.contains);
            } else if ("sqlIndex" in ex) {
              const idxDb = new Database(join(dir, "index.db"), { readonly: true });
              try {
                const params = (ex.params ?? []).map((p) =>
                  typeof p === "string" && p.startsWith("@") ? resolveRef(bindings, p) : p,
                );
                const row = idxDb.query(ex.sqlIndex).get(...(params as (string | number)[])) as Record<
                  string,
                  unknown
                > | null;
                const first = row === null ? null : Object.values(row)[0];
                expect(first).toEqual(ex.equals);
              } finally {
                idxDb.close();
              }
            } else if ("conflicts" in ex) {
              const node = bindings.get(ex.conflicts);
              if (!node) throw new Error(`unbound ${ex.conflicts}`);
              const reasons: string[] = store.conflictsFor(node.id).map((c) => c.reason);
              reasons.sort();
              expect(reasons).toEqual([...ex.reasons].sort());
            } else if ("recall" in ex) {
              const spec = ex.recall;
              const got = store
                .recall(spec.terms ?? [], {
                  ...(spec.type !== undefined ? { type: spec.type } : {}),
                  ...(spec.limit !== undefined ? { limit: spec.limit } : {}),
                  ...(spec.model !== undefined ? { model: spec.model } : {}),
                  ...(spec.queryVector !== undefined
                    ? { queryVector: new Float32Array(spec.queryVector) }
                    : {}),
                })
                .map((n) => n.title);
              if (ex.titlesInOrder !== undefined) expect(got).toEqual(ex.titlesInOrder);
              if (ex.titles !== undefined) expect([...got].sort()).toEqual([...ex.titles].sort());
            } else {
              const node = bindings.get(ex.neighborhood);
              if (!node) throw new Error(`unbound ${ex.neighborhood}`);
              const titles = store
                .neighborhood(node.id)
                .map((n) => n.title)
                .sort();
              expect(titles).toEqual([...ex.titlesEqual].sort());
            }
          }
        } finally {
          mem.close();
        }
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}
