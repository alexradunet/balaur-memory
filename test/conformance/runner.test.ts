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

type Expect =
  | { bound: string; equals?: unknown; matches?: string }
  | { sql: string; params?: unknown[]; equals: unknown }
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
      const store = Store.open({ dir, now: () => new Date(++t) });
      const bindings = new Map<string, Node>();

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
