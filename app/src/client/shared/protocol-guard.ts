/**
 * What a surface does when the server is speaking a protocol it does not know.
 *
 * A deploy restarts the one task, every socket closes with `1012 Service
 * Restart`, and every client reconnects — deliberately, and without ever
 * reloading. That is the right behaviour for a dropped socket mid-session and
 * it is exactly wrong across a deploy: the page is still running the *old*
 * JavaScript, and the new server is now sending it frames of a shape that
 * build has never seen. When the shape narrowed, the old render code reads a
 * field that is no longer there and throws, and the surface stops updating
 * with nothing on it to say so. See the note beside `PROTOCOL_VERSION` in
 * protocol.ts for when the number moves, and #33 for the whole story.
 *
 * ## The honest limit, because somebody will later conclude this failed
 *
 * **This does not fix the deploy it ships in.** The comparison has to run in
 * the client that is already open, and across the deploy that carries this
 * code, the client that is already open is the one *without* it. Nothing here
 * can reach back and give the previous build a check it does not have. It
 * closes the gap from the *following* deploy onward. The operational note —
 * reload an open Desktop or console after a deploy that changes a frame's
 * shape — stays true regardless, and stays in `docs/running-an-event.md`,
 * because it is also the only cover for any surface that misses this check.
 *
 * ## Three surfaces, three answers, and why they differ
 *
 * The question is the same each time — who is looking at this, and what does
 * interrupting them cost — and the answers are genuinely different:
 *
 * - **Participant.** Reload, immediately. The viewer is holding the thing; the
 *   cost is a blink. And a phone is the surface where rendering a frame it
 *   does not understand is worst, because there are thirty of them and nobody
 *   is watching any one of them closely enough to notice it went quiet.
 * - **Console.** Never automatically. The facilitator is mid-session and
 *   driving. A console that reloads while somebody is typing a reason into the
 *   scoring grid, or a half-second before the space bar lands, is worse than
 *   one that waits. It gets a visible, persistent banner with a reload control
 *   on it, and the host picks the moment.
 * - **Desktop.** Never automatically, for a stronger version of the same
 *   reason: it is projected in front of a room, and reloading mid-reveal is
 *   the one failure everybody in the room sees at once. A visible "this screen
 *   needs reloading" is honest, and the host can act on it between segments.
 *
 * ## The loop guard
 *
 * A client that reloads into the same mismatch would reload for ever — the
 * server is not going to change its mind because a phone asked twice. So every
 * reload this module asks for is counted first, in `localStorage`, keyed on
 * the server version that provoked it, and after {@link RELOAD_LIMIT} the
 * surface stops asking and says so instead.
 *
 * Only the participant reloads by itself, so only the participant strictly
 * needs the guard — but the count is kept for the console too, because a
 * facilitator who has pressed Reload twice into the same mismatch has learned
 * what there is to learn, and a button that cannot help should stop offering.
 *
 * Storage is read and written exactly as defensively as `theme.ts` does it:
 * the accessor itself throws in a private window, and every branch here has to
 * leave a working page behind. A page that cannot count reloads falls back to
 * counting zero, which means the participant gets its one reload — the right
 * failure, since the reload is the thing that usually works.
 *
 * ## Why the reload is injected
 *
 * Nothing in here calls `location.reload()`. The caller passes it in. A reload
 * cannot be observed from a test — the process it would restart is the one
 * running the assertion — so the decision would have gone untested, and the
 * decision is the entire point of the file. Injected, "did this surface ask to
 * be reloaded" is an ordinary assertion about an ordinary function call.
 */

import { PROTOCOL_VERSION, type Role } from "../../protocol.ts";

const KEY = "quorum.protocol.v1";

/**
 * How many reloads one mismatch is allowed to provoke before the surface
 * gives up and says so.
 *
 * Two, not one: the first reload covers the ordinary case — the tab was open
 * across a deploy and the new build is sitting in the CDN waiting to be
 * fetched. The second covers the case where the first one came out of the
 * browser's cache. A third would be a loop, because whatever is serving this
 * page has now twice served a build older than the server and asking again is
 * not going to change that.
 */
export const RELOAD_LIMIT = 2;

/**
 * Reloads already spent on one mismatch.
 *
 * Keyed on `theirs` — the version the *server* sent — so a new mismatch always
 * starts from zero. Without that, a surface that gave up on 2 → 3 would still
 * be giving up months later when the server reached 4, which is a page that
 * refuses to fix itself for a reason nobody can see.
 */
export interface Reloads {
  /** The server's `PROTOCOL_VERSION` that provoked them. */
  readonly theirs: number;
  readonly n: number;
}

/** The two lines of storage this module needs, so a test can supply its own. */
export interface ReloadStore {
  read(): Reloads | null;
  write(v: Reloads | null): void;
}

