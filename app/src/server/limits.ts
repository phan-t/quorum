/**
 * Rate limiting: crude on purpose, and split by outcome.
 *
 * Its own module rather than a corner of main.ts because main.ts listens on a
 * port the moment it is imported, so anything that lives there cannot be
 * tested without starting a server.
 */

/** Attempts per key, as timestamps. Never evicted; bounded by distinct IPs. */
const hits = new Map<string, number[]>();

/** Record an attempt, and say how many are in the window including this one. */
export function note(key: string, windowMs: number, now: number = Date.now()): number {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  return recent.length;
}

/** How many attempts are in the window, without recording another. */
export function count(key: string, windowMs: number, now: number = Date.now()): number {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  hits.set(key, recent);
  return recent.length;
}

export function rateLimited(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): boolean {
  return note(key, windowMs, now) > limit;
}

/** Test seam. Nothing in the server calls this. */
export function resetLimits(): void {
  hits.clear();
}

export const HELLO_WINDOW_MS = 60_000;

/**
 * Two join limits, because one number cannot tell a room from an attacker.
 *
 * The old single limit — ten hellos a minute per IP, checked before the code
 * was read — counted a person holding a valid code and a script holding none
 * identically. A team joining from one office shares a public IP, so the
 * eleventh person to scan the QR code was refused for a minute. The swarm
 * found it on its first run; a room would have found it at two o'clock.
 *
 * A join code is `hvs.` plus 24 base62 characters, about 143 bits, so nobody
 * is guessing one. Code-guessing is not the threat; flooding is. And the thing
 * that separates an attacker from a room is that **an attacker fails** — they
 * do not have a code.
 *
 * So the ceiling on *attempts* clears a room and its reconnects, and the
 * ceiling on *failures* is tighter than the old limit was on everything. A
 * typo gets five tries a minute. A script gets five. A hundred people holding
 * the link all get in.
 */
export const HELLO_FLOOD_LIMIT = 120;
export const HELLO_FAIL_LIMIT = 5;
