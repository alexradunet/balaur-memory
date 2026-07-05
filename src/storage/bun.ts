/**
 * The ONLY file in the library allowed to import bun:sqlite (ADR-0001,
 * AGENTS.md). Everything else consumes the SqlDb adapter.
 */

import { Database } from "bun:sqlite";
import type { OpenDb, SqlDb, SqlRow, SqlValue } from "./adapter.ts";

export const openBunDb: OpenDb = (path: string): SqlDb => {
  const db = new Database(path, { create: true });
  let depth = 0;
  return {
    exec(sql) {
      db.exec(sql);
    },
    query<T extends SqlRow = SqlRow>(sql: string, params: readonly SqlValue[] = []): T[] {
      return db.query(sql).all(...(params as SqlValue[])) as T[];
    },
    get<T extends SqlRow = SqlRow>(sql: string, params: readonly SqlValue[] = []): T | null {
      return (db.query(sql).get(...(params as SqlValue[])) as T | null) ?? null;
    },
    run(sql, params = []) {
      const res = db.query(sql).run(...(params as SqlValue[]));
      return { changes: Number(res.changes) };
    },
    transaction<T>(fn: () => T): T {
      // bun:sqlite's Database.transaction would BEGIN unconditionally; guard
      // so nested library calls join the outer transaction instead of erroring.
      if (depth > 0) return fn();
      depth++;
      try {
        return db.transaction(fn)();
      } finally {
        depth--;
      }
    },
    close() {
      db.close();
    },
  };
};
