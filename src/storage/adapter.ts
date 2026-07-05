/**
 * The storage seam (ADR-0001 guardrail 2): the minimal SQL surface the rest
 * of the library consumes. Exactly one file implements it with bun:sqlite
 * (./bun.ts); porting to node:sqlite or better-sqlite3 is one new
 * implementation of this interface plus a conformance run.
 */

export type SqlValue = string | number | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

export interface SqlDb {
  /** Run DDL / pragmas (no parameters, may contain multiple statements). */
  exec(sql: string): void;
  /** All rows. */
  query<T extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]): T[];
  /** First row or null. */
  get<T extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]): T | null;
  /** Execute a statement; returns affected-row count. */
  run(sql: string, params?: readonly SqlValue[]): { changes: number };
  /** Run fn atomically; nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

/** Opens a database file, creating it if absent. */
export type OpenDb = (path: string) => SqlDb;
