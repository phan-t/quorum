/**
 * The small amount of rendering logic that is genuinely the same on a phone,
 * a console and a 1080p tile: which view a `RenderState` resolves to, and the
 * words the product uses for things.
 *
 * Deliberately not shared: layout. The phone and the big screen show the same
 * five facts and share almost no markup, and pretending otherwise would give
 * both of them a worse version of the other's constraints.
 */

import type {
  ActivitySummary,
  ArcadeCell,
  ArcadeView,
  OwnPoints,
  RefusedReason,
  RenderState,
  RosterEntry,
  TriviaView,
} from "../../protocol.ts";
import type { ArcadeRoundKind, Segment } from "../../engine/types.ts";

export type ViewKind =
  | "waiting"
  | "lobby"
  | "holding"
  | "trivia"
  | "arcade"
  | "standings"
  | "sealed"
  | "final";

/**
 * The participant never navigates: this function is the whole of "what am I
 * looking at", and both the phone and the big screen ask it.
 *
 * Seal wins over segment. `sealed` means no surface shows cumulative
 * standings, and "no surface" has to include the one that asked for them.
 */
export function resolveView(state: RenderState): ViewKind {
  if (state.phase === "draft") return "waiting";
  if (state.phase === "closed") {
    return state.seal === "sealed" ? "sealed" : "final";
  }
  switch (state.segment) {
    case "standings":
      return state.seal === "sealed" ? "sealed" : "standings";
    case "final":
      return state.seal === "sealed" ? "sealed" : "final";
    default:
      return state.segment;
  }
}

export const SEGMENTS: readonly Segment[] = [
  "lobby",
  "holding",
  "trivia",
  "arcade",
  "standings",
  "final",
];

export const SEGMENT_LABEL: Readonly<Record<Segment, string>> = {
  lobby: "Lobby",
  holding: "Holding",
  trivia: "Trivia",
  arcade: "Arcade",
  standings: "Standings",
  final: "Final",
};

/** The phase that builds each segment's surface. */
export const SEGMENT_PHASE: Readonly<Record<Segment, number>> = {
  lobby: 1,
  holding: 1,
  trivia: 3,
  arcade: 4,
  standings: 1,
  final: 1,
};

/**
 * Whether the segment has a real surface behind it yet.
 *
 * Not `SEGMENT_PHASE[s] === 1` — trivia is Phase 3 and it is built, and the
 * console has to be able to say which of those two facts it means. Nothing
 * puts a placeholder in front of the room any more; the flag stays because
 * the next unbuilt thing will want it and because the console's rail reads it.
 */
export const SEGMENT_BUILT: Readonly<Record<Segment, boolean>> = {
  lobby: true,
  holding: true,
  trivia: true,
  arcade: true,
  standings: true,
  final: true,
};

/**
 * The run of show the primary button walks. A segment joins it when its
 * surface exists — the space bar must never land on a segment that shows the
 * room a placeholder, which is why the arcade is still not in here.
 */
export const RUN_OF_SHOW: readonly Segment[] = [
  "lobby",
  "holding",
  "trivia",
  "arcade",
  "standings",
  "final",
];

export function nextSegment(current: Segment): Segment | null {
  const i = RUN_OF_SHOW.indexOf(current);
  if (i === -1) return "standings"; // off-piste: come back to the board
  return RUN_OF_SHOW[i + 1] ?? null;
}

/* ------------------------------------------------------------------ */
/* Trivia                                                              */
/* ------------------------------------------------------------------ */

/**
 * The four answer tiles: shape, fill, and the ink that reads on that fill.
 *
 * DESIGN.md fixes the pattern — "a shape glyph (▲ ◆ ● ■) in the corner and
 * one of the four product hues as a *fill*" — and it is Kahoot's, which is
 * the right one to copy. The shape is not decoration: "every answer has a
 * shape as well as a colour", so the tile is identifiable to someone who
 * cannot tell the pink one from the purple one on a compressed video tile.
 *
 * The ink is per hue and not white. DESIGN used to say white text on all four
 * tiles, which failed its own 4.5:1 floor — white on `--nomad` measures
 * 1.96:1 — so the light hues take dark ink instead. DESIGN.md has since been
 * corrected to match, and carries the measured figures: 5.76 / 4.93 / 9.25 /
 * 13.36. Consul's 4.93 is the thin one; darkening that hue means measuring
 * again.
 */
