/**
 * The vector sidecar (index.db): host-computed embeddings only — vectors in,
 * never models (ADR-0001). Vectors are keyed by (node id, model identity);
 * different identities never mix. Losing index.db loses vectors too — they
 * are re-suppliable by the host (SCHEMA.md I13), unlike FTS rows which
 * rebuild from memory.db automatically.
 *
 * Encoding: raw float32, platform byte order. Every platform Bun ships on is
 * little-endian; the blob format is declared LE in SCHEMA.md.
 */

import type { SqlDb } from "../storage/adapter.ts";

export function putVector(idx: SqlDb, id: string, model: string, vec: Float32Array): void {
  const bytes = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength).slice();
  idx.run(
    `INSERT INTO vectors (id, model, dim, vec) VALUES (?, ?, ?, ?)
     ON CONFLICT(id, model) DO UPDATE SET dim = excluded.dim, vec = excluded.vec`,
    [id, model, vec.length, bytes],
  );
}

export function deleteVectors(idx: SqlDb, model?: string): void {
  if (model === undefined) idx.run("DELETE FROM vectors");
  else idx.run("DELETE FROM vectors WHERE model = ?", [model]);
}

export function deleteVectorsFor(idx: SqlDb, id: string): void {
  idx.run("DELETE FROM vectors WHERE id = ?", [id]);
}

/** All vectors of one model identity. Brute force is the design: at personal
 * scale (≤100k rows) a full scan + cosine is milliseconds (DESIGN.md). */
export function allVectors(idx: SqlDb, model: string): Map<string, Float32Array> {
  const rows = idx.query<{ id: string; dim: number; vec: Uint8Array }>(
    "SELECT id, dim, vec FROM vectors WHERE model = ?",
    [model],
  );
  const out = new Map<string, Float32Array>();
  for (const r of rows) {
    const bytes = r.vec;
    const floats = new Float32Array(bytes.buffer, bytes.byteOffset, r.dim);
    out.set(r.id, floats.slice());
  }
  return out;
}

/** Cosine similarity; null on dimension mismatch or zero vector (skip, don't rank). */
export function cosine(a: Float32Array, b: Float32Array): number | null {
  if (a.length !== b.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return null;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
