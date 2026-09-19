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
 * Join codes, shaped like a Vault root token: `hvs.` and 24 base62
 * characters.
 *
 * They were four-letter words while the plan was to read them to a room —
 * "RAFT" survives a bad microphone where a hash does not. The plan is now to
 * paste them into Slack or Teams, where length costs nothing and nobody
 * transcribes anything, so the code can look like what it is standing in for.
 *
 * Case matters, which is the thing to be careful about: base62 is
 * case-sensitive and the old codes were folded to upper case everywhere they
 * were compared. Nothing may fold these.
 */
const BASE62 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const JOIN_CODE_BODY = 24;
export const JOIN_CODE_PREFIX = "hvs.";

/** `hvs.` plus 24 base62 characters, from the system CSPRNG. */
export function newJoinCode(taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const bytes = randomBytes(JOIN_CODE_BODY);
    let body = "";
    for (const b of bytes) body += BASE62[b % 62];
    const code = JOIN_CODE_PREFIX + body;
    if (!taken.has(code)) return code;
  }
  // 62^24 is large enough that this is unreachable; throwing beats looping.
  throw new Error("could not mint an unused join code");
}

/** Shape check only — whether a session exists is a separate question. */
export function looksLikeJoinCode(v: string): boolean {
  return new RegExp(`^${JOIN_CODE_PREFIX.replace(".", "\\.")}[0-9A-Za-z]{8,64}$`).test(v.trim());
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}
