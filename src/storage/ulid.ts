/**
 * Zero-dependency lowercase ULID (SCHEMA.md I11): 48-bit millisecond
 * timestamp + 80 bits of randomness, Crockford base32, 26 chars. Lexical
 * order follows creation time (within-millisecond order is unspecified).
 */

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Encode the 48-bit timestamp as 10 base32 chars, most significant first. */
function encodeTime(ms: number): string {
  let out = "";
  let t = ms;
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

/** Encode 10 random bytes (80 bits) as 16 base32 chars via 5-bit windows. */
function encodeRandom(bytes: Uint8Array): string {
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >>> bits) & 31];
    }
  }
  return out; // 10 bytes = 80 bits = exactly 16 chars
}

/** Generate a lowercase ULID for the given moment (defaults to now). */
export function ulid(nowMs: number = Date.now()): string {
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);
  return encodeTime(nowMs) + encodeRandom(rand);
}

/** True when s is a well-formed lowercase ULID. */
export function isUlid(s: string): boolean {
  if (s.length !== 26) return false;
  for (const ch of s) {
    if (!ALPHABET.includes(ch)) return false;
  }
  return true;
}
