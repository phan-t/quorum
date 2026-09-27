/**
 * The lobby cluster, driven against a fake document and a fake clock.
 *
 * This repo does not test DOM code. `controls.test.ts` says so outright —
 * "`bindSpace` is DOM code and this repo has no DOM in its tests" — and for
 * the rest of the client that is still the right call, because the cost of a
 * rendering bug there is that something looks wrong.
 *
 * The lobby is the exception, and this file is the whole of the exception.
 * Here the cost of a rendering bug is a person who joined and whose name never
 * appeared, in front of the room, while they hold the phone that says they are
 * in. The cluster holds a joiner's name out of the list until their entry
 * commits, so every path through it owes that name back, and "owes it back" is
 * a property of closure state that no pure function can be extracted to carry.
 *
 * Two bugs proved that, both after the six decisions had been extracted into
 * `shared/view.ts` and covered by 38 tests that all still passed:
 *
 * 1. `flushAll` released the in-flight pid *before* clearing the field, and
 *    `release` re-enters through the lobby's `paintRoom` → `fit` → `flushAll`.
 *    The re-entrant call still saw the pid, released it again, and recursed
 *    until the stack went. A short window plus a commit in flight plus any
 *    repaint.
 * 2. A superseded commit orphaned its entry. The generation was bumped while
 *    `inFlight` still named somebody, and the stage that releases a pid is
 *    scheduled from inside the *first* stage's callback — which returns early
 *    once the generation has moved. Superseded inside its first stage, an
 *    entry's releasing stage was never scheduled at all. Reachable by turning
 *    reduced motion on mid-commit, which this code explicitly supports.
 *
 * Both are the exact failure the hold-and-release mechanism exists to prevent,
 * and both are invisible to a pure test: the pure invariant holds in each of
 * them. The leak is in the closure, so the closure is what gets driven.
 *
 * ## What the fake is, and what it deliberately is not
 *
 * It is not a DOM. It is the list of things `raftCluster` actually calls,
 * hand-rolled, and nothing else — element construction with attributes,
 * classes and text; `append`/`remove`/`querySelectorAll` for one class
 * selector; three rectangles; `offsetParent`; `document.hidden`; `matchMedia`;
 * and `setTimeout`/`clearTimeout` on a clock the test turns by hand. Adding
 * anything past that would be writing a browser, and a browser is a
 * dependency's job. `jsdom` is deliberately not here: the point is to hold the
 * commit's *state machine* still, not to lay out a page.
 *
 * Two omissions are on purpose. `getComputedTextLength` is not implemented,
 * which makes `squeeze` return at its first line — name width is a cosmetic
 * property and mixing it in would mean the fake had to have fonts. And nothing
 * here checks what the picture looks like: which circles are lit is not what
 * this file is for, and asserting it would make the fake a specification of
 * the animation, which is the thing most likely to change.
 *
 * What the fake *does* model faithfully is the one feedback loop that both
 * bugs lived in. `.raft-wrap.is-cramped` is `display: none` in the stylesheet,
 * so a node under that class measures zero and has no `offsetParent` here too.
 * Without that, `fit` deciding the drawing is cramped would not make the next
 * commit unwatched, and half the re-entrant paths would never be walked.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { raftCluster } from "./view.ts";

/* ------------------------------------------------------------------ */
/* The fake document                                                   */
/* ------------------------------------------------------------------ */

interface Rect {
  readonly width: number;
  readonly height: number;
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

const NO_BOX: Rect = { width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 };

function box(width: number, height: number, top: number): Rect {
  return { width, height, top, bottom: top + height, left: 0, right: width };
}

/**
 * One element. Enough of one, anyway.
 *
 * `rect` is null until a layout is applied to it, and only three nodes ever
 * get one: the wrapper, the wrapper's parent, and the drawing. Those are the
 * three `fit` measures and there is no layout engine here to invent the rest,
 * so a node nobody positioned measures nothing rather than measuring a guess.
 */
class FakeNode {
  readonly tag: string;
  readonly kids: FakeNode[] = [];
  readonly attrs = new Map<string, string>();
  readonly classes = new Set<string>();
  parent: FakeNode | null = null;
  rect: Rect | null = null;
  /** Whether this subtree is on screen at all; see the `gone` layout. */
  onScreen = true;
  private own = "";

  constructor(tag: string) {
    this.tag = tag;
  }

  /* --- the tree ---------------------------------------------------- */

  append(...kids: FakeNode[]): void {
    for (const kid of kids) this.appendChild(kid);
  }

