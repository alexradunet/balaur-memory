import { describe, expect, test } from "bun:test";
import { isUlid, ulid } from "./ulid.ts";

describe("ulid", () => {
  test("shape: 26 lowercase crockford chars", () => {
    const id = ulid();
    expect(id).toHaveLength(26);
    expect(isUlid(id)).toBe(true);
    expect(id).toBe(id.toLowerCase());
  });

  test("lexical order follows time across milliseconds", () => {
    const a = ulid(1_000_000);
    const b = ulid(2_000_000);
    expect(a < b).toBe(true);
  });

  test("no collisions in a burst", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5_000; i++) seen.add(ulid(42));
    expect(seen.size).toBe(5_000);
  });

  test("rejects malformed ids", () => {
    expect(isUlid("")).toBe(false);
    expect(isUlid("UPPERCASE0000000000000000U")).toBe(false);
    expect(isUlid("too-short")).toBe(false);
  });
});