export interface AnswerTile {
  /** 0-based, which is what goes on the wire. The glyph is what people say. */
  readonly index: number;
  readonly text: string;
  readonly shape: string;
  readonly hue: string;
  readonly ink: string;
}

const TILE_SHAPES = ["▲", "◆", "●", "■"] as const;
const TILE_HUES = ["--terraform", "--consul", "--nomad", "--vault"] as const;
/** Light ink only where it clears 4.5:1. `--terraform` is 6.4:1; the rest are not. */
const TILE_LIGHT_INK = [true, false, false, false] as const;

export function answerTiles(answers: readonly string[]): AnswerTile[] {
  return answers.map((text, i) => ({
    index: i,
    text,
    shape: TILE_SHAPES[i % TILE_SHAPES.length] ?? "●",
    hue: `var(${TILE_HUES[i % TILE_HUES.length] ?? "--terraform"})`,
    ink: TILE_LIGHT_INK[i % TILE_LIGHT_INK.length]
      ? "var(--on-fill-light)"
      : "var(--on-fill-dark)",
  }));
}

/**
 * Milliseconds left, from the absolute epoch the server sent and the client's
 * corrected clock. Never a duration off the wire: a phone that received the
 * frame two seconds late still counts down to the same instant.
 */
export function remainingMs(closesAt: number | null, now: number): number | null {
  if (closesAt === null) return null;
  return Math.max(0, closesAt - now);
}

