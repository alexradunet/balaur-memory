/**
 * The Store façade — the single class in the library (CODING.md). Phase 1
 * exposes the spine surface; consent (Phase 3), recall (Phase 2), lifecycle
 * verbs (Phase 4), lineage and doctor (Phase 5) complete StoreContract.
 * Until then Store deliberately does NOT declare `implements StoreContract`.
 */

import { join } from "node:path";
import { rebuildFts } from "./indexdb/fts.ts";
import * as spine from "./spine.ts";
import type { OpenDb } from "./storage/adapter.ts";
import { openBunDb } from "./storage/bun.ts";
import { migrateIndexDb, migrateMemoryDb } from "./storage/schema.ts";
import type { Edge, Props } from "./types.ts";
import {
  MemoryError,
  type Node,
  type NodeId,
  type NodeTypeSpec,
  type Status,
  type Surfacing,
} from "./types.ts";

export interface StoreOptions {
  /** Directory holding memory.db and index.db (created if absent). */
  readonly dir: string;
  /** Injectable clock — tests never sleep (CODING.md). */
  readonly now?: () => Date;
  /** Storage backend override; defaults to bun:sqlite. */
  readonly openDb?: OpenDb;
}

export class Store {
  private readonly ctx: spine.Ctx;
  private open_ = true;

  private constructor(ctx: spine.Ctx) {
    this.ctx = ctx;
  }

  static open(opts: StoreOptions): Store {
    const now = opts.now ?? (() => new Date());
    const openDb = opts.openDb ?? openBunDb;
    const mem = openDb(join(opts.dir, "memory.db"));
    const idx = openDb(join(opts.dir, "index.db"));
    migrateMemoryDb(mem, now);
    migrateIndexDb(idx);
    const store = new Store({ mem, idx, now });
    // Built-in episodic anchor type: every node links on_day to its creation
    // day (SCHEMA.md system edges). Hosts register their own types on top.
    mem.run(
      `INSERT INTO node_types (name, born_status, props_schema, template, created)
       VALUES ('day', 'active', ?, '{}', ?) ON CONFLICT(name) DO NOTHING`,
      [JSON.stringify({ date: { type: "string", required: true } }), now().toISOString()],
    );
    return store;
  }

  close(): void {
    this.open_ = false;
    this.ctx.mem.close();
    this.ctx.idx.close();
  }

  private guard(): spine.Ctx {
    if (!this.open_) throw new MemoryError("store_closed", "store is closed");
    return this.ctx;
  }

  // --- the spine ---

  registerType(spec: NodeTypeSpec): void {
    spine.registerType(this.guard(), spec);
  }

  createNode(input: spine.CreateInput): Node {
    return spine.createNode(this.guard(), input);
  }

  getNode(id: NodeId): Node {
    return spine.mustGet(this.guard(), id);
  }

  updateNode(id: NodeId, patch: { title?: string; body?: string; props?: Props }): Node {
    return spine.updateNode(this.guard(), id, patch);
  }

  link(source: NodeId, target: NodeId, type = "links", context = ""): Edge {
    return spine.insertEdge(this.guard(), source, target, type, context, "owner");
  }

  neighborhood(id: NodeId): Node[] {
    return spine.neighborhood(this.guard(), id);
  }

  // --- lifecycle primitives (Phase 1 scope) ---

  transition(id: NodeId, to: Status): Node {
    return spine.transition(this.guard(), id, to);
  }

  setSurfacing(id: NodeId, s: Surfacing): void {
    spine.setSurfacing(this.guard(), id, s);
  }

  touch(id: NodeId): void {
    spine.touch(this.guard(), id);
  }

  // --- index maintenance (I13) ---

  rebuildIndex(): void {
    const ctx = this.guard();
    rebuildFts(ctx.idx, ctx.mem);
  }
}
