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
  ArcadeGlassView,
  ArcadeMine,
  ArcadeRecruitmentView,
  ArcadeTugView,
  ArcadeView,
  OwnPoints,
  RefusedReason,
  RenderState,
  RosterEntry,
  StandingRow,
  TriviaView,
} from "../../protocol.ts";
import type {
  ArcadeRoundKind,
  GlassWave,
  Segment,
  UnsealShape,
} from "../../engine/types.ts";

export type ViewKind =
  | "waiting"
  | "lobby"
  | "holding"
  | "trivia"
  | "arcade"
  | "standings"
  | "sendoff"
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
  holding: "Holding card",
  trivia: "Trivia",
  arcade: "Arcade",
  standings: "Standings",
  sendoff: "Send-off",
  final: "Final",
};

/** The phase that builds each segment's surface. */
export const SEGMENT_PHASE: Readonly<Record<Segment, number>> = {
  lobby: 1,
  holding: 1,
  trivia: 3,
  arcade: 4,
  standings: 1,
  sendoff: 1,
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
  sendoff: true,
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
 * corrected to match, and carries the measured figures. Re-measured after
 * the hues were grounded in HDS (`--consul` #dc477d -> #e03875, `--nomad`
 * #00ca8e -> #06d092): 5.76 / 4.70 / 9.82 / 13.36. Consul's 4.70 is the
 * thin one; darkening that hue further means measuring again.
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

/* ------------------------------------------------------------------ */
/* The lobby: who is drawn, and who is still arriving                  */
/* ------------------------------------------------------------------ */

/**
 * The longest name drawn on an arriving entry in the lobby's cluster.
 *
 * Nicknames are capped well above this, and one that long centred over a
 * 240-unit viewBox runs past both the leader and the links. Clipped with an
 * ellipsis rather than shrunk to fit: the cluster is decoration and the chip
 * with the full name is a few pixels away, so a name that does not fit loses
 * its tail instead of costing everything else legibility.
 */
export const RAFT_NAME_MAX = 13;

/** Unicode-safe truncation: never split a surrogate pair or a ZWJ sequence. */
export function clipName(who: string, max: number = RAFT_NAME_MAX): string {
  // `slice` counts UTF-16 code units, so it cut "Sam 🎉" through the middle of
  // the emoji and rendered a lone high surrogate as a replacement character.
  // Segmenter where there is one, code points everywhere else — both keep a
  // pair together, and only the first also keeps a family emoji together.
  const units =
    typeof Intl !== "undefined" && "Segmenter" in Intl
      ? Array.from(new Intl.Segmenter().segment(who), (g) => g.segment)
      : Array.from(who);
  if (units.length <= max) return who;
  return `${units.slice(0, max - 1).join("")}…`;
}

/**
 * Match a nickname to its owner, so "Sam " and "sam" find the same person.
 *
 * Deliberately *not* the engine's `nicknameKey`, which also normalises to
 * NFKD, strips combining marks and drops everything non-alphanumeric. This
 * is strictly finer than that one, which is the direction that is safe: two
 * names equal here are necessarily equal there, so a collision here would
 * already have been refused at the door as `nickname_taken`. Copying the
 * engine's rule into the client would be a second copy to keep in step for
 * no gain.
 */
export function nickKey(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * How many names the lobby draws before it starts counting the rest.
 *
 * A layout limit, not a product one: past this the chips wrap past the
 * bottom of the surface and the list stops being readable at a glance.
 */
export const LOBBY_CHIP_MAX = 24;

/** The lobby's room, as the chips row draws it. */
export interface LobbyRoom {
  /** The head count, which is how many the cluster has committed. */
  readonly count: number;
  /** Your own entry, pinned first and drawn as `is-you`, or null. */
  readonly you: RosterEntry | null;
  /** The names drawn after it, in the order they are appended. */
  readonly shown: readonly RosterEntry[];
  /** How many committed people are not drawn. 0 draws no counter chip. */
  readonly over: number;
}

/**
 * Who the lobby draws, from the set of people the cluster has committed.
 *
 * Three decisions, and each of them has been wrong at some point in a way a
 * person in the room would have felt:
 *
 * The list is drawn from `committed` and not from the roster, and so is the
 * count. A count that ran ahead of the list would be the one thing on the
 * screen contradicting it — "12 committed" over eleven chips — and somebody
 * looking for their own name would be counting.
 *
 * It keeps the *last* `cap` names and not the first. Taking the first meant
 * that in any room over the cap every latecomer — exactly the people the
 * cluster animates, and the only people for whom the list is still news —
 * landed in the counter and never appeared at all.
 *
 * And `you` comes out of the run and is pinned, because the box clips from
 * the bottom: your own name and the notice that names are missing used to sit
 * at the *end* of the flow, so in a short window they were the first two
 * things cut. `over` is therefore counted against a budget one smaller when
 * you are in the room, and it always equals the number of people the caller
 * is not being handed.
 */
export function lobbyRoom(
  roster: readonly RosterEntry[],
  committed: ReadonlySet<string>,
  mine: string | null,
  cap: number = LOBBY_CHIP_MAX,
): LobbyRoom {
  const room = roster.filter((r) => committed.has(r.pid));
  const key = mine === null ? null : nickKey(mine);
  const you = key === null ? null : room.find((r) => nickKey(r.nickname) === key) ?? null;
  const others = you === null ? room : room.filter((r) => r !== you);
  const budget = you === null ? cap : cap - 1;
  const over = Math.max(0, others.length - budget);
  return { count: room.length, you, shown: others.slice(over), over };
}

/** One arrival, as the cluster is asked to draw it. A null pid is the room. */
export interface RaftEntry {
  readonly who: string | null;
  readonly pid: string | null;
}

/** What the lobby does with a render: hold these, animate those. */
export interface LobbyAdmission {
  /** Pids straight into the list, with no commit drawn for them. */
  readonly hold: readonly string[];
  /** Commits to draw, in order. */
  readonly commit: readonly RaftEntry[];
  /** True on the one render that plays your own arrival. */
  readonly yours: boolean;
}

/**
 * What a lobby render admits, given who it saw last time.
 *
 * `seen` is null until the first render, and the first render is the whole of
 * this function's difficulty. Arriving into a room of eleven should not replay
 * eleven commits — it should say eleven are committed — so everybody already
 * here is held, and exactly one commit plays: **yours**.
 *
 * Including, on that first render, your own name. The first version of this
 * held everyone except the viewer, because the viewer's own pid is already in
 * the very first frame the server sends them — so the one person whose moment
 * it was got a nameless "entry appended" and saw their name already in the
 * list, while everybody else's screen animated it. The events are virtual;
 * nobody is looking over a shoulder, so that meant the moment was shown to
 * everyone it did not belong to.
 *
 * `welcomed` is whether this page has already played that arrival for this
 * session. The lobby is rebuilt whenever the host changes what is on screen,
 * and the third time somebody watches themselves join they are not being
 * welcomed, they are watching a loop — so a second first-render commits the
 * room as one, with no name, and an empty room commits nothing at all. The
 * console's lobby preview has no nickname of its own and takes that path too.
 *
 * Every later render commits only the pids that are new. The lobby re-renders
 * on anything — somebody going away, the host locking joins — and animating
 * those would make the picture mean "a frame arrived" rather than "somebody
 * joined".
 */
export function lobbyAdmission(
  roster: readonly RosterEntry[],
  seen: ReadonlySet<string> | null,
  nickname: string | null,
  welcomed: boolean,
): LobbyAdmission {
  if (seen !== null) {
    const fresh = roster.filter((r) => !seen.has(r.pid));
    return {
      hold: [],
      commit: fresh.map((r) => ({ who: r.nickname, pid: r.pid })),
      yours: false,
    };
  }
  const key = nickname === null ? null : nickKey(nickname);
  const me = key === null ? undefined : roster.find((r) => nickKey(r.nickname) === key);
  const yours = me !== undefined && !welcomed;
  const hold = roster.filter((r) => !(yours && r.pid === me.pid)).map((r) => r.pid);
  if (yours) return { hold, commit: [{ who: me.nickname, pid: me.pid }], yours };
  // The room, arriving as one. Not a person, so no name — and "appending"
  // nobody into a cluster of nobody is a sentence about nothing.
  return { hold, commit: roster.length > 0 ? [{ who: null, pid: null }] : [], yours };
}

/**
 * How many arrivals may wait for an animation before the oldest stops waiting.
 *
 * A room scanning a QR at once arrives in a burst, and queueing keeps each
 * commit readable instead of drawing nine at once. The cap is there because
 * nobody watches the ninth: a commit takes nearly three seconds, so a queue
 * of nine would still be draining long after the room had stopped looking.
 */
export const RAFT_QUEUE_MAX = 3;

/** What the cluster can see about itself, asked afresh at every decision. */
export interface RaftMood {
  /** Nobody can watch this: a hidden tab, or no room on screen to draw in. */
  readonly unseen: boolean;
  /** `prefers-reduced-motion: reduce`, which can be turned on mid-burst. */
  readonly still: boolean;
  /** A commit is on screen now. */
  readonly running: boolean;
}

/** What to do about one decision. The caller draws it; this decides it. */
export interface RaftPlan {
  /** Pids released into the lobby's list now, in order. */
  readonly release: readonly string[];
  /** The queue afterwards. */
  readonly queue: readonly RaftEntry[];
  /** The entry to start drawing now, or null for nothing to draw. */
  readonly begin: RaftEntry | null;
}

/** Every pid in `entries`, in order, skipping the room's nameless commit. */
function pids(entries: readonly RaftEntry[]): string[] {
  return entries.flatMap((e) => (e.pid === null ? [] : [e.pid]));
}

/**
 * A join arrives. Draw it, queue it, or let it straight through.
 *
 * The invariant this and {@link raftDrain} exist to hold is that **every pid
 * handed in is accounted for**: it is released, or it is begun, or it is still
 * in the queue. A pid that falls out of all three is a person who joined and
 * whose name never appeared, which is worse than any animation is good.
 *
 * That is why the cap releases the *oldest* waiting entry rather than dropping
 * the newest. Dropping was fine while this only drove a picture; now that it
 * gates the list, a dropped entry is somebody who joined and was never drawn.
 * Twenty people scanning at once get four animations and sixteen names, which
 * is the right way round — the names are the promise.
 *
 * Nothing waits while nobody is watching, and nothing waits under reduced
 * motion: a queue is for keeping an animation readable, and neither of those
 * has an animation to keep readable.
 */
export function raftArrival(
  queue: readonly RaftEntry[],
  entry: RaftEntry,
  mood: RaftMood,
): RaftPlan {
  if (mood.unseen) return { release: pids([entry]), queue: [...queue], begin: null };
  if (!mood.running || mood.still) return { release: [], queue: [...queue], begin: entry };
  const rest = [...queue];
  const release = rest.length >= RAFT_QUEUE_MAX ? pids(rest.splice(0, 1)) : [];
  rest.push(entry);
  return { release, queue: rest, begin: null };
}

/**
 * A commit finished. Whatever is next, decided now rather than when it was
 * queued.
 *
 * The conditions are re-asked here on purpose. Both drains used to go straight
 * to the animation, which meant a preference or a window that changed *during*
 * a burst was honoured for the arrival that changed it and ignored for
 * everything already waiting: turning on reduced motion mid-rush still
 * animated the three queued names in full, the last of them seven seconds
 * later. Under reduced motion everyone waiting arrives together and the last
 * of them carries the one state change; with nobody watching, all of them do.
 */
export function raftDrain(queue: readonly RaftEntry[], mood: RaftMood): RaftPlan {
  const rest = [...queue];
  if (mood.unseen) return { release: pids(rest), queue: [], begin: null };
  const release = mood.still ? pids(rest.splice(0, Math.max(0, rest.length - 1))) : [];
  const begin = rest.shift() ?? null;
  return { release, queue: rest, begin };
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
/* The scoring surfaces: the sealed line, and the pace of the reveal    */
/* ------------------------------------------------------------------ */

/**
 * What the sealed screen says under "Scores are hidden", on every surface.
 *
 * Deliberately a constant and *not* `state.holding.line`, which is what the
 * phone and the Desktop both used to read. `holding` is the last card the
 * host set, not the card on screen — the engine clears it only on a restart —
 * so a session whose last card named an activity and its facilitator sealed
 * its scores under "Scores are hidden" followed by that facilitator's name,
 * which is what a real room saw. The lobby had the same bug and
 * was fixed the same way: a card's second line belongs to that card, and a
 * screen that wants a line of its own is given one.
 */
export const SEALED_LINE = "Revealed at the end.";

/**
 * The pace of the final reveal, in one place because two surfaces play it.
 *
 * The Desktop cuts 5th, 4th, 3rd, 2nd on a four-second dwell — video latency
 * is one to two seconds, so a step that shows for two was never seen — holds
 * an empty first place for seven, and then shows the winner. The protocol has
 * no step message for the phone to follow, so the phone counts the same
 * arithmetic from the moment the final standings arrive and shows nothing
 * until the Desktop would have landed on the winner.
 *
 * Both surfaces read these numbers from here rather than each keeping their
 * own, because the failure mode of two copies is the whole bug this exists to
 * prevent: thirty phones announcing the winner while the room is still
 * looking at an empty first place.
 */
export const FINAL_DWELL_MS = 4_000;
export const FINAL_EMPTY_FIRST_HOLD_MS = 7_000;

/**
 * When the winner lands, in milliseconds after the final standings arrive.
 *
 * Zero for an empty result: there is no climb to pace, and both surfaces say
 * "no scores were recorded" straight away rather than pacing a reveal of
 * nothing. A result with no first place — which the engine does not produce —
 * still waits out the hold, because the honest answer to "when has the
 * Desktop finished" is "when its last timer has fired".
 */
export function finalRevealMs(rows: readonly StandingRow[]): number {
  if (rows.length === 0) return 0;
  const climb = rows.filter((r) => r.rank > 1).length;
  return climb * FINAL_DWELL_MS + FINAL_EMPTY_FIRST_HOLD_MS;
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
 * `--terraform` as text measures 3.15:1 on the dark ground and `--vault` as
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
 * SPEC.md's round numbers, which are the ones the room hears.
 *
 * Not `roundIndex + 1`. `roundIndex` is where the round fell in *this* run —
 * the host picks the order — and numbering off it made the console say
 * `ROUND 1 · RECRUITMENT` while the card in front of thirty people said
 * *Game 1 — Plan / Apply*. SPEC.md's table numbers Recruitment 0 and
 * Plan / Apply 1, and DESIGN.md's round cards agree, so the number belongs to
 * the round and not to its position in one host's run of show.
 */
export const ARCADE_ROUND_NUMBER: Readonly<Record<ArcadeRoundKind, number>> = {
  recruitment: 0,
  plan_apply: 1,
  unseal: 2,
  tug_of_raft: 3,
  gganbu: 4,
  glass_bridge: 5,
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
    // Twelve, not eighteen: the launch board is six steps of two panes. The
    // show has eighteen and DESIGN quoted it, which meant the card announced a
    // bridge a third longer than the one on the screen behind it.
    "Twelve panes. Six are tempered. The tempered ones are real.",
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
  /**
   * DESIGN.md: `> Pane 4 was not tempered. Player 017 drained.`
   *
   * "Pane 4" is the fourth *step*, 1-based, and it is deliberately not which
   * of the two panes at that step: the line goes on the big screen, in a room
   * that still has two waves in it who have not crossed. Saying which pane
   * broke would be saying which pane is real — see {@link ArcadeGlassView} —
   * and the engine will not tell this surface either way until the step
   * closes.
   */
  glassPane: (step: number) => `Pane ${step} was not tempered.`,
  glassFall: (step: number, n: number) =>
    `Pane ${step} was not tempered. ${playerName(n)} drained.`,
  /**
   * The other way off the bridge, which DESIGN.md has no line for because it
   * is not in the show: the step closed and you had not put your weight
   * anywhere. Written in the same register and saying the true thing, so the
   * phone does not tell somebody they stood on a pane they never touched.
   */
  glassPaneMissed: (step: number) => `Pane ${step} was not chosen.`,
  glassTimeout: (step: number, n: number) =>
    `Pane ${step} was not chosen. ${playerName(n)} drained.`,
  /** DESIGN.md, verbatim, and the funniest line in the product. */
  glassCrossed: (n: number) =>
    `${playerName(n)} has reached the far side. It is not very interesting there.`,
  /**
   * The first wrong letter, which is the beat the round did not have.
   *
   * DESIGN.md's sentence — `> The tin has cracked.` — said the round was over,
   * because it was: one wrong tap drained you. The round is two strikes now, so
   * the sentence goes where it is literally true, on the tin that is damaged
   * and still being tapped, and the drain gets the shatter below.
   *
   * Three clauses, the shape `unsealDocs` already uses on this phone in this
   * slot: what happened, what it cost, and what it means for the next tap. The
   * cost is said because it is the same halving the docs button prices itself
   * with on the screen underneath, and a halving nobody is told about is a
   * number the player cannot work back to a rule. Nothing in it names another
   * player: a crack is the one thing in this round that stays between the tin
   * and the person holding it.
   */
  unsealCracked: "The tin has cracked. Score halved. One more wrong letter shatters it.",
  /**
   * The second wrong letter, and the end of the tin. DESIGN.md: `> The tin has
   * shattered. Player 017 drained.`
   *
   * DESIGN.md's row was one line — *The tin has cracked. Player 017 drained.* —
   * because the round was one strike. It is two rows now: the sentence about
   * cracking went to the crack, where it is literally true, and the drain needed
   * a verb of its own, because the same words twice, once as a warning and once
   * as an ending, is the phone saying nothing.
   *
   * Split in two the way the bridge's fall is, and for the same reason: the
   * phone says the half that is about the tin, because the person reading it
   * already knows whose tin it was, and the Desktop says both halves because
   * the room does not. The Desktop hears about this beat and not the crack —
   * a screen that named whoever is one tap from the Lounge would be handing the
   * Lounge a result to bet against for nothing.
   */
  unsealShattered: "The tin has shattered.",
  unsealShatter: (n: number) =>
    `The tin has shattered. ${playerName(n)} drained.`,
  /**
   * The other end of the same tin, which DESIGN.md has no line for.
   *
   * The House narrated every way to lose — the crack, the fall, the state lock,
   * the heartbeat timeout — and exactly one way to win, the Plan / Apply
   * crossing. An announcer who only speaks when somebody loses is a different
   * game from the one DESIGN.md is describing, and Unseal is where the gap was
   * widest: losing a tin had a line and opening one had silence. The phone
   * says this one in its own House slot the frame the server agrees the tin is
   * open — see `paintUnseal` in the participant's view.ts.
   *
   * `Sealed: false` is what `vault status` says with the seal off, near enough
   * to be the joke: the command lays it out as two columns — `Sealed` on the
   * left and `false` on the right, no colon — and the colon here is this file's,
   * because a House line is a sentence and not a table. The field and the value
   * are Vault's, and that is the register: the line says what has happened to
   * the tin, and no part of it is invented.
   *
   * **Not split the way the shatter is, and that is a decision about the
   * Desktop.** `unsealShattered` / `unsealShatter` are a pair because the big
   * screen says who was drained; there is no `unsealOpen(n)` to match, because
   * on that surface this round is counts and never people until the reveal —
   * see the tins in the screen's main.ts, and `arcadeUnsealFor`, which will not
   * send it who is fastest in a shape before the reveal either. "Player 017
   * opened the tin", on a screen three metres from Player 017, is a result the
   * Lounge can bet on for a certainty. The Desktop's half of this beat needs a
   * surface that does not exist yet and a decision this line cannot make for
   * it, so it is not written here waiting to be wired up wrongly.
   */
  unsealOpened: "Sealed: false.",
  /**
   * DESIGN.md, verbatim, and the line the whole button is for.
   *
   * "Nobody will know" is true and is the joke: reading the docs looks
   * identical from outside — it is one more letter — and the halving is a
   * number only this phone and the console ever see.
   */
  unsealDocs: "Reading the docs. Score halved. Nobody will know.",
  /** DESIGN.md, verbatim. **Node**, not Player: in this round you are a node. */
  tugElection: (n: number) =>
    `Heartbeat timeout. Node ${playerTag(n)} called an election. Nothing happened.`,
  /** The other half of the same joke, said once the node is back. */
  tugElected: "Election complete. No change of leadership.",
  /**
   * Tug of Raft's win line, which the round did not have. Three pulls went by
   * and the only thing the House said was that somebody's node had timed out.
   *
   * It names the side because the Desktop and the phone both already label them
   * SIDE A and SIDE B, and it does not say anybody won: a pull is a log entry
   * that committed, and in the one round where nobody is drained the entry is
   * all that was ever at stake. That is the same joke as "Elections achieve
   * nothing", told from the winning end.
   *
   * The phone reads it off `wins` changing, in its own slot beside the election
   * line — see `paintTug` in the participant's view.ts. A pull that ends level
   * moves neither number and is announced as nothing: there is no side to name.
   */
  tugPullWon: (side: 0 | 1) =>
    `Side ${side === 0 ? "A" : "B"} has the rope. The entry is committed.`,
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

/* ------------------------------------------------------------------ */
/* The rule, on the player's own screen                                */
/* ------------------------------------------------------------------ */

/**
 * One line per activity, on the participant's own screen, while it is being
 * played: what you do, and what it costs you.
 *
 * The instructions the room gets are the Desktop's round card, and the card
 * is up for twenty seconds before the round. That works for a room reading
 * together and for nobody else: somebody who joined late, or who was looking
 * at the video call, or who is in their second window and never saw the big
 * screen, arrives at a surface that used to say "Pick one. It is final." and,
 * in Plan / Apply and on the bridge, effectively nothing. The card is theatre
 * and it is gone; this is the rule and it stays.
 *
 * So these are deliberately *not* in the Front-End Man's register — no
 * announcer, no `>` prompt, no joke. They are the plainest sentences in the
 * product. `ARCADE_ROUND_CARD` beside them is what the room hears; this is
 * what the player reads while deciding, under a timer, on their own.
 *
 * Three rules, and all three are load-bearing:
 *
 * - **Static per round.** Never a function of the state. A line that changed
 *   with what the server knows is a line that could carry what the server
 *   knows, and SCORING.md and SPEC.md are unambiguous that no participant
 *   surface may say whether an answer was right, which way the light is about
 *   to turn, or which pane is real, before the moment that says it.
 * - **Say the thing that ends your round.** Plan / Apply *is* the rule that a
 *   tap during the lock drains you; the bridge *is* the rule that one of the
 *   two names was made up. A player who does not know either has not been
 *   given a chance to play.
 * - **Say nothing about which.** The bridge's line names the shape of the
 *   choice and nothing about the answer to it.
 *
 * Every round kind has a key, and the three that have no participant surface
 * yet hold `undefined` on purpose: the record is exhaustive, so a new round
 * cannot be built without this file asking what its line is, and building one
 * is filling in the string here.
 */
/**
 * How to play, read on the round card before the round starts.
 *
 * There are now three registers for a round's words and they do different
 * jobs. {@link ARCADE_ROUND_CARD} is the Front-End Man — atmosphere, aimed at
 * the room. {@link PLAY_RULE} is one line on the phone *during* play, for a
 * player who has forgotten the rule mid-round. This is the briefing: what the
 * game is, what you do, and what ends it, for somebody who has never seen it.
 *
 * The room has not played any of these before. A game whose rules are only in
 * the host's spoken introduction is a game the people who joined late, or were
 * reading chat, or dropped and rejoined, do not get to play — and over video
 * that is most of a round. So the rules go on the screen, in front of everyone,
 * in the twenty seconds the card is up anyway.
 *
 * Three lines each, in a fixed order, and the order is the point: **what this
 * is**, **what you do**, **what ends it**. A player who reads only the third
 * line still knows the thing that would otherwise be learned by losing.
 *
 * Same two rules as PLAY_RULE, for the same reasons. Static per round, never a
 * function of the state — a line that changed with what the server knows is a
 * line that could carry what the server knows. And nothing about *which*: the
 * bridge's lines name the shape of the choice and say nothing that helps with
 * an actual pane.
 *
 * **Nobody is out.** Three of these lines used to end "and you are out", which
 * is the one promise the arcade makes and breaks in the same sentence: a player
 * who taps during the lock is *drained to the Lounge*, where they bet on
 * somebody still running and can still finish ahead of a cautious survivor.
 * README.md is explicit that "someone knocked out at minute six" is the failure
 * the whole format was designed around, and this is the surface where the room
 * learns which game it is in. So the word is drained, it names where you go,
 * and it matches {@link PLAY_RULE}'s line for Plan / Apply, which already said
 * it properly.
 */
export const HOW_TO_PLAY: Readonly<
  Record<ArcadeRoundKind, readonly [string, string, string]>
> = {
  recruitment: [
    "Two emoji stand for one HashiCorp product.",
    "Type the product's name before the timer runs out.",
    "Everyone plays every item. Nobody is knocked out.",
  ],
  plan_apply: [
    "A sign that switches between PLAN and LOCKED.",
    "Tap to add resources while it reads PLAN.",
    "One tap while it reads LOCKED and you are drained to the Lounge.",
  ],
  unseal: [
    "You choose a shape, and the shape decides how long your word is.",
    "The letters arrive scrambled. Tap them in the right order.",
    "One wrong letter cracks the tin. A second shatters it and drains you to the Lounge.",
  ],
  tug_of_raft: [
    "Two teams, one rope, and a steady beat.",
    "Tap on the beat to pull. Tapping off the beat does nothing.",
    "Nobody is knocked out. Three pulls, and the sides are reshuffled.",
  ],
  gganbu: [
    "You are paired with one other player. Ten tokens each.",
    "Six over-or-under questions — bet tokens on your answer.",
    "Run out of tokens and you are drained to the Lounge.",
  ],
  glass_bridge: [
    "Six steps. Two panes at each: one real HashiCorp feature, one invented.",
    "Tap the one you think is real.",
    "Tap the invented one and you fall.",
  ],
};

export const PLAY_RULE: Readonly<
  Record<"trivia" | ArcadeRoundKind, string | undefined>
> = {
  /**
   * The speed bonus is the part nobody is told. "Pick one. It is final." is
   * already on the screen and says the half that stops a second tap; this
   * says the half that explains why the timer is there at all. It promises
   * nothing about *this* answer — it is the scoring rule, stated in advance,
   * exactly as the facilitator guide states it to the room.
   */
  trivia: "Tap one answer. Correct answers score more the sooner they land.",
  /**
   * The emoji are `aria-hidden` decoration to a screen reader and a riddle to
   * everybody else: the missing word was always *product*.
   */
  recruitment: "Type the product these two emoji mean. You get one try.",
  /**
   * The whole game, in one sentence.
   *
   * It names the word on the button — `LOCKED` — and never the colour, because
   * the pink state is pink *and* says LOCKED *and* carries the ■ glyph, and
   * the one of those three a colour-blind player cannot use is the one this
   * line must not lean on.
   */
  plan_apply:
    "Tap to add resources. A tap while it reads LOCKED drains you to the Lounge.",
  /**
   * Both halves of the round, in one sentence, and the cheat is not in it.
   *
   * "Read the docs" is on the screen as a control with its price written on
   * it, which is where a cost belongs; putting it in this line as well would
   * make the rule about the cheat rather than about the game. What this line
   * has to carry is the thing that ends your round, and it takes two wrong taps
   * to do it — so both are named. A line that stopped at the crack would read
   * as the old one-strike rule and tell a player their round was over at the
   * moment it became worth playing carefully.
   */
  unseal:
    "Tap the letters in order. One wrong letter cracks the tin, and a second shatters it.",
  /**
   * The rule is the *beat*, not the tapping, and the line says so in that
   * order — a player who reads "tap to pull" and stops there will hammer the
   * button and score nothing, which is the one way to play this round badly
   * enough to stop enjoying it.
   *
   * It names the election because that is what three missed beats gets you
   * and nothing else on the phone says so before it happens. It does not say
   * "you are out", because nobody is: this is the round where nobody drains,
   * and a line that implied otherwise would be the only frightening sentence
   * in a game designed to be the opposite.
   */
  tug_of_raft:
    "Tap on the beat to pull. Off the beat does nothing, and three missed beats times you out.",
  gganbu: undefined,
  /**
   * The round is unplayable without this and the screen never said it: two
   * product feature names, one of them invented, and no statement anywhere on
   * the participant's own surface that one of them is a fake or what happens
   * if you pick it. Which pane is which is not hinted at, here or anywhere
   * else before the reveal.
   */
  glass_bridge:
    "One pane is a real HashiCorp feature. The other is invented, and it drains you.",
};

/* ------------------------------------------------------------------ */
/* The keyboard                                                        */
/* ------------------------------------------------------------------ */

/**
 * What the participant surface says about the keys, written once.
 *
 * The audience joins on laptops. Plan / Apply is 120 taps in 75 seconds,
 * which is natural under a thumb and genuinely unpleasant on a trackpad — it
 * is the single thing most likely to make somebody put the game down halfway,
 * and it quietly disadvantages whoever does not have a mouse. So every
 * control that is tapped under a clock is operable from the keyboard.
 *
 * The hint is on screen because nobody guesses "press space". It is *not*
 * phrased as an instruction — a click still works, and on a phone the keys do
 * not exist — so it reads as an offer and never as a requirement.
 */
export const KEY_HINT = {
  /** The one big button in Plan / Apply. */
  tap: "Space or Enter also taps",
  /** The four trivia tiles. */
  trivia: "Keys 1–4 also answer",
  /** Recruitment's text field. */
  recruit: "Enter submits",
  /**
   * The Glass Bridge's two panes.
   *
   * Wave 3 gets six seconds a step. A control that needs a trackpad, a hunt
   * for a target and a click inside six seconds is a control that costs
   * somebody the round for owning the wrong hardware, so the two panes answer
   * to the two keys that already mean "the left one" and "the right one".
   *
   * They commit, rather than moving focus, for the same reason the trivia
   * tiles answer to 1–4 and for the same reason one pane per step is final:
   * under six seconds a two-keystroke commitment is a worse game, and every
   * other way of stepping is one action too.
   */
  glass: "← and → step onto a pane",
  /**
   * Unseal's letter tiles.
   *
   * Typing the letter is the obvious keyboard for this round and it is better
   * than the pointer: the tiles are a scramble, so hunting for one with a
   * trackpad is a second puzzle laid over the first, and it is a puzzle about
   * cursor travel. The engine takes the **character** rather than a tile
   * index precisely so this works — a word with a repeated letter has two
   * tiles that are the same tap, and typing S must not have to mean "the
   * second S".
   */
  unseal: "Type a letter to tap it",
  /**
   * Tug of Raft's one control.
   *
   * This is the round the laptop correction matters most in. A rhythm game
   * is natural under a thumb and genuinely unpleasant on a trackpad — the
   * hand has to stay on the pad, the click travel is long enough to be felt
   * against a 600 ms beat, and a missed beat is not a missed point but three
   * of them away from being timed out. Space and Enter are what a `<button>`
   * already answers to, so the keyboard and the pointer stay one control.
   */
  tug: "Space or Enter also pulls",
} as const;

/**
 * Whether a keystroke should be treated as a press of the game's button.
 *
 * Two rules, and the second is the one that matters.
 *
 * **Space and Enter, and nothing else.** They are what a `<button>` already
 * answers to, so the keyboard path and the pointer path stay the same control
 * rather than two controls that have to be kept in step.
 *
 * **A held key is one tap, never a stream.** `KeyboardEvent.repeat` marks the
 * strokes the OS synthesises while a key is down — roughly 30 a second once
 * the delay elapses, which no hand on a trackpad can match and which would
 * turn a race of 120 taps into a race to lean on a key. Rejecting the repeats
 * makes a tap cost one physical press, exactly as it costs one click, so the
 * keyboard is an accommodation and not an advantage. It also means a player
 * who rests a finger on the space bar does not machine-gun themselves into a
 * drain the moment the light turns pink.
 */
export function isTapKey(ev: {
  readonly key: string;
  readonly repeat: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}): { readonly handled: boolean; readonly taps: boolean } {
  if (ev.altKey || ev.ctrlKey || ev.metaKey) return { handled: false, taps: false };
  // "Spacebar" is IE/old-Edge's name for it and costs one comparison.
  if (ev.key !== " " && ev.key !== "Spacebar" && ev.key !== "Enter") {
    return { handled: false, taps: false };
  }
  // Handled either way: the page must not scroll on space, and the browser
  // must not also activate the button underneath.
  return { handled: true, taps: !ev.repeat };
}

/** `1`–`4` → a 0-based tile index, or null. Never the numpad's own names. */
export function answerKeyIndex(key: string, count: number): number | null {
  if (key.length !== 1) return null;
  const n = Number(key);
  if (!Number.isInteger(n) || n < 1 || n > count) return null;
  return n - 1;
}

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

/* ------------------------------------------------------------------ */
/* The Glass Bridge                                                    */
/* ------------------------------------------------------------------ */

/**
 * `ArrowLeft`/`ArrowRight`, or `1`/`2`, to a pane index. Null for anything
 * else.
 *
 * The arrows because the panes are physically left and right, the digits
 * because the trivia tiles already answer to digits and a room that has
 * learned one keyboard should not have to learn a second. A held key is not a
 * second step — `repeat` is rejected — but that matters less here than in
 * Plan / Apply, because the engine refuses a second commitment anyway: one
 * pane per step, and you have put your weight on it.
 */
export function paneKeyIndex(ev: {
  readonly key: string;
  readonly repeat: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}): 0 | 1 | null {
  if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.repeat) return null;
  if (ev.key === "ArrowLeft" || ev.key === "1") return 0;
  if (ev.key === "ArrowRight" || ev.key === "2") return 1;
  return null;
}

/**
 * Which wave a player number crosses in, from the two cuts on the wire.
 *
 * The same arithmetic as `waveOf` in engine/arcade.ts, written here rather
 * than imported because it is the arithmetic the *room* does: SPEC.md has the
 * waves "by player number", and the two cuts are on the big screen precisely
 * so that thirty people can each work out their own wave without being told
 * by a field only their own phone has.
 */
export function waveOfNumber(
  playerNumber: number,
  cuts: readonly [number, number],
): GlassWave {
  if (playerNumber <= cuts[0]) return 1;
  if (playerNumber <= cuts[1]) return 2;
  return 3;
}

/** One player, placed on the bridge. */
export interface BridgeEntry extends GridEntry {
  readonly wave: GlassWave;
  /** Steps completed. Also the step they are facing. */
  readonly position: number;
  /** Their wave is crossing, they are still standing, and not yet across. */
  readonly onBridge: boolean;
  readonly across: boolean;
  /** Still on the Floor, and their wave has not walked on yet. */
  readonly waiting: boolean;
}

export function bridgeEntries(
  arcade: ArcadeView,
  roster: readonly RosterEntry[],
  glass: ArcadeGlassView,
): BridgeEntry[] {
  const of = glass.of;
  return gridEntries(arcade, roster).map((e) => {
    const wave = waveOfNumber(e.playerNumber, glass.waveCuts);
    const position = glass.position?.[e.pid] ?? 0;
    const standing = e.standing === "floor";
    const across = standing && position >= of;
    return {
      ...e,
      wave,
      position,
      across,
      onBridge: standing && !across && wave === glass.wave,
      waiting: standing && !across && wave > glass.wave,
    };
  });
}

/** One step of the bridge, with everything a surface draws on it. */
export interface BridgeStep {
  /** 0-based. The label the room hears is this plus one. */
  readonly index: number;
  readonly product: string;
  readonly labels: readonly [string, string];
  /**
   * Which pane broke here, or null for a step nobody has fallen at.
   *
   * With two panes this *is* the answer to the step, which is why the server
   * only ever sends a non-null entry for a step everybody who could use it
   * has already walked past. It is the whole of what wave 2 and wave 3 are
   * promised, and the reason going first is worse.
   */
  readonly broken: 0 | 1 | null;
  /** Everyone facing this step right now. Empty for a step nobody is on. */
  readonly standing: readonly BridgeEntry[];
  /** The step the open wave is deciding. */
  readonly open: boolean;
}

/**
 * The bridge, as a row of steps plus the far side.
 *
 * `labels` is empty for every step while the round card is up, because the
 * server does not send the board until the Floor opens — the row still draws,
 * so the bridge is there before anybody walks onto it.
 */
export function bridgeSteps(
  arcade: ArcadeView,
  roster: readonly RosterEntry[],
  glass: ArcadeGlassView,
): { steps: BridgeStep[]; across: BridgeEntry[] } {
  const entries = bridgeEntries(arcade, roster, glass);
  const steps: BridgeStep[] = [];
  for (let i = 0; i < glass.of; i += 1) {
    const pane = glass.board?.[i];
    steps.push({
      index: i,
      product: pane?.product ?? "",
      labels: pane?.labels ?? ["", ""],
      broken: glass.broken[i] ?? null,
      standing: entries.filter((e) => e.onBridge && e.position === i),
      open: glass.step === i,
    });
  }
  return { steps, across: entries.filter((e) => e.across) };
}

/** The three waves, in order, with their members. Wave 1 goes blind. */
export function waveRosters(
  arcade: ArcadeView,
  roster: readonly RosterEntry[],
  glass: ArcadeGlassView,
): { wave: GlassWave; seconds: number; members: BridgeEntry[] }[] {
  const entries = bridgeEntries(arcade, roster, glass);
  return ([1, 2, 3] as const).map((wave) => ({
    wave,
    seconds: glass.waveSeconds[wave - 1] ?? 0,
    members: entries.filter((e) => e.wave === wave),
  }));
}

/**
 * Who a drained player may back on this bridge.
 *
 * SPEC.md: "Drained players back someone in a **later** wave." The engine
 * refuses anything else, and a list of chips that are refused when pressed is
 * a list that should not have been drawn — so the filter is here as well,
 * where the chips are made.
 */
export function glassBackable(
  arcade: ArcadeView,
  roster: readonly RosterEntry[],
  glass: ArcadeGlassView,
  exclude?: string,
): BridgeEntry[] {
  return bridgeEntries(arcade, roster, glass).filter(
    (e) => e.standing === "floor" && e.pid !== exclude && e.wave > glass.wave,
  );
}

/**
 * Who a wave that is *waiting* may back: the wave on the bridge now.
 *
 * The mirror of {@link glassBackable}, and the same argument for drawing it
 * here. A waiting wave bets on the runners in front of them and on nobody
 * else, because betting on a later wave would be betting on people they are
 * about to walk beside — and a player already across is not a bet at all.
 */
export function glassCrossing(
  arcade: ArcadeView,
  roster: readonly RosterEntry[],
  glass: ArcadeGlassView,
  exclude?: string,
): BridgeEntry[] {
  return bridgeEntries(arcade, roster, glass).filter(
    (e) => e.onBridge && e.pid !== exclude,
  );
}

/**
 * How much of the step's time is left, 0–1, for the draining bar.
 *
 * Off the two absolute epochs the server sent, never off `waveSeconds`: a
 * step that opened 300 ms late still empties exactly when it closes, and a
 * surface that received the frame late still agrees with every other surface
 * about the instant.
 */
export function stepFraction(
  glass: { readonly stepStartedAt?: number; readonly stepEndsAt?: number },
  now: number,
): number | null {
  const { stepStartedAt, stepEndsAt } = glass;
  if (stepStartedAt === undefined || stepEndsAt === undefined) return null;
  if (stepEndsAt <= stepStartedAt) return null;
  const left = (stepEndsAt - now) / (stepEndsAt - stepStartedAt);
  return Math.min(1, Math.max(0, left));
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

/**
 * The highest checkpoint this many resources has passed, or null for none.
 *
 * The announcer's line — *30 resources applied. Progress banked.* — names the
 * checkpoint, not the running count, so it says the same thing on every phone
 * that reached it rather than whatever number happened to be on screen when
 * the frame landed. Checkpoints are not assumed sorted: they come off the
 * wire.
 */
export function latestCheckpoint(
  checkpoints: readonly number[],
  resources: number,
): number | null {
  let best: number | null = null;
  for (const c of checkpoints) {
    if (c <= resources && (best === null || c > best)) best = c;
  }
  return best;
}

/** What the Lounge card says under *Backing 017*, and how full its bar is. */
export interface BackedProgress {
  /** One mono line. Player numbers only — the nickname is on the chip above. */
  readonly line: string;
  /** 0–1 for the small bar, or null where the round has no bar to draw. */
  readonly fraction: number | null;
}

/**
 * How the runner this phone is backing is getting on.
 *
 * The Lounge is SPEC.md's answer to "nobody sits out", and in the longest
 * Floor round it was answering with a consolation token: a drained player
 * picked a name, watched the big screen turn green and pink for 75 seconds, and
 * found out at the reveal whether it had paid. This is the line that makes them
 * a spectator with a stake — their runner's own progress, on their own phone,
 * under the chip with the name on it.
 *
 * Two rounds have progress worth watching and they are the two that take the
 * longest. Plan / Apply's is the resource count, which the server sends as
 * `backedResources` for the one runner this phone has bet on. The Bridge's is
 * the step, which needs nothing new on the wire at all: `position` is already
 * on a participant's frame, because a step only becomes an answer once the
 * break above it is published and by then it is public anyway.
 *
 * Every line is checked against the runner's standing first, because a bet is
 * not cleared when its runner is drained: it has to stand in order to be
 * settled. A drained runner gets the past tense and loses the bar, which is the
 * same rule the big screen's ticker follows when it drops them — a count or a
 * pane that has stopped moving, drawn as though it had not, is a lie about
 * somebody who is already in the Lounge.
 *
 * Null for every other round, and for a phone that has not placed a bet. Unseal
 * is deliberately among them: how far into a word somebody has got is a prefix
 * of that word, and the server does not send it to the room for that reason.
 */
export function backedProgress(
  arcade: ArcadeView,
  mine: ArcadeMine,
): BackedProgress | null {
  const backing = mine.backing ?? null;
  if (backing === null) return null;

  // The runner's own cell, because a bet outlives the runner. Nothing clears
  // the seat when the person it names is drained — the bet has to stand in
  // order to be settled at the reveal — so every line below is drawn about
  // somebody who may already be out, and the standing is the only thing on the
  // wire that says so. Without this read the phone tells a backer their runner
  // is "standing on pane 2" for the rest of a round they fell out of, which is
  // the one thing this line exists to stop happening.
  //
  // Null for a runner with no cell at all: they were kicked or released, both
  // chips that draw this line find their runner in the grid too, and a line
  // under a chip that is not there is a line about nobody.
  const cell = arcade.grid.find((c) => c.pid === backing);
  if (cell === undefined) return null;
  const drained = cell.standing === "drained";

  const pa = arcade.planApply;
  const resources = mine.planApply?.backedResources;
  if (pa !== undefined && resources !== undefined) {
    // The count froze when they were caught, so it is said in the past tense
    // and the bar comes off: a fraction still sitting at three quarters is the
    // same lie the big screen's ticker refuses to tell when it drops a drained
    // runner. The Lounge's own chip list already hides a drained runner during
    // this round, so this is the function declining to depend on that.
    if (drained) return { line: `Drained at ${resources} resources`, fraction: null };
    const { fraction } = resourceBar(pa, resources);
    return {
      // Across is the news, so it is the word rather than "120 of 120" — which
      // reads as a bar that has stopped, on the one surface that wants to say
      // the bet came in.
      line:
        resources >= pa.target
          ? `Across · ${resources} resources`
          : `${resources} of ${pa.target} resources`,
      fraction,
    };
  }

  const glass = arcade.glass;
  // `position` is absent until the Floor opens — the round card is not the
  // bridge — and a step count drawn against a card nobody has walked on yet
  // would be a zero presented as progress.
  if (glass !== undefined && glass.position !== undefined && glass.of > 0) {
    const done = glass.position[backing] ?? 0;
    // `position` is steps *completed*, so a fall at the step they were facing
    // leaves it where it was and the pane they went through is that plus one.
    // Named rather than left blank because it is the one piece of news a backer
    // is waiting for, and it is public already: the strike is on the grid and
    // the drain log says the pane out loud over the light.
    if (drained) {
      return { line: `Drained at pane ${done + 1} of ${glass.of}`, fraction: null };
    }
    if (done >= glass.of) {
      return { line: `Across · ${glass.of} of ${glass.of} panes`, fraction: 1 };
    }
    // A later wave has not walked on yet, and `position` has no entry for them
    // until they do — which reads as nought, which would read as "standing on
    // pane 1". The Lounge only ever bets on a later wave, so this is the state
    // every one of those bets starts in and it lasts until their wave is
    // called. The wave number is on the big screen beside the two cuts, so it
    // is what the room is already using to work out whose turn is next.
    const wave = waveOfNumber(cell.playerNumber, glass.waveCuts);
    if (wave > glass.wave) {
      return { line: `Wave ${wave} · not on the bridge yet`, fraction: 0 };
    }
    return {
      line: `Standing on pane ${done + 1} of ${glass.of}`,
      fraction: Math.min(1, done / glass.of),
    };
  }
  return null;
}

/**
 * When the *current Recruitment item* closes, as an absolute epoch.
 *
 * SPEC.md gives Recruitment "six items, 20 seconds each" and the board ships
 * seven of them, and an item timer means the item: the round's `endsAt` is the
 * *last* item's deadline, so drawing it in this slot counted the whole round
 * down at somebody who had twenty seconds, once for every item.
 *
 * Null when no item is running — the round card and the reveal — because the
 * server omits the key there rather than nulling it, and a timer with nothing
 * behind it shows nothing rather than a zero.
 */
export function itemEndsAt(
  recruitment: ArcadeRecruitmentView | undefined,
): number | null {
  return recruitment?.itemEndsAt ?? null;
}

/* ------------------------------------------------------------------ */
/* Unseal                                                              */
/* ------------------------------------------------------------------ */

/**
 * The four tins: the glyph the room sees, and the word a screen reader says.
 *
 * DESIGN.md's motif list is where the glyphs come from — "○ △ □ … used as the
 * shape picker in Unseal (with ☆ ☂ added)" — and the name is here because a
 * screen reader announcing "○" reads out whatever its own table calls that
 * character, which is not "circle" on every platform and is sometimes nothing
 * at all. The glyph is `aria-hidden` everywhere it appears and the name is
 * what is actually announced.
 */
export const UNSEAL_FACE: Readonly<
  Record<UnsealShape, { readonly glyph: string; readonly name: string }>
> = {
  circle: { glyph: "○", name: "Circle" },
  triangle: { glyph: "△", name: "Triangle" },
  star: { glyph: "☆", name: "Star" },
  umbrella: { glyph: "☂", name: "Umbrella" },
};

/**
 * Counts one to twenty, spelled, for headers the room reads at a glance.
 *
 * The reveal headers on the shared screen are sentences rather than readouts
 * — "THREE PULLS. ONE ROPE." — and a digit in the middle of one reads as a
 * score. Past twenty a count falls back to digits at the call site, which
 * looks wrong but is never *wrong*, and no round here has twenty of anything.
 */
const COUNT_WORDS: readonly string[] = [
  "NO",
  "ONE",
  "TWO",
  "THREE",
  "FOUR",
  "FIVE",
  "SIX",
  "SEVEN",
  "EIGHT",
  "NINE",
  "TEN",
  "ELEVEN",
  "TWELVE",
  "THIRTEEN",
  "FOURTEEN",
  "FIFTEEN",
  "SIXTEEN",
  "SEVENTEEN",
  "EIGHTEEN",
  "NINETEEN",
  "TWENTY",
];

/**
 * The Unseal reveal header, counted from the tins that were actually in play.
 *
 * This header was a literal — "NINE TINS. NINE WORDS." — until a tenth tin
 * was added to the circle tier and the literal was not, which told the whole
 * room a number the board underneath it disagreed with. Counting the recap
 * instead means the content file is the only place a tin is ever added, and
 * a host who runs a shorter Floor gets a header that matches what was dealt.
 */
export function unsealRevealHead(tins: number): string {
  const word = COUNT_WORDS[tins] ?? String(tins);
  return tins === 1 ? "ONE TIN. ONE WORD." : `${word} TINS. ${word} WORDS.`;
}

/** One scrambled letter, as a tile. */
export interface UnsealTile {
  /** Position in the cue, which is what makes two identical letters two tiles. */
  readonly index: number;
  readonly letter: string;
  /** Already spent on the solved prefix, so it is no longer a control. */
  readonly used: boolean;
}

/**
 * The cue as tiles, with the ones already tapped marked spent.
 *
 * The consumption is a **multiset**, matched left to right, and that is the
 * whole of why this function exists. GOSSIP has two Ss; after the first S is
 * tapped exactly one of the two S tiles must go dim, and which one does not
 * matter as long as it is exactly one. Marking "every tile whose letter is in
 * the solved prefix" would grey out both of them and leave the player looking
 * at a word they cannot finish.
 *
 * `solved` is the prefix from the server — their own letters, because they
 * tapped them — and never the rest of the word.
 */
export function unsealTiles(cue: string, solved: string): UnsealTile[] {
  const letters = [...cue.toUpperCase()].filter((c) => /\p{L}/u.test(c));
  const spent = new Array<boolean>(letters.length).fill(false);
  for (const c of [...solved.toUpperCase()]) {
    const at = letters.findIndex((l, i) => !spent[i] && l === c);
    if (at !== -1) spent[at] = true;
  }
  return letters.map((letter, index) => ({
    index,
    letter,
    used: spent[index] === true,
  }));
}

/**
 * A keystroke to the letter it would tap, or null.
 *
 * One printable letter, no modifiers, and never an OS key repeat: a held key
 * would send the same letter thirty times a second, and in this round the
 * second and third of those are always wrong — a cracked tin and then a
 * shattered one, off one resting finger.
 */
export function unsealLetterKey(ev: {
  readonly key: string;
  readonly repeat: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}): string | null {
  if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.repeat) return null;
  if ([...ev.key].length !== 1) return null;
  const up = ev.key.toUpperCase();
  return /\p{L}/u.test(up) ? up : null;
}

/** Which of the tin's three beats this phone has already said, this round. */
export interface UnsealSaid {
  readonly docs: boolean;
  readonly cracked: boolean;
  readonly opened: boolean;
}

/** Nothing said yet: a new round is a new tin. */
export const UNSEAL_NOTHING_SAID: UnsealSaid = {
  docs: false,
  cracked: false,
  opened: false,
};

/** What the tin's House slot holds after a frame, and what has now been said. */
export interface UnsealSlot {
  /** The line to put in the slot and announce, or null to leave it alone. */
  readonly line: string | null;
  readonly said: UnsealSaid;
}

/**
 * The tin's three beats, and the one House slot they share.
 *
 * Reading the docs, cracking the tin and getting the word out all land in the
 * same slot on the phone, and the ordering between them is the decision:
 *
 * **Each is said once.** The letters are still live underneath the docs and
 * crack lines, and `paintUnseal` runs on every frame the server sends — a
 * repaint that re-set the slot would re-announce the warning to a screen
 * reader several times a second. So a beat that is already said returns
 * nothing, however many frames it stays true for.
 *
 * **The later beat wins the slot.** A player who read the docs, cracked the
 * tin and then finished anyway has had the first two said to them already, and
 * the last thing the slot holds should be the thing that just happened. When
 * more than one beat lands on the same frame the line is the last of them, in
 * this order, and the earlier ones are still marked as said so they cannot
 * come back later out of order.
 *
 * **Opening is a beat at all.** The round narrated every way to lose a tin and
 * said nothing about getting a word out, which is a House that only speaks
 * when somebody loses.
 */
export function unsealSlot(
  now: { readonly docs: boolean; readonly cracked: boolean; readonly opened: boolean },
  said: UnsealSaid,
): UnsealSlot {
  let line: string | null = null;
  const fired = { ...said };
  if (now.docs && !fired.docs) {
    fired.docs = true;
    line = HOUSE.unsealDocs;
  }
  if (now.cracked && !fired.cracked) {
    fired.cracked = true;
    line = HOUSE.unsealCracked;
  }
  if (now.opened && !fired.opened) {
    fired.opened = true;
    line = HOUSE.unsealOpened;
  }
  return { line, said: fired };
}

/* ------------------------------------------------------------------ */
/* Tug of Raft                                                         */
/* ------------------------------------------------------------------ */

/**
 * Where the heartbeat is right now, from the server's grid.
 *
 * **There is one clock in this round and it is the server's.** `pullStartedAt`
 * is beat 0 and beat *n* is `pullStartedAt + n * beatMs`, so every surface
 * draws the same beat at the same instant and a tap is judged against the
 * beat the player was actually shown. A surface that started its own 600 ms
 * `setInterval` on the frame it happened to receive would be a second clock:
 * it would begin a little late, drift by whatever the timer owes, and spend
 * the back half of a 25-second pull inviting taps a quarter of a beat away
 * from the one the server is judging. Nothing here measures a duration from
 * anything but the two absolute epochs on the wire.
 *
 * `phase` runs 0 → 1 *from* the nearest beat to the next one and is what the
 * ring is drawn from; `onBeat` is the window a tap would be credited in,
 * width from the server rather than from a constant in this file.
 */
export interface TugBeat {
  /** The beat `now` is nearest to, as an index from the pull's start. */
  readonly beat: number;
  /** 0 at the last beat, 1 at the next. The pulse. */
  readonly phase: number;
  /** A tap at this instant is inside the window around a beat. */
  readonly onBeat: boolean;
  /** Milliseconds until the next beat lands. */
  readonly toNext: number;
}

export function tugBeatAt(
  tug: Pick<ArcadeTugView, "pullStartedAt" | "beatMs" | "toleranceMs">,
  now: number,
): TugBeat | null {
  const { pullStartedAt, beatMs, toleranceMs } = tug;
  if (pullStartedAt === undefined || !(beatMs > 0)) return null;
  const since = now - pullStartedAt;
  // Floor, not round: `phase` is "how far past the last beat", and the last
  // beat is the one that has actually happened.
  const last = Math.floor(since / beatMs);
  const into = since - last * beatMs;
  // `beat` is the one a tap would be judged against, which is the *nearest*
  // — the same rounding the engine does, so "on the beat" means the same
  // thing on the ring as it does in the reducer.
  const beat = Math.round(since / beatMs);
  const offset = Math.abs(since - beat * beatMs);
  return {
    beat,
    phase: beatMs <= 0 ? 0 : Math.min(1, Math.max(0, into / beatMs)),
    onBeat: offset <= toleranceMs,
    toNext: Math.max(0, (last + 1) * beatMs - since),
  };
}

/**
 * Whether this node is timed out right now, derived the way the engine
 * derives it.
 *
 * Elections are **not stored** anywhere — not in the play state and not on
 * the wire — because the engine has no clock and could only ever write such a
 * field when some other event happened to arrive, which is exactly when it is
 * not needed. What the state holds is the last beat the player actually hit,
 * and everything else falls out of arithmetic against the grid: three missed
 * beats in a row time a node out from the instant of the third, for
 * `electionMs`, and then it comes back and counts its misses from the first
 * beat after the election ended.
 *
 * So this function is `resolveBeat` from engine/arcade.ts, asked about *now*
 * rather than about a tap, and it is the same loop on the same numbers — the
 * window widths arrive on the wire rather than being written here twice. The
 * loop terminates because each election advances `last` by at least three.
 */
export interface TugElection {
  readonly inElection: boolean;
  /** When the election in force ends. Zero when there is none. */
  readonly endsAt: number;
  /** Beats missed in a row, as the server would count them at this instant. */
  readonly missed: number;
}

export function tugElectionAt(
  tug: Pick<
    ArcadeTugView,
    "pullStartedAt" | "beatMs" | "missesToElection" | "electionMs"
  >,
  lastBeat: number,
  now: number,
): TugElection {
  const { pullStartedAt, beatMs, missesToElection, electionMs } = tug;
  if (pullStartedAt === undefined || !(beatMs > 0)) {
    return { inElection: false, endsAt: 0, missed: 0 };
  }
  const beat = Math.round((now - pullStartedAt) / beatMs);
  let last = lastBeat;
  for (;;) {
    const missed = Math.max(0, beat - last - 1);
    if (missed < missesToElection) {
      return { inElection: false, endsAt: 0, missed };
    }
    const from = pullStartedAt + (last + missesToElection) * beatMs;
    const to = from + electionMs;
    if (now < to) {
      return { inElection: true, endsAt: to, missed: missesToElection };
    }
    last = Math.ceil((to - pullStartedAt) / beatMs) - 1;
  }
}

/**
 * Where the rope is, 0 → 1, with 0.5 the centre line.
 *
 * The *share* of the on-beat taps rather than their difference, because a
 * difference needs a scale and there is no honest one: 25 seconds at 100 bpm
 * is about 41 beats a player, so a lead of ten taps means one thing in a
 * room of six and nothing at all in a room of forty. A share needs no scale,
 * is the thing the round actually measures — SPEC.md's "net on-beat rate" —
 * and cannot pin the rope against the stop in the first five seconds because
 * one side happened to start faster.
 *
 * A pull nobody has touched sits dead centre, which is the truth about it.
 */
export function tugRope(totals: readonly [number, number]): number {
  const [a, b] = totals;
  const all = a + b;
  if (all <= 0) return 0.5;
  return Math.min(1, Math.max(0, b / all));
}

/**
 * Which side just won a pull, as a difference against the last frame.
 *
 * Read off `wins` and not off the rope: the rope is a running difference
 * inside a pull, and the thing worth saying is the pull that closed. The frame
 * that carries the result is the one that starts the next pull, or for the last
 * pull the one that ends the round, so this is the same reading either way and
 * needs no notion of "between pulls".
 *
 * A pull that ended level increments neither side and is announced as nothing.
 * The House does not narrate a draw: there is no side to name, and "nobody has
 * the rope" is a joke about the round rather than the round's own voice. Nor is
 * a frame that carries no change at all — the surface repaints continuously,
 * and a win line re-announced every frame is a screen reader talking over the
 * next pull.
 *
 * Counts that go *down* say nothing either. That is a new round's `wins` coming
 * back to zero, and the phone must not read it as a win for whoever is now
 * behind.
 */
export function tugPullWinner(
  before: readonly [number, number],
  now: readonly [number, number],
): 0 | 1 | null {
  if (now[0] > before[0]) return 0;
  if (now[1] > before[1]) return 1;
  return null;
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
