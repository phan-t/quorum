/**
 * Tokens. The whole security model, and deliberately small: no user accounts,
 * three kinds of bearer token, all compared by hash in constant time.
 *
 * - admin key — one, from the environment, creates sessions
 * - host token — per session, lives in the console URL fragment so it never
 *   reaches a server log or a proxy's access log
 * - screen token — per session, view-only
 * - rejoin token — per participant, issued at hello, restores their identity
 *
 * It is proportionate to a team quiz. It is not proportionate to anything
 * where losing would matter, which is why nothing here is reusable elsewhere.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // base32, no 0/1/8/9

/** 128 bits, base32. Long enough that guessing is not the weak link. */
export function newToken(): string {
  const bytes = randomBytes(16);
  let out = "";
  for (const b of bytes) {
    out += ALPHABET[b % 32];
    out += ALPHABET[(b >> 3) % 32];
  }
  return out.slice(0, 26);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Constant-time compare of a presented token against a stored hash.
 * Hashing first means both sides are always 64 chars, so the length of the
 * presented token leaks nothing.
 */
export function tokenMatches(presented: string, storedHash: string): boolean {
  const a = Buffer.from(hashToken(presented), "utf8");
  const b = Buffer.from(storedHash, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Join codes are four-letter words from the stack, not random strings:
 * they get read out over a bad microphone to a room, and "RAFT" survives
 * that in a way "X7K2" does not.
 */
const JOIN_WORDS = [
  "RAFT", "SEAL", "VAULT", "PLAN", "DRIFT", "MESH", "NOMAD", "GOSSIP",
  "LEASE", "QUORUM", "TOKEN", "APPLY", "STATE", "AGENT", "CONSUL", "PACKER",
] as const;

export function newJoinCode(taken: ReadonlySet<string>): string {
  const free = JOIN_WORDS.filter((w) => !taken.has(w));
  const pool = free.length > 0 ? free : JOIN_WORDS;
  const pick = pool[randomBytes(1)[0]! % pool.length]!;
  // Every word is in use: fall back to a suffix rather than refusing to start.
  return free.length > 0 ? pick : `${pick}${randomBytes(1)[0]! % 100}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}