  appendChild(kid: FakeNode): FakeNode {
    kid.remove();
    kid.parent = this;
    this.kids.push(kid);
    return kid;
  }

  removeChild(kid: FakeNode): FakeNode {
    const at = this.kids.indexOf(kid);
    if (at >= 0) this.kids.splice(at, 1);
    kid.parent = null;
    return kid;
  }

  remove(): void {
    this.parent?.removeChild(this);
  }

  get firstChild(): FakeNode | null {
    return this.kids[0] ?? null;
  }

  get parentElement(): FakeNode | null {
    return this.parent;
  }

  /**
   * Only ever asked for `.raft-entry`, and only ever on the drawing. Anything
   * else throws rather than quietly returning nothing: a fake that answers
   * questions it cannot answer is worse than no fake.
   */
  querySelectorAll(selector: string): FakeNode[] {
    if (!selector.startsWith(".") || /[\s,>[:]/.test(selector)) {
      throw new Error(`the fake document only does single class selectors: ${selector}`);
    }
    const want = selector.slice(1);
    const found: FakeNode[] = [];
    const walk = (node: FakeNode): void => {
      for (const kid of node.kids) {
        if (kid.classes.has(want)) found.push(kid);
        walk(kid);
      }
    };
    walk(this);
    return found;
  }

  /* --- attributes, classes, text ----------------------------------- */

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  set className(value: string) {
    this.classes.clear();
    for (const one of value.split(/\s+/)) if (one !== "") this.classes.add(one);
  }

  get className(): string {
    return [...this.classes].join(" ");
  }

  get classList(): {
    add: (name: string) => void;
    remove: (name: string) => void;
    contains: (name: string) => boolean;
    toggle: (name: string, on?: boolean) => void;
  } {
    return {
      add: (name) => void this.classes.add(name),
      remove: (name) => void this.classes.delete(name),
      contains: (name) => this.classes.has(name),
      toggle: (name, on) => {
        const want = on ?? !this.classes.has(name);
        if (want) this.classes.add(name);
        else this.classes.delete(name);
      },
    };
  }

  set textContent(value: string) {
    this.kids.length = 0;
    this.own = value;
  }

  get textContent(): string {
    return this.own + this.kids.map((k) => k.textContent).join("");
  }

  /* --- layout ------------------------------------------------------ */

  /** `.raft-wrap.is-cramped { display: none }`, as far up the tree as it goes. */
  private displayNone(): boolean {
    for (let node: FakeNode | null = this; node !== null; node = node.parent) {
      if (node.classes.has("is-cramped")) return true;
      if (!node.onScreen) return true;
    }
    return false;
  }

  getBoundingClientRect(): Rect {
    if (this.displayNone()) return NO_BOX;
    return this.rect ?? NO_BOX;
  }

  /**
   * Null under `display: none`, which is what makes `fit` hiding the drawing
   * also make the next commit unwatched. That loop is the one both bugs lived
   * in, so it is the one thing the fake layout has to get right.
   */
  get offsetParent(): FakeNode | null {
    if (this.displayNone()) return null;
    return this.parent;
  }

  /** `h` will call this if an element is given handlers. The cluster gives none. */
  addEventListener(): void {
    throw new Error("the fake document has no events");
  }

  /** The cluster starts Web Animations it never reads back. */
  animate(): { cancel: () => void } {
    return { cancel: () => {} };
  }
}

/* ------------------------------------------------------------------ */
/* The fake clock                                                      */
/* ------------------------------------------------------------------ */

interface Pending {
  readonly id: number;
  readonly at: number;
  readonly seq: number;
  readonly fn: () => void;
}

/**
 * `setTimeout` the test turns by hand.
 *
 * Ties break by scheduling order, because the cluster relies on exactly that:
 * the majority stage and the follower arrivals are set from the same instant
 * and the comment on them says the ordering is "the timer queue's to keep".
 *
 * A callback may schedule more work, and that work runs in the same `advance`
 * if it comes due inside it. The step cap is there so that a cluster that
 * schedules itself forever fails as a test rather than as a hang.
 */
class FakeClock {
  now = 0;
  private next = 1;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();

  setTimeout(fn: () => void, ms: number): number {
    const id = this.next;
    this.next += 1;
    this.seq += 1;
    this.pending.set(id, { id, at: this.now + Math.max(0, ms), seq: this.seq, fn });
    return id;
  }

  clearTimeout(id: number): void {
    this.pending.delete(id);
  }

  get outstanding(): number {
    return this.pending.size;
  }