/** `00:14`. Ceiling, so the last second is shown as 1 and not as 0. */
export function formatCountdown(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * How much of the question's time is left, 0–1, for the shrinking bar.
 *
 * Drawn from `opensAt`/`closesAt` rather than the time limit, because the
 * time limit is what the CSV asked for and these two are what actually
 * happened — a question opened a second late still empties its bar exactly
 * when it closes.
 */
export function timerFraction(trivia: TriviaView, now: number): number | null {
  const { opensAt, closesAt } = trivia;
  if (opensAt === null || closesAt === null || closesAt <= opensAt) return null;
  const left = (closesAt - now) / (closesAt - opensAt);
  return Math.min(1, Math.max(0, left));
}

/** `Q7 of 20`, the line every surface puts above the question. */
export function questionLabel(trivia: TriviaView): string {
  return `Q${trivia.index + 1} of ${trivia.of}`;
}

export function connectedCount(state: RenderState): number {
  return state.roster.filter((r) => r.conn === "on").length;
}

/**
 * What a participant is told when the door is shut. The `nickname_taken` copy
 * is verbatim from SPEC.md: it has to tell them the one thing that fixes it,
 * which is asking the host, not retrying.
 */
export function refusalCopy(
  reason: RefusedReason,
  serverMessage: string,
  nickname: string,
): { title: string; detail: string; retry: boolean } {
  switch (reason) {
    case "nickname_taken":
      return {
        title: "That name is taken",
        detail: `${nickname} is already in this session. If that's you on another device, ask the host to release the name.`,
        retry: true,
      };
    case "invalid_nickname":
      return {
        title: "Pick another name",
        detail: serverMessage || "Two characters or more, please.",
        retry: true,
      };
    case "no_such_code":
      return {
        title: "No session with that code",
        detail: serverMessage || "Check the four letters and try again.",
        retry: true,
      };
    case "lobby_locked":
      return {
        title: "Joining is closed",
        detail:
          serverMessage || "The host has locked the lobby. Ask them to reopen it.",
        retry: true,
      };
    case "not_joinable":
      return {
        // Neutral, because the server message distinguishes a session that
        // has not opened yet from one that has finished.
        title: "Can't join this session",
        detail: serverMessage || "It is not open.",
        retry: true,
      };
    case "kicked":
      return {
        title: "You were removed",
        detail: serverMessage || "The host removed you from this session.",
        retry: false,
      };
    case "rate_limited":
      return {
        title: "Too many tries",
        detail: serverMessage || "Wait a moment, then try again.",
        retry: true,
      };
    case "bad_token":
      return {
        title: "That link is not valid",
        detail: serverMessage || "Ask whoever sent it for a fresh one.",
        retry: false,
      };
    case "malformed":
      return {
        title: "Something went wrong",
        detail: serverMessage || "Reload the page.",
        retry: true,
      };
  }
}


/* ------------------------------------------------------------------ */
/* The arcade register                                                 */
/* ------------------------------------------------------------------ */

/**
 * DESIGN.md's recast palette, as CSS values, in one place.
 *
 * | Motif | Colour | Used for |
 * | --- | --- | --- |
 * | Players | `--nomad` green | number badges, "on the Floor", the PLAN light |
 * | Staff | `--consul` pink | round cards, APPLY / STATE LOCKED, the drain |
 * | VIP Lounge | `--vault` gold | the welcome card, backing chips, VIP points |
 * | The House | `--terraform` purple | the Front-End Man, the arcade's top five |
 *
 * Two entries per motif, because a brand hue used as a *fill* and the same
 * hue used as *text* are not the same colour problem. The fills are the
 * product hues and do not move between themes; the inks do, because
 * `--terraform` as text measures 3.07:1 on the dark ground and `--vault` as
 * text measures 1.48:1 on white. Both fail DESIGN.md's own 4.5:1 floor, which
 * is the same failure DESIGN.md already had to correct once for the trivia
 * tiles. The ink tokens are defined in tokens.css and measured there.
 */
export interface ArcadeHue {
  /** The brand hue, as a fill. */
  readonly fill: string;
  /** Ink that reads on that fill. */
  readonly on: string;
  /** The same motif as text on the page ground, per theme. */
  readonly ink: string;
}

export const ARCADE_PALETTE: Readonly<Record<
  "players" | "staff" | "lounge" | "house",
  ArcadeHue
>> = {
  players: { fill: "var(--nomad)", on: "var(--on-fill-dark)", ink: "var(--arc-players)" },
  staff: { fill: "var(--consul)", on: "var(--on-fill-dark)", ink: "var(--arc-staff)" },
  lounge: { fill: "var(--vault)", on: "var(--on-fill-dark)", ink: "var(--arc-lounge)" },
  house: { fill: "var(--terraform)", on: "var(--on-fill-light)", ink: "var(--arc-house)" },
};

/** Three digits, zero-padded. *Player 017 has been drained.* */
export function playerTag(n: number): string {
  return String(n).padStart(3, "0");
}

/** `Player 017`, the only name the arcade uses when the news is bad. */
export function playerName(n: number): string {
  return `Player ${playerTag(n)}`;
}

export const ARCADE_ROUND_LABEL: Readonly<Record<ArcadeRoundKind, string>> = {
  recruitment: "Recruitment",
  plan_apply: "Plan / Apply",
  unseal: "Unseal",
  tug_of_raft: "Tug of Raft",
  gganbu: "Gganbu",
  glass_bridge: "The Glass Bridge",
};

/**
 * The round cards, verbatim from DESIGN.md "Copy, and how it is said".
 *
 * Verbatim matters here more than anywhere else in the product: the tone is
 * the feature, and "no exclamation marks, ever" is not a thing a renderer can
 * enforce if every surface writes its own version of the line.
 *
 * Game numbers are DESIGN.md's — Plan / Apply is *Game 1* — so the card says
 * what the announcer says, not what index the host happens to have run it at.
 */
export const ARCADE_ROUND_CARD: Readonly<
  Record<ArcadeRoundKind, readonly string[]>
> = {
  recruitment: [
    "The next game will begin shortly.",
    "Please remain seated. Please do not run terraform destroy.",
  ],
  plan_apply: [
    "Game 1 — Plan / Apply",
    "Advance during PLAN. Do not touch your device during APPLY.",
    "The state lock is held by the doll.",
  ],
  unseal: [
    "Game 2 — Unseal",
    "Choose a shape. You will be given a sealed tin.",
    "Reading the docs is permitted. It will cost you.",
  ],
  tug_of_raft: [
    "Game 3 — Tug of Raft",
    "Two clusters. One rope. Tap on the heartbeat.",
    "Followers who miss three heartbeats will call an election.",
    "Elections achieve nothing.",
  ],
  gganbu: [
    "Game 4 — Gganbu",
    "You have been paired. You each hold ten tokens.",
    "Tokens expire at the end of the round. Wager accordingly.",
  ],
  glass_bridge: [
    "Game 5 — The Glass Bridge",
    "Eighteen panes. Nine are tempered. The tempered ones are real.",
    "Wave 1 goes first. Wave 1 has our sympathy.",
  ],
};

/** The staff card, which appears once, before Game 1. DESIGN.md's joke. */
export const STAFF_CARD: readonly string[] = [
  "○ reads the plan",
  "△ runs the apply",
  "□ approves the PR",
];

/**
 * Every announcer line the system needs, written once so that "how they are
 * said" survives being said from three different files. DESIGN.md's table.
 */
export const HOUSE = {
  welcome: (n: number) =>
    `Welcome. You have been recruited. You are ${playerName(n)}.`,
  recruited: "Recruited.",
  checkpoint: (resources: number) =>
    `${resources} resources applied. Progress banked.`,
  crossed: (target: number) =>
    `Apply complete. Resources: ${target} added, 0 changed, 0 destroyed.`,
  drained: (n: number) => `${playerName(n)} drained.`,
  backedSurvived: "Your player survived. The Lounge is pleased.",
  roundEnd: "All nodes rescheduled. The next game will begin shortly.",
  arcadeEnd: "The games have concluded. Please return your tracksuit.",
} as const;

/**
 * The error a tap during the lock produces, verbatim.
 *
 * SPEC.md: "The screen shows the error verbatim, mono, red, the way it looks
 * in a real terminal." Terraform's own wording, which is the joke: nothing
 * here is invented, and that is why it is funny.
 */
export const STATE_LOCK_ERROR = "Error: state lock held by another process";

/**
 * The two lights, with everything a surface needs to draw one — including two
 * signals that are not colour.
 *
 * DESIGN.md's accessibility floor says nothing may be distinguished by colour
 * alone, and a red/green pair is the exact case that fails: roughly one man in
 * twelve cannot tell these two hues apart on a compressed video tile. So each
 * light carries a **word** (`PLAN` / `APPLY IN PROGRESS — STATE LOCKED`), a
 * **glyph** (an open circle against a filled square), and a *state* the phone
 * expresses as a disabled control with a padlock. The colour is the fourth
 * signal, not the first.
 */
export interface LightFace {
  readonly light: "plan" | "apply";
  /** What the big screen puts in display type. */
  readonly sign: string;
  /** What the phone's one button says. */
  readonly button: string;
  /** Shape, not colour. */
  readonly glyph: string;
  readonly fill: string;
  readonly on: string;
  /** Read out by a screen reader when the light turns. */
  readonly announce: string;
}

export const LIGHT_FACE: Readonly<Record<"plan" | "apply", LightFace>> = {
  plan: {
    light: "plan",
    sign: "PLAN",
    // Not "APPLY". The sign in the pink state reads APPLY IN PROGRESS — STATE
    // LOCKED, so putting APPLY on the green button makes one word mean both
    // "press me" and "do not press me", on a phone held at arm's length, under
    // a timer, where the two states are a glance apart. SPEC calls each tap a
    // resource, so the button says what the tap does and collides with
    // nothing.
    button: "+1 RESOURCE",
    glyph: "○",
    fill: ARCADE_PALETTE.players.fill,
    on: ARCADE_PALETTE.players.on,
    announce: "Plan. Tap to apply.",
  },
  apply: {
    light: "apply",
    sign: "APPLY IN PROGRESS — STATE LOCKED",
    button: "LOCKED",
    glyph: "■",
    fill: ARCADE_PALETTE.staff.fill,
    on: ARCADE_PALETTE.staff.on,
    announce: "State locked. Do not tap.",
  },
};

/**
 * Milliseconds until the doll's head starts to turn, or null when the surface
 * has not been told — which is every surface but the big screen and the
 * console, on purpose: see `ArcadePlanApplyView` in protocol.ts.
 *
 * Negative once the turn has started, so a caller can tell "turning" from
 * "not yet": the wipe runs from 0 down to `-LIGHT_TELEGRAPH_MS`.
 */
export function msToTurn(
  planApply: { readonly headTurnsAt?: number },
  now: number,
): number | null {
  return planApply.headTurnsAt === undefined ? null : planApply.headTurnsAt - now;
}

/**
 * How far through the 400 ms wipe the screen is, 0 → 1. Null when there is
 * nothing to draw.
 */
export function wipeFraction(
  planApply: { readonly headTurnsAt?: number; readonly nextChangeAt?: number },
  now: number,
): number | null {
  const { headTurnsAt, nextChangeAt } = planApply;
  if (headTurnsAt === undefined || nextChangeAt === undefined) return null;
  if (now < headTurnsAt) return null;
  if (now >= nextChangeAt) return 1;
  const span = nextChangeAt - headTurnsAt;
  return span <= 0 ? 1 : (now - headTurnsAt) / span;
}

/** One grid cell, joined to the roster the same socket already carries. */
export interface GridEntry {
  readonly pid: string;
  readonly playerNumber: number;
  readonly tag: string;
  readonly standing: "floor" | "drained";
  readonly backers: number;
  readonly struck: boolean;
  /** Away is grey, per DESIGN.md's grid. From the roster, not the cell. */
  readonly away: boolean;
  /**
   * Phone only. The big screen renders the tag and never this: DESIGN.md is
   * explicit that the nickname belongs on the phone, "where the person it
   * belongs to is the only reader".
   */
  readonly nickname: string;
}

export function gridEntries(
  arcade: ArcadeView,
  roster: readonly RosterEntry[],
): GridEntry[] {
  const by = new Map(roster.map((r) => [r.pid, r]));
  return arcade.grid.map((cell: ArcadeCell) => {
    const r = by.get(cell.pid);
    return {
      pid: cell.pid,
      playerNumber: cell.playerNumber,
      tag: playerTag(cell.playerNumber),
      standing: cell.standing,
      backers: cell.backers,
      struck: cell.struck,
      away: r?.conn === "away",
      nickname: r?.nickname ?? "",
    };
  });
}

/** Everyone still on the Floor, for the Lounge's list of people to back. */
export function floorEntries(
  arcade: ArcadeView,
  roster: readonly RosterEntry[],
  exclude?: string,
): GridEntry[] {
  return gridEntries(arcade, roster).filter(
    (e) => e.standing === "floor" && e.pid !== exclude,
  );
}

/**
 * The progress bar for Plan / Apply, as a fraction and three tick positions.
 *
 * The ticks are the engine's checkpoints, sent on the wire rather than
 * recomputed here, so the bar cannot draw a tick where no points are banked.
 */
export function resourceBar(
  planApply: { readonly target: number; readonly checkpoints: readonly number[] },
  resources: number,
): { readonly fraction: number; readonly ticks: readonly number[] } {
  const target = Math.max(1, planApply.target);
  return {
    fraction: Math.min(1, Math.max(0, resources / target)),
    ticks: planApply.checkpoints.map((c) => Math.min(1, c / target)),
  };
}

/* ------------------------------------------------------------------ */
/* Activity colour                                                     */
/* ------------------------------------------------------------------ */

/**
 * The accent for an activity, as a CSS value.
 *
 * DESIGN.md fixes the assignment by activity — "once a participant learns that
 * pink is trivia, pink is trivia on the phone, on the screen and in the
 * console" — so the id wins, the kind is the fallback for a session that names
 * its activities something else, and after that it cycles the product hues so
 * a fourth activity is never invisible.
 *
 * The accent is not on the wire; see the report. Until it is, this function is
 * the single place the three surfaces agree.
 */
const HUE_BY_ID: Readonly<Record<string, string>> = {
  ttx: "--ttx",
  trivia: "--trivia",
  arcade: "--arcade",
};

const HUE_BY_KIND: Readonly<Record<string, string>> = {
  manual: "--ttx",
  trivia: "--trivia",
  arcade: "--arcade",
};

const HUE_CYCLE: readonly string[] = [
  "--terraform",
  "--consul",
  "--nomad",
  "--ibm-blue",
];

/** Spot Awards are gold on every surface, and never an activity's hue. */
export const SPOT_HUE = "var(--spot)";

export function activityHue(
  activity: { readonly id: string; readonly kind: string },
  index = 0,
): string {
  const named = HUE_BY_ID[activity.id] ?? HUE_BY_KIND[activity.kind];
  const cycled = HUE_CYCLE[index % HUE_CYCLE.length] ?? "--terraform";
  return `var(${named ?? cycled})`;
}

/**
 * The short, tabular name of an activity: `TTX`, `TRIVIA`, `ARCADE`.
 *
 * The title is what the console and the big screen legend use; this is for
 * the places that have a phone's width to spend, which is the points strip.
 */
export function activityLabel(activity: { readonly id: string }): string {
  return activity.id.toUpperCase().slice(0, 8);
}

/* ------------------------------------------------------------------ */
/* The points strip                                                    */
/* ------------------------------------------------------------------ */

export interface StripCell {
  readonly label: string;
  /** Null renders as an em dash: nothing scored there yet. */
  readonly value: number | null;
  readonly hue: string;
}

/**
 * `YOU 143 · TTX 80 · TRIVIA 63`, as cells.
 *
 * `own` is absent whenever the standings are sealed — the server omits it —
 * and the strip shows no numbers at all in that case. It is never remembered
 * from before the seal: a total kept through the seal is a sealed total on
 * screen, which is the one thing the seal exists to prevent.
 *
 * The order is the session's activity order, not the key order of an object
 * that arrived over a socket.
 */
export function pointsStripCells(
  own: OwnPoints | null,
  activities: readonly ActivitySummary[],
): StripCell[] {
  if (own === null) return [];
  return activities.map((a, i) => ({
    label: activityLabel(a),
    value: own.byActivity[a.id] ?? null,
    hue: activityHue(a, i),
  }));
}

/* ------------------------------------------------------------------ */
/* The stacked bar                                                     */
/* ------------------------------------------------------------------ */

export interface BarSegment {
  /** An activity id, or `spot`. */
  readonly key: string;
  readonly label: string;
  readonly points: number;
  readonly hue: string;
  /** This activity was credited, not played. Drawn hatched as well as dimmed. */
  readonly bench: boolean;
  /** Width as a percentage of the widest row, so rows compare to each other. */
  readonly percent: number;
}

/** A positive contribution narrower than this is a bar nobody can see. */
const MIN_VISIBLE_PERCENT = 1;

/**
 * One standings row as contributions in activity hues, plus the Spot Awards
 * in gold. `scale` is the top total on the board, so the leader's bar fills
 * the width and everyone else reads against it.
 *
 * Only what arrived is drawn. There is no inference here about activities the
 * server did not send, and no total is recomputed from the parts — the server
 * does the arithmetic and `total` is what it said.
 */
export function stackedBar(
  row: {
    readonly perActivity: Readonly<Record<string, number | null>>;
    readonly bench: readonly string[];
    readonly spot: number;
  },
  activities: readonly ActivitySummary[],
  scale: number,
): BarSegment[] {
  const out: BarSegment[] = [];
  const pct = (points: number): number => {
    if (scale <= 0 || points <= 0) return 0;
    return Math.max(MIN_VISIBLE_PERCENT, (points / scale) * 100);
  };
  activities.forEach((a, i) => {
    const points = row.perActivity[a.id] ?? 0;
    if (points <= 0) return;
    out.push({
      key: a.id,
      label: a.title,
      points,
      hue: activityHue(a, i),
      bench: row.bench.includes(a.id),
      percent: pct(points),
    });
  });
  if (row.spot > 0) {
    out.push({
      key: "spot",
      label: "Spot Awards",
      points: row.spot,
      hue: SPOT_HUE,
      bench: false,
      percent: pct(row.spot),
    });
  }
  return out;
}

/** The same thing as one line of text, for the screen reader and for tests. */
export function pointsStripText(
  own: OwnPoints | null,
  activities: readonly ActivitySummary[],
): string {
  if (own === null) return "YOU —";
  const parts = [`YOU ${own.total}`];
  for (const cell of pointsStripCells(own, activities)) {
    parts.push(`${cell.label} ${cell.value === null ? "—" : cell.value}`);
  }
  return parts.join(" · ");
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}
