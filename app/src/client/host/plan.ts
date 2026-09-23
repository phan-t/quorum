/**
 * The arcade's running order, decided before the session starts.
 *
 * The console used to ask "which round?" in the middle of the session, from a
 * six-item picker with settings attached to it. That is a decision made while
 * thirty people watch, and it is the one decision on this console that does
 * not have to be made then: which rounds, in which order, and how long each
 * one runs are all knowable at 9am.
 *
 * So the host sets the order during setup, and once the session is running the
 * arcade advances on the primary button like everything else — the button says
 * "Announce Plan / Apply" because Plan / Apply is what comes next in the order
 * they chose.
 *
 * This file is the list and nothing else: no DOM, no commands, no timers. It
 * is pure so the part most likely to be wrong at 2:45pm is the part that has
 * tests.
 */

/** The rounds that exist. The other three are designed, not built. */
export type ArcadePick = "recruitment" | "plan_apply" | "glass_bridge";

export const ARCADE_PLAYABLE: readonly ArcadePick[] = [
  "recruitment",
  "plan_apply",
  "glass_bridge",
];

export interface PlanEntry {
  readonly kind: ArcadePick;
  /** Out of the running order, but still listed so it can be put back. */
  readonly included: boolean;
}

export type ArcadePlan = readonly PlanEntry[];

/**
 * All three, in the order SPEC.md numbers them. Recruitment first because it
 * knocks nobody out and teaches the controls; the bridge last because it is
 * the one that empties the Floor.
 */
export function defaultPlan(): ArcadePlan {
  return ARCADE_PLAYABLE.map((kind) => ({ kind, included: true }));
}

/** Every entry, in order, whether or not it is in. */
export function planOrder(plan: ArcadePlan): readonly PlanEntry[] {
  return plan;
}

/** The rounds that will actually be played, in order. */
export function planIncluded(plan: ArcadePlan): readonly ArcadePick[] {
  return plan.filter((e) => e.included).map((e) => e.kind);
}

/**
 * Move a round one place up or down. Off either end is a no-op rather than a
 * wrap: a list that teleports under a cursor is a list nobody can reorder.
 */
export function movePlan(
  plan: ArcadePlan,
  kind: ArcadePick,
  delta: -1 | 1,
): ArcadePlan {
  const from = plan.findIndex((e) => e.kind === kind);
  if (from === -1) return plan;
  const to = from + delta;
  if (to < 0 || to >= plan.length) return plan;
  const next = [...plan];
  const moved = next[from];
  const other = next[to];
  if (moved === undefined || other === undefined) return plan;
  next[from] = other;
  next[to] = moved;
  return next;
}

/**
 * Take a round out of the running order, or put it back.
 *
 * Taking the last one out is refused: the arcade with no rounds in it is a
 * state whose primary button has nothing to name, and "the button always says
 * what happens next" is the rule this console is built on.
 */
export function togglePlan(plan: ArcadePlan, kind: ArcadePick): ArcadePlan {
  const entry = plan.find((e) => e.kind === kind);
  if (entry === undefined) return plan;
  if (entry.included && planIncluded(plan).length <= 1) return plan;
  return plan.map((e) =>
    e.kind === kind ? { kind: e.kind, included: !e.included } : e,
  );
}

/** True when `togglePlan` would refuse — so the console can say why. */
export function isLastIncluded(plan: ArcadePlan, kind: ArcadePick): boolean {
  const entry = plan.find((e) => e.kind === kind);
  return entry !== undefined && entry.included && planIncluded(plan).length <= 1;
}

/**
 * The round the primary button should offer next: the first one in the order
 * that is in and has not been played yet. Null when the order is finished,
 * which is the console's cue to offer the standings instead.
 */
export function nextRound(
  plan: ArcadePlan,
  played: ReadonlySet<ArcadePick>,
): ArcadePick | null {
  for (const kind of planIncluded(plan)) {
    if (!played.has(kind)) return kind;
  }
  return null;
}

/** "Recruitment, then Plan / Apply, then The Glass Bridge" — for the checklist. */
export function planSummary(
  plan: ArcadePlan,
  label: Readonly<Record<ArcadePick, string>>,
): string {
  const names = planIncluded(plan).map((k) => label[k]);
  if (names.length === 0) return "no rounds";
  if (names.length === 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")}, then ${names[names.length - 1]}`;
}

/* ------------------------------------------------------------------ */
/* Keeping it across a refresh                                         */
/* ------------------------------------------------------------------ */

/**
 * A console reloaded at 2:45pm must come back with the order still set. The
 * store is best-effort on purpose: a browser with storage turned off gets the
 * default order and a working console, never a broken one.
 */
export interface StoredSetup {
  plan: ArcadePlan;
  timings: Readonly<Record<string, number>>;
}

export function parseSetup(raw: string | null): StoredSetup | null {
  if (raw === null || raw === "") return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const plan: PlanEntry[] = [];
  if (Array.isArray(o["plan"])) {
    for (const item of o["plan"] as unknown[]) {
      if (typeof item !== "object" || item === null) continue;
      const e = item as Record<string, unknown>;
      const kind = e["kind"];
      if (typeof kind !== "string") continue;
      if (!ARCADE_PLAYABLE.includes(kind as ArcadePick)) continue;
      if (plan.some((p) => p.kind === kind)) continue;
      plan.push({ kind: kind as ArcadePick, included: e["included"] !== false });
    }
  }
  // Anything the stored order left out is appended, so a build that adds a
  // round does not leave it unreachable behind a stale entry in storage.
  for (const kind of ARCADE_PLAYABLE) {
    if (!plan.some((p) => p.kind === kind)) plan.push({ kind, included: true });
  }
  const timings: Record<string, number> = {};
  const t = o["timings"];
  if (typeof t === "object" && t !== null) {
    for (const [k, value] of Object.entries(t as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        timings[k] = Math.round(value);
      }
    }
  }
  if (planIncluded(plan).length === 0) {
    return { plan: plan.map((e) => ({ kind: e.kind, included: true })), timings };
  }
  return { plan, timings };
}