  advance(ms: number): void {
    const until = this.now + ms;
    for (let steps = 0; ; steps += 1) {
      if (steps > 10_000) throw new Error("the clock never ran out of work");
      let due: Pending | null = null;
      for (const timer of this.pending.values()) {
        if (timer.at > until) continue;
        if (due === null || timer.at < due.at || (timer.at === due.at && timer.seq < due.seq)) {
          due = timer;
        }
      }
      if (due === null) break;
      this.pending.delete(due.id);
      this.now = due.at;
      due.fn();
    }
    this.now = until;
  }
}

/* ------------------------------------------------------------------ */
/* The harness                                                         */
/* ------------------------------------------------------------------ */

/**
 * How much room the lobby gave the drawing, as the four answers `fit` has.
 *
 * `roomy` is a phone in portrait with a small room in it. `short` is the
 * measured case that put `RAFT_MIN_PX` in the file: 86x54 at 375x667 with a
 * full room. `spilling` is the grid case where the drawing keeps its full
 * height and hangs out of the bottom of the stage. `gone` is the lobby not
 * being on screen at all, which is the one `fit` must read as "no measurement"
 * rather than as "no room".
 */
type Layout = "roomy" | "short" | "spilling" | "gone";

const LAYOUTS: readonly Layout[] = ["roomy", "short", "spilling", "gone"];

/**
 * How deep the lobby's callback may legitimately nest.
 *
 * A release repaints the lobby, the repaint calls `fit`, and a `fit` that
 * finds the drawing cramped flushes — which releases again. That is a real
 * path and it is allowed to happen: the second call finds nothing in flight
 * and unwinds. Two is the most the fixed code reaches; the limit is generous
 * so that a legitimate third rung does not fail the suite, and tight enough
 * that the unbounded version trips it in microseconds instead of after a
 * megabyte of stack.
 */
const REENTRY_LIMIT = 8;

interface Harness {
  /** A join arrives. A null pid is the room arriving as one, which has none. */
  commit(pid: string | null): void;
  flush(): void;
  settle(): void;
  fit(): void;
  advance(ms: number): void;
  hide(hidden: boolean): void;
  still(on: boolean): void;
  lay(mode: Layout): void;
  destroy(): void;
  /** Every pid the cluster has handed back, in order, duplicates included. */
  readonly released: readonly string[];
  readonly deepest: number;
  readonly outstanding: number;
}

/**
 * Stand a cluster up in the fake document and hand back the levers.
 *
 * The globals are installed for the duration and put back afterwards, because
 * `raftCluster` reads `document`, `window` and `matchMedia` as free names at
 * call time — which is the same reason it can be driven at all.
 *
 * The callback is the lobby's, not a spy. `paintRoom` calls `settle` and then
 * `fit` on every release, and that is the whole re-entrant path; a callback
 * that only recorded the pid would be testing a cluster nothing calls back
 * into, which is exactly the shape of test that missed both bugs.
 */
function harness(run: (h: Harness) => void): void {
  const slots = globalThis as unknown as Record<string, unknown>;
  const had = {
    document: slots["document"],
    window: slots["window"],
    matchMedia: slots["matchMedia"],
    hadDocument: "document" in slots,
    hadWindow: "window" in slots,
    hadMatchMedia: "matchMedia" in slots,
  };

  const clock = new FakeClock();
  let hidden = false;
  let reduced = false;

  const doc = {
    get hidden(): boolean {
      return hidden;
    },
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => {
      const node = new FakeNode("#text");
      node.textContent = text;
      return node;
    },
  };

  slots["document"] = doc;
  slots["window"] = {
    setTimeout: (fn: () => void, ms: number) => clock.setTimeout(fn, ms),
    clearTimeout: (id: number) => clock.clearTimeout(id),
  };
  slots["matchMedia"] = (query: string) => ({
    matches: query.includes("prefers-reduced-motion") && reduced,
  });

  const released: string[] = [];
  let depth = 0;
  let deepest = 0;
  let api: ReturnType<typeof raftCluster> | null = null;

  try {
    api = raftCluster((pid) => {
      depth += 1;
      deepest = Math.max(deepest, depth);
      try {
        if (depth > REENTRY_LIMIT) {
          throw new Error(
            `the lobby's callback re-entered ${depth} deep: a release path is recursing`,
          );
        }
        released.push(pid);
        // What `paintRoom` does, in the order it does it.
        api?.settle();
        api?.fit();
      } finally {
        depth -= 1;
      }
    });

    // The wrapper lives inside `.lobby-room`, and `fit` asks whether it is
    // inside its parent — so there has to be a parent for it to be inside.
    const wrap = api.el as unknown as FakeNode;
    const room = new FakeNode("div");
    room.className = "lobby-room";
    room.appendChild(wrap);
    const svg = wrap.firstChild;
    assert.ok(svg !== null, "the cluster draws a picture");

    const lay = (mode: Layout): void => {
      room.onScreen = mode !== "gone";
      if (mode === "gone") {
        room.rect = NO_BOX;
        wrap.rect = NO_BOX;
        svg.rect = NO_BOX;
        return;
      }
      room.rect = box(260, 320, 80);
      // `spilling`: the drawing keeps its full height and hangs out of the
      // bottom of the stage, while its own height stays perfectly healthy.
      wrap.rect = mode === "spilling" ? box(240, 300, 200) : box(240, 190, 200);
      svg.rect = mode === "short" ? box(240, 54, 200) : box(240, 150, 200);
    };
    lay("roomy");

    const cluster = api;
    run({
      commit: (pid) => cluster.commit(pid === null ? null : pid.toUpperCase(), pid),
      flush: () => cluster.flush(),
      settle: () => cluster.settle(),
      fit: () => cluster.fit(),
      advance: (ms) => clock.advance(ms),
      hide: (on) => {
        hidden = on;
      },
      still: (on) => {
        reduced = on;
      },
      lay,
      destroy: () => cluster.destroy(),
      released,
      get deepest() {
        return deepest;
      },
      get outstanding() {
        return clock.outstanding;
      },
    });
  } finally {
    api?.destroy();
    if (had.hadDocument) slots["document"] = had.document;
    else delete slots["document"];
    if (had.hadWindow) slots["window"] = had.window;
    else delete slots["window"];
    if (had.hadMatchMedia) slots["matchMedia"] = had.matchMedia;
    else delete slots["matchMedia"];
  }
}

/* ------------------------------------------------------------------ */
/* The fuzz                                                            */
/* ------------------------------------------------------------------ */

/** mulberry32, the same one the bot harness uses. Small, and reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * How far the clock is turned in one step.
 *
 * A commit is four equal stages of 700ms, and both of the bugs this file
 * exists for were reachable only *inside* a stage — one of them only inside
 * the first. So the menu straddles every boundary rather than sampling
 * uniformly: landing on 350 and on 701 matters, landing on 412 does not. The
 * numbers are the current stage lengths; nothing here depends on them being
 * exact, only on some of them falling either side.
 */
const TICKS: readonly number[] = [1, 60, 350, 699, 700, 701, 1_400, 2_100, 2_800, 5_000];

/** Long enough for any commit in flight to finish, whatever stage it is in. */
const SETTLED_MS = 10_000;

interface Fuzz {
  readonly ops: readonly string[];
  readonly lost: readonly string[];
  readonly spurious: readonly string[];
  readonly error: string | null;
  readonly deepest: number;
}

/**
 * One random sequence, start to finish.
 *
 * The run ends by putting everything back and draining: `flush` promises that
 * everything waiting goes into the list now, so after a flush and a clock turn
 * with nothing left outstanding, every pid the cluster was handed must have
 * come back. That is the property. It is stated on `onCommitted` in the view
 * as the cluster's job "for *every* pid it is handed, on every path", and it
 * is the one thing in this file worth calling a bug.
 *
 * `destroy` is deliberately not one of the operations. It promises the
 * opposite — it drops what is queued on purpose, because the lobby it would
 * release into is going away — so including it would make the property false
 * for a reason that is not a bug.
 */
function fuzz(seed: number, steps: number): Fuzz {
  const rng = mulberry32(seed);
  const pick = <T,>(items: readonly T[]): T => {
    const item = items[Math.floor(rng() * items.length)];
    if (item === undefined) throw new Error("pick from an empty list");
    return item;
  };

  const ops: string[] = [];
  const handed: string[] = [];
  let error: string | null = null;
  let lost: string[] = [];
  let spurious: string[] = [];
  let deepest = 0;

  harness((h) => {
    try {
      // Variable length, so the shortest sequence that breaks something has a
      // chance of being the one reported. A failure printed as six operations
      // is a bug somebody reads; the same failure printed as forty is a bug
      // somebody bisects by hand.
      const n = 4 + Math.floor(rng() * (steps - 3));
      for (let i = 0; i < n; i += 1) {
        const op = pick([
          "arrive",
          "arrive",
          "arrive",
          "tick",
          "tick",
          "tick",
          "flush",
          "settle",
          "fit",
          "visible",
          "motion",
          "layout",
        ] as const);
        switch (op) {
          case "arrive": {
            // One in twelve is the room arriving as one, which carries no pid
            // — the path a second first-render takes when the lobby is rebuilt.
            const pid = rng() < 1 / 12 ? null : `p${handed.length + 1}`;
            if (pid !== null) handed.push(pid);
            ops.push(`commit(${pid ?? "room"})`);
            h.commit(pid);
            break;
          }
          case "tick": {
            const ms = pick(TICKS);
            ops.push(`advance(${ms})`);
            h.advance(ms);
            break;
          }
          case "flush":
            ops.push("flush()");
            h.flush();
            break;
          case "settle":
            ops.push("settle()");
            h.settle();
            break;
          case "fit":
            ops.push("fit()");
            h.fit();
            break;
          case "visible": {
            const on = rng() < 0.5;
            ops.push(`hidden=${on}`);
            h.hide(on);
            break;
          }
          case "motion": {
            const on = rng() < 0.5;
            ops.push(`reducedMotion=${on}`);
            h.still(on);
            break;
          }
          case "layout": {
            const mode = pick(LAYOUTS);
            ops.push(`layout=${mode}`);
            h.lay(mode);
            break;
          }
        }
      }

      // Everything waiting, into the list now — then let the clock run out.
      // Twice, because a stage still in flight when the flush lands can drain
      // the queue once more on its way out.
      ops.push("— drain —");
      for (let i = 0; i < 2; i += 1) {
        h.flush();
        h.advance(SETTLED_MS);
      }

      const back = new Set(h.released);
      lost = handed.filter((pid) => !back.has(pid));
      spurious = [...back].filter((pid) => !handed.includes(pid));
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    deepest = h.deepest;
  });

  return { ops, lost, spurious, error, deepest };
}

/** The seed and the sequence, so a failure is reproducible rather than a story. */
function report(seed: number, run: Fuzz): string {
  const why =
    run.error !== null
      ? run.error
      : run.lost.length > 0
        ? `never released: ${run.lost.join(", ")}`
        : `released a pid it was never handed: ${run.spurious.join(", ")}`;
  return [
    `seed ${seed}: ${why}`,
    "",
    "replay with `fuzz(" + String(seed) + ", STEPS)`; the sequence was:",
    ...run.ops.map((op, i) => `  ${String(i).padStart(3)} ${op}`),
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* The tests                                                           */
/* ------------------------------------------------------------------ */

/**
 * Where the fuzz starts, and how far it goes.
 *
 * Fixed, not `Date.now()`. A fuzz that picks its own seed finds a bug once and
 * then cannot be asked about it again, and a suite that fails on one run in
 * forty is a suite people learn to re-run. Same seeds, same sequences, every
 * time — and when one of them breaks, the seed in the failure replays it
 * exactly.
 *
 * A thousand sequences of four to forty operations is about 23,000 operations
 * and 4,900 pids, in well under a tenth of a second — cheap enough that there
 * is no argument for trimming it. Both of the historical bugs were put back to
 * check this file is worth having, and the counts are how far the net reaches:
 * the `flushAll` recursion fails 201 of the thousand, the orphaned entry fails
 * 30. Raise the numbers when hunting something rarer; the suite does not need
 * them raised.
 */
const FUZZ_SEED = 20_260_927;
const FUZZ_RUNS = 1_000;
const FUZZ_STEPS = 40;

describe("the lobby cluster gives every name back", () => {
  it("releases a pid it was handed while nobody was watching", () => {
    harness((h) => {
      h.hide(true);
      h.commit("p1");
      assert.deepEqual([...h.released], ["p1"]);
    });
  });

  it("releases a pid at the majority moment, not at the end of the drawing", () => {
    // The word lands when the third of five nodes lights, and the name lands
    // with it. Holding it to the end of the commit would be a second and a
    // half of a person watching a list they are not in.
    harness((h) => {
      h.commit("p1");
      h.advance(699);
      assert.deepEqual([...h.released], []);
      h.advance(2_800);
      assert.deepEqual([...h.released], ["p1"]);
    });
  });

  it("releases what is queued when the window shrinks under the drawing", () => {
    // `fit` deciding the drawing has no room is the window costing somebody
    // their place in the list, which is the trade this must never make.
    harness((h) => {
      h.commit("p1");
      h.commit("p2");
      h.lay("short");
      h.fit();
      assert.deepEqual([...h.released].sort(), ["p1", "p2"]);
    });
  });

  /**
   * Bug 1, as a regression test.
   *
   * `flushAll` released the in-flight pid before clearing the field. `release`
   * calls the lobby back, the lobby repaints, the repaint calls `fit`, and a
   * `fit` that finds the drawing cramped calls `flushAll` again — which still
   * saw the pid, because the outer call had not reached the line that clears
   * it. Every rung released the same person again, and the lobby's render
   * threw `Maximum call stack size exceeded`.
   *
   * The harness catches it as depth rather than as a stack overflow: the same
   * fault, found in microseconds and with a sequence attached.
   */
  it("does not recurse when a release repaints into a fit that flushes", () => {
    harness((h) => {
      h.commit("p1");
      h.advance(350);
      h.lay("short");
      h.fit();
      assert.deepEqual([...h.released], ["p1"]);
      assert.ok(h.deepest <= REENTRY_LIMIT, `re-entered ${h.deepest} deep`);
    });
  });

  /**
   * Bug 2, as a regression test.
   *
   * Turning reduced motion on mid-commit supersedes the entry being drawn. The
   * generation moves, so the first stage's callback returns early — and the
   * stage that releases a pid is scheduled from *inside* that callback, so it
   * was never scheduled at all. The entry was orphaned in `inFlight` and the
   * next commit overwrote it. The name never arrived.
   *
   * 350ms is inside the first stage, which is the window the bug needs; at
   * 701ms the releasing stage already exists and the entry survives either way.
   */
  it("does not strand the entry a superseding commit takes over from", () => {
    harness((h) => {
      h.commit("p1");
      h.advance(350);
      h.still(true);
      h.commit("p2");
      h.advance(10_000);
      assert.deepEqual([...h.released].sort(), ["p1", "p2"]);
    });
  });

  it("gives back what is still queued behind a commit when the tab goes away", () => {
    harness((h) => {
      h.commit("p1");
      h.commit("p2");
      h.commit("p3");
      h.advance(350);
      h.hide(true);
      h.flush();
      assert.deepEqual([...h.released].sort(), ["p1", "p2", "p3"]);
    });
  });

  it("cancels its pending stages when the scene goes away", () => {
    // Deliberately no release here: the lobby a release would land in is going
    // away with the scene, so the contract is teardown, not delivery.
    harness((h) => {
      h.commit("p1");
      h.commit("p2");
      h.advance(350);
      assert.ok(h.outstanding > 0);
      h.destroy();
      assert.equal(h.outstanding, 0);
      h.advance(10_000);
      assert.deepEqual([...h.released], []);
    });
  });

  /**
   * The property, fuzzed.
   *
   * Every pid handed to `commit` comes back, under any sequence of arrivals,
   * clock turns, flushes, visibility changes, reduced-motion flips, layout
   * changes and `fit` calls. Nothing about the picture is asserted — only that
   * nobody was lost inside it.
   *
   * The two bugs above were both found this way before they were written down
   * as the two tests above, and this is the half that finds the third one.
   */
  it("accounts for every pid across every sequence the fuzz can build", () => {
    for (let i = 0; i < FUZZ_RUNS; i += 1) {
      const seed = FUZZ_SEED + i;
      const run = fuzz(seed, FUZZ_STEPS);
      if (run.error !== null || run.lost.length > 0 || run.spurious.length > 0) {
        assert.fail(report(seed, run));
      }
    }
  });

  it("never lets a release path re-enter without bound, across the same sequences", () => {
    // Its own test because it is its own failure. A pid can be perfectly
    // accounted for by a function that releases it nine times on its way down
    // a stack it is about to run out of, and "the lobby's render threw" is not
    // a thing the property above would name.
    //
    // The guard inside the harness throws, so a genuinely unbounded path fails
    // both of these. What this one adds is the number and the seed: how deep
    // it went, and which sequence took it there.
    let worst = 0;
    let worstSeed = FUZZ_SEED;
    for (let i = 0; i < FUZZ_RUNS; i += 1) {
      const seed = FUZZ_SEED + i;
      const run = fuzz(seed, FUZZ_STEPS);
      if (run.deepest > worst) {
        worst = run.deepest;
        worstSeed = seed;
      }
    }
    assert.ok(
      worst <= REENTRY_LIMIT,
      `seed ${worstSeed} re-entered ${worst} deep, past the ${REENTRY_LIMIT} a legitimate path needs`,
    );
  });
});
