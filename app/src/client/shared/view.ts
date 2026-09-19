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
  OwnPoints,
  RefusedReason,
  RenderState,
  TriviaView,
} from "../../protocol.ts";
import type { Segment } from "../../engine/types.ts";

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
 * console has to be able to say which of those two facts it means. The arcade
 * is the only thing left that puts a placeholder in front of the room.
 */
export const SEGMENT_BUILT: Readonly<Record<Segment, boolean>> = {
  lobby: true,
  holding: true,
  trivia: true,
  arcade: false,
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
  "standings",
  "final",
];

export function nextSegment(current: Segment): Segment | null {
  const i = RUN_OF_SHOW.indexOf(current);
  if (i === -1) return "standings"; // off-piste (the arcade): come back
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