/**
 * `localStorage`, and never a thrown accessor. Mirrors `theme.ts`: the getter
 * itself can throw in a private window, so the `try` has to be around the
 * access and not merely around the parse.
 */
export const browserStore: ReloadStore = {
  read() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw === null) return null;
      const v = JSON.parse(raw) as Partial<Reloads>;
      if (typeof v.theirs !== "number" || typeof v.n !== "number") return null;
      if (!Number.isFinite(v.theirs) || !Number.isFinite(v.n)) return null;
      return { theirs: v.theirs, n: v.n };
    } catch {
      /* private browsing, or somebody's hand-edited value: count nothing */
      return null;
    }
  },
  write(v) {
    try {
      if (v === null) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, JSON.stringify(v));
    } catch {
      /* the page still works; the loop guard just cannot remember */
    }
  },
};

/** Reloads already spent on *this* mismatch. Anything else counts as none. */
export function reloadsFor(stored: Reloads | null, theirs: number): number {
  if (stored === null) return 0;
  if (stored.theirs !== theirs) return 0;
  // A negative or fractional count is somebody's hand-edited localStorage, and
  // the safe reading of it is "none spent" rather than "loop for ever".
  if (!Number.isInteger(stored.n) || stored.n < 0) return 0;
  return stored.n;
}

/**
 * What a surface should do about a version it did not expect.
 *
 * - `ok` — the versions agree; there is nothing to do.
 * - `reload` — reload the page now, without rendering the frame.
 * - `offer` — show a persistent state with a working reload control on it.
 * - `tell` — show a persistent state with *no* control, because reloading has
 *   been tried enough and did not help. Still visible: a surface that has
 *   stopped being able to fix itself is the one that most needs to say so.
 */
export type StaleVerdict = "ok" | "reload" | "offer" | "tell";

/**
 * The whole decision, as arithmetic. No storage, no DOM, no reload.
 *
 * Split out for the same reason `spaceVerdict` is split out of the console's
 * key handling: the rule is the thing worth pinning, and a rule that can only
 * be exercised through a page is a rule nothing exercises.
 */
export function staleVerdict(
  surface: Role,
  ours: number,
  theirs: number,
  reloads: number,
): StaleVerdict {
  if (ours === theirs) return "ok";
  const spent = reloads >= RELOAD_LIMIT;
  if (surface === "participant") return spent ? "tell" : "reload";
  if (surface === "host") return spent ? "tell" : "offer";
  // The Desktop. Never a control, spent or not: nobody is standing at that
  // machine's pointer — it is a browser in kiosk mode on the far end of an
  // HDMI cable — so a button on it is a button nobody can press. The host
  // reloads that browser, between segments, having read the screen.
  return "tell";
}

export interface StaleSurface {
  /** Which of the three this page is. */
  readonly surface: Role;
  /**
   * Reload the page. Injected, never `location.reload()` in here — see the
   * note at the top of the file.
   */
  readonly reload: () => void;
  /**
   * Put the state on the page and leave it there. `retry` is the reload to
   * wire to a control, or null when reloading is no longer on offer.
   */
  readonly show: (retry: (() => void) | null) => void;
  /** Take it back off. Called when the versions agree. */
  readonly clear?: () => void;
  /** This build's number. Overridable so a test can move one side of it. */
  readonly ours?: number;
  readonly store?: ReloadStore;
}

/**
 * Whether the client should keep processing the frame this check came from.
 *
 * `halt` means the page is on its way out and rendering a frame of an unknown
 * shape in the meantime buys nothing — which is the failure the whole issue is
 * about, so it would be an odd thing to do on the way to fixing it.
 */
export type ProtocolAction = "halt" | "continue";

/**
 * Run the check for one `welcome`. Called on **every** welcome, matching or
 * not, because the matching case is what clears the loop guard.
 */
export function checkProtocol(
  s: StaleSurface,
  theirs: number,
): ProtocolAction {
  const ours = s.ours ?? PROTOCOL_VERSION;
  const store = s.store ?? browserStore;
  const spent = reloadsFor(store.read(), theirs);
  const verdict = staleVerdict(s.surface, ours, theirs, spent);

  switch (verdict) {
    case "ok":
      // Whatever a past mismatch wrote is now answered. Forget it, or a
      // surface that gave up once carries that refusal into a later deploy.
      store.write(null);
      s.clear?.();
      return "continue";

    case "reload":
      // Counted *before* the reload, not after: after does not exist. The
      // page that would do the incrementing is the page being replaced.
      store.write({ theirs, n: spent + 1 });
      s.reload();
      return "halt";

    case "offer":
      s.show(() => {
        store.write({ theirs, n: spent + 1 });
        s.reload();
      });
      // The console keeps running. It is mid-session and a half-broken console
      // the host can still drive beats a blank one, which is the same reason
      // `onStatus` shows a banner over the last state rather than replacing it.
      return "continue";

    case "tell":
      s.show(null);
      return "continue";
  }
}
