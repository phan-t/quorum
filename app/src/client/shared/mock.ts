/**
 * The mock server: a whole Quorum session, in the page, behind the same
 * `Transport` interface the real WebSocket uses.
 *
 * It exists because the three clients and the server are being built at the
 * same time, and a client that can only be exercised against a backend is a
 * client nobody looks at until the backend works. It is worth keeping after
 * that: it is the only way to open the host console and the big screen on a
 * laptop with no session running, and it reproduces on demand the three things
 * that are awkward to produce on purpose — a dropped socket, a `seq` gap, and
 * a clock that disagrees with the phone's.
 *
 * Two things to know before verifying anything through it:
 *
 * **A backgrounded tab throttles it.** The whole mock runs on `setTimeout`,
 * and Chrome clamps timers in a tab that is not in the foreground — so a round
 * appears to freeze, and it looks exactly like a hung surface. More than one
 * verification pass has lost time to that. Keep the tab in front, or drive it
 * from a foreground iframe.
 *
 * **Do not raise `speed` for the arcade.** The scripted director's schedule
 * scales but the arcade's own item, light and step timers do not, so above
 * `speed=1` a round starts on top of the one still running. It is demo pacing,
 * not a product bug, but it makes the arcade unverifiable.
 *
 * Turn it on with `?mock=1`. Flags:
 *
 *   ?mock=1          scripted session: bots arrive, the host advances, it loops
 *   ?mock=manual     same session, no director — you drive it from the console
 *                    (an empty grid, and the scoring is yours to type)
 *   &speed=2         run the script at 2×
 *   &drop=1          kill the socket once, 14s in, to show the banner
 *   &gap=1           skip a `seq` once, to force a resync
 *   &latency=250     milliseconds added to every frame, both ways
 *
 * One deliberate detail: one of the bots is named with a fragment of HTML. If
 * a surface ever renders a nickname as markup, that bot makes it obvious on
 * the first run rather than in front of thirty people.
 *
 * The scripted session runs the whole of Phase 2 scoring, the whole of Phase
 * 3 trivia and the two built rounds of the Phase 4 arcade, so every surface
 * can be watched without a backend: a judged activity out of 20 with its
 * facilitator on bench, then four real questions with bots tapping at
 * plausible speeds — including a round card, a multi-answer question, a
 * two-answer question and a sudden death — then Recruitment and Plan / Apply
 * with the light turning, bots being drained into the Lounge and backing the
 * runners still on the Floor, two Spot Awards with reasons, and finally the
 * seal and the reveal.
 *
 * The arithmetic here is SCORING.md's and SPEC.md's, implemented a second
 * time on purpose — the mock is a stand-in for the server and must not borrow
 * the engine to agree with it. The projection is implemented a second time
 * for the same reason, which matters more here than anywhere: if the mock
 * copied views.ts, the one thing it could never catch is views.ts putting the
 * correct answer on a phone.
 */

import type {
  ActivitySummary,
  ArcadeCell,
  ArcadeGlassView,
  ArcadeMine,
  ArcadeMineGlass,
  ArcadeRecruitmentView,
  ArcadeView,
  ClientMessage,
  HostCommand,
  RenderState,
  RosterEntry,
  ScoreRow,
  ServerMessage,
  Role,
  SendoffView,
  StandingRow,
  TriviaMine,
  TriviaPodiumRow,
  TriviaRound,
  TriviaView,
} from "../../protocol.ts";
import type {
  ArcadePhase,
  ArcadeRoundKind,
  ArcadeStanding,
  EmojiItem,
  GlassStep,
  GlassWave,
  QuestionPhase,
  Seal,
  SendoffPhase,
  ScoreStatus,
  Segment,
  SessionPhase,
  WaveSeconds,
} from "../../engine/types.ts";
import { RECRUITMENT_ITEMS } from "../../arcade/recruitment.ts";
import { GLASS_BRIDGE_STEPS } from "../../arcade/glass-bridge.ts";
import type { Transport, TransportFactory, TransportHandlers } from "./transport.ts";

export interface MockConfig {
  director: boolean;
  speed: number;
  drop: boolean;
  gap: boolean;
  latency: number;
}

/** `null` when the page should talk to a real server. */
export function readMockConfig(search = location.search): MockConfig | null {
  const q = new URLSearchParams(search);
  const mode = q.get("mock");
  if (mode === null || mode === "0" || mode === "off") return null;
  const num = (k: string, dflt: number): number => {
    const v = Number(q.get(k));
    return Number.isFinite(v) && v > 0 ? v : dflt;
  };
  return {
    director: mode !== "manual",
    speed: num("speed", 1),
    drop: q.get("drop") === "1",
    gap: q.get("gap") === "1",
    latency: Number(q.get("latency")) || 40,
  };
}

/* ------------------------------------------------------------------ */
/* The session the mock is pretending to run                           */
/* ------------------------------------------------------------------ */

interface MockParticipant {
  pid: string;
  nickname: string;
  nicknameKey: string;
  playerNumber: number;
  conn: "on" | "away";
  /**
   * activityId -> what the host typed. Benching clears it, exactly as the
   * reducer does: a raw score that is no longer meaningful must not reappear
   * if the status flips back.
   */
  raw: Record<string, number>;
  status: Record<string, ScoreStatus>;
  bot: boolean;
}

interface MockSpot {
  seq: number;
  pid: string;
  activityId: string;
  reason: string;
}

/** One participant's line of the board, before it is projected to a role. */
interface MockRow {
  p: MockParticipant;
  /** Normalised points, or the bench credit, per activity. Null for unset. */
  points: Record<string, number | null>;
  bench: string[];
  spot: number;
  total: number;
  rank: number;
}

/** The three the server ships with — `DEFAULT_ACTIVITIES` in runtime.ts. */
const ACTIVITIES: readonly Omit<ActivitySummary, "spotsLeft">[] = [
  { id: "ttx", title: "Agentic Security TTX", kind: "manual", spotCap: 2 },
  { id: "trivia", title: "Trivia", kind: "trivia", spotCap: 2 },
  { id: "arcade", title: "Hashi Arcade", kind: "arcade", spotCap: 2 },
];

const SPOT_AWARD_POINTS = 10;

/* ---- trivia ---- */

interface MockQuestion {
  text: string;
  answers: string[];
  timeLimitSec: number;
  /** 0-based here, as in the engine. The CSV's 1-based column is the importer's problem. */
  correct: number[];
  note: string | null;
  round: string | null;
  basePoints: number;
}

/**
 * Four questions out of SPEC.md's own CSV example, chosen to exercise the
 * shapes that break layouts: a long question, a two-answer question, a
 * multi-answer question, a note, and a pair sharing a `Round` so the round
 * card has something to appear for.
 */
const QUESTIONS: readonly MockQuestion[] = [
  {
    text: "In what year was HashiCorp founded?",
    answers: ["2008", "2010", "2012", "2015"],
    timeLimitSec: 15,
    correct: [1],
    note: null,
    round: "History",
    basePoints: 1000,
  },
  {
    text: "Which product does secrets management, encryption as a service and dynamic credentials?",
    answers: ["Consul", "Boundary", "Vault", "Nomad"],
    timeLimitSec: 15,
    correct: [2],
    note: "Dynamic credentials are the bit people forget.",
    round: "Name that product",
    basePoints: 1000,
  },
  {
    text: "Which product's brand colour is purple?",
    answers: ["Vault", "Consul", "Terraform", "Nomad"],
    timeLimitSec: 10,
    correct: [2],
    note: null,
    round: "Brand",
    basePoints: 500,
  },
  {
    // Kahoot semantics: any listed answer counts. And two answers only, which
    // is the case a 2 x 2 grid gets wrong if nobody checks it.
    text: "Which of these is a HashiCorp product?",
    answers: ["Waypoint", "Sentinel"],
    timeLimitSec: 10,
    correct: [0, 1],
    note: "Both. Waypoint is the deploy one; Sentinel is policy as code.",
    round: "Brand",
    basePoints: 1000,
  },
];

interface MockAnswer {
  choice: number;
  correct: boolean;
  ms: number;
  points: number;
  streakBonus: number;
}



/* ---- arcade ---- */

/**
 * The arcade, mocked. As with trivia, the rules here are written from SPEC.md
 * and DESIGN.md rather than borrowed from the engine or from views.ts — if
 * the mock and the server ever disagree about what a phone is sent, that
 * disagreement is the bug worth having found, and a mock that imported the
 * projection could never find it.
 *
 * The *content* is imported, though, because content is not a rule: a second
 * copy of the same six emoji items is how one of them silently rots.
 */
interface MockLounge {
  backing: string | null;
  at: number;
}

interface MockRecruitPlay {
  kind: "recruitment";
  items: readonly EmojiItem[];
  at: number;
  secondsPerItem: number;
  itemEndsAt: number;
  solvedOrder: string[];
  answered: Record<string, boolean>;
}

interface MockPlanPlay {
  kind: "plan_apply";
  light: "plan" | "apply";
  lightChangedAt: number;
  nextChangeAt: number;
  resources: Record<string, number>;
  target: number;
  seconds: number;
  finishOrder: string[];
}

/**
 * The Glass Bridge, mocked.
 *
 * Written from SPEC.md and DESIGN.md, like everything else here, and the
 * split between `board` and `key` is written again rather than borrowed:
 * that split is the whole of the round's security, and a mock that imported
 * it could never catch the server failing to make it. The *content* is
 * imported, because content is not a rule and a second copy of twelve pane
 * labels is how one of them silently rots.
 */
interface MockGlassPlay {
  kind: "glass_bridge";
  /** Showable: the product and the two labels. */
  board: { product: string; labels: [string, string] }[];
  /** **The answer.** Never projected to anybody but the host and the reveal. */
  key: { real: 0 | 1; notes: [string, string] }[];
  waveSeconds: WaveSeconds;
  waveCuts: [number, number];
  wave: GlassWave;
  step: number;
  waveStartedAt: number;
  stepStartedAt: number;
  stepEndsAt: number;
  /** Written only when a step CLOSES. See `#closeGlassStep`. */
  broken: (0 | 1 | null)[];
  /** The open step only: who committed, and whether it held. Never which pane. */
  stepped: Record<string, boolean>;
  position: Record<string, number>;
  elapsedMs: Record<string, number>;
  crossOrder: string[];
}

type MockPlay = MockRecruitPlay | MockPlanPlay | MockGlassPlay;

/* ---- the send-off ---------------------------------------------------- */

/*
 * A staged send-off, so the segment can actually be driven without a backend.
 *
 * The practice toggle shipped unverifiable because this file had no case for
 * its command: the frame fell off the end of the switch, was acked as
 * applied, and changed nothing. Everything the send-off needs is here for
 * that reason — the walk, the projection, and content with the shape of the
 * real thing.
 *
 * **The photos are `data:` URIs.** The real ones are keys resolved against
 * `/api/sessions/<sid>/assets/<key>`, which is a server this page does not
 * have, and a montage that can only ever 404 is a montage nobody can look at.
 * The Desktop passes a `data:` key through untouched for exactly this. One
 * key in the opening list is a plain filename that will 404 on purpose, so
 * the run that shows the montage working also shows it stepping over a photo
 * that is not there.
 */
function mockPhoto(bg: string, fg: string, caption: string): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='1200' height='800'>` +
    `<rect width='1200' height='800' fill='${bg}'/>` +
    `<circle cx='940' cy='190' r='90' fill='${fg}' opacity='0.5'/>` +
    `<text x='60' y='720' font-family='sans-serif' font-size='64' fill='${fg}'>${caption}</text>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * The montage's track: half a second of silence, on a loop.
 *
 * Generated rather than named, for the reason the photos are `data:` URIs —
 * there is no asset endpoint on this page — and *silent* rather than a tone
 * because the scripted mock loops all afternoon on somebody's second monitor.
 * What it is for is the part of the music that can go wrong without making a
 * sound: the Desktop arms audio on the first gesture it receives, and a track
 * that never loads cannot tell you whether the arming worked. This one plays,
 * so `paused`, `volume` and the fade-out before the first message are all
 * things a verification pass can actually look at.
 */
function mockSilentTrack(): string {
  const rate = 8_000;
  const samples = rate / 2;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true); // PCM header length
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true); // byte rate
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples, true);
  // 8-bit PCM is unsigned: silence is 0x80, not zero.
  bytes.fill(0x80, 44);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

interface MockSendoff {
  name: string;
  subtitle: string | null;
  opening: { photos: string[]; seconds: number; music: string | null };
  kudos: { from: string; message: string }[];
  closing: { photos: string[]; line: string | null };
}

/**
 * Lengths matter here and are not padding: the real set runs 34 to 145 words,
 * and a mock whose messages are all one line cannot show whether the type
 * fits them. The third one is the joke that does not survive being read out
 * at a farewell — it is here so the Skip control has something to be for.
 */
const MOCK_SENDOFF: MockSendoff = {
  name: "Abhijeet Lokhande",
  subtitle: "Last day 30 September 2026",
  opening: {
    photos: [
      mockPhoto("#1d3b53", "#f6f5f3", "Sydney offsite, 2024"),
      "no-such-photo.jpg",
      mockPhoto("#3b1d4f", "#f6f5f3", "The whiteboard"),
      mockPhoto("#153d31", "#f6f5f3", "Team dinner, Singapore"),
    ],
    seconds: 40,
    music: mockSilentTrack(),
  },
  kudos: [
    {
      from: "Priya Raghunathan",
      message:
        "You were the first person to reply to me when I joined, and you have been the first person to reply every time since. I have watched you take a customer call at ten at night because somebody needed it, and then write the follow-up the same evening so nobody had to chase it. The team runs the way it does because you set it up that way, and the rest of us just kept doing it.",
    },
    {
      from: "Koutarou Yamada",
      message:
        "Thank you for the whiteboard session that finally made the Vault deployment make sense to me. I still have the photo of it.",
    },
    {
      from: "Anonymous",
      message:
        "Whoever gets your desk is inheriting the good monitor and a drawer of expired protein bars. Rest in peace to the guy who kept moving my mouse settings.",
    },
    {
      from: "Sam Whitfield",
      message:
        "I have worked with you on four accounts now and I have never once seen you take the easy version of an answer. The Canberra escalation is the one I will keep telling people about: you got on a plane, sat in the room for two days, and came back with a plan the customer wrote half of themselves. That is the part people miss about what you do — you do not just solve it, you leave the customer able to solve the next one. You also never let any of us present anything half-finished, which was annoying at the time and is the reason our decks are the ones that get reused. Whatever you are doing next, they have no idea what they have just picked up. Thank you for all of it, and for the coffee order you somehow remembered for three years.",
    },
  ],
  closing: {
    photos: [mockPhoto("#4f2a1d", "#f6f5f3", "Last day")],
    line: "Thank you, Abhijeet. Don't be a stranger.",
  },
};

/** SPEC.md: each step crossed banks 5, and wave 1 banks +3 per step. */
const GLASS_STEP_BANK = 5;
const GLASS_BLIND_BONUS = 3;
/** SPEC.md: reaching the far side, +15. */
const GLASS_FAR_SIDE = 15;

/**
 * The wave cuts: contiguous thirds in player-number order, earlier waves
 * taking the remainder.
 *
 * Contiguous rather than round-robin because SPEC.md has the waves "by player
 * number", and because the room can work out its own wave from two numbers on
 * the big screen — which a modulo cannot give them.
 */
function mockWaveCuts(numbers: readonly number[]): [number, number] {
  const sorted = [...numbers].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return [0, 0];
  let cut1 = 0;
  let cut2 = 0;
  for (let i = 0; i < n; i += 1) {
    const wave = Math.floor((i * 3) / n);
    const number = sorted[i] ?? 0;
    if (wave === 0) cut1 = number;
    if (wave <= 1) cut2 = number;
  }
  return [cut1, Math.max(cut1, cut2)];
}

function mockWaveOf(playerNumber: number, cuts: readonly [number, number]): GlassWave {
  if (playerNumber <= cuts[0]) return 1;
  if (playerNumber <= cuts[1]) return 2;
  return 3;
}

/**
 * The fastest full crossing: the lowest total decision time among those who
 * reached the far side, ties going to whoever got there first.
 *
 * Wall-clock cannot be used for this, and the reason is the round's own
 * shape: the waves run at 12, 9 and 6 seconds a step and a wave cannot
 * advance before its step closes, so elapsed time would hand the award to
 * wave 3 every time and first-across would hand it to wave 1 every time. Six
 * reaction times added up is the only measure comparable between waves.
 */
function mockFastestCrossing(play: MockGlassPlay): string | null {
  let best: string | null = null;
  let bestMs = Infinity;
  for (const pid of play.crossOrder) {
    const ms = play.elapsedMs[pid] ?? Infinity;
    if (ms < bestMs) {
      best = pid;
      bestMs = ms;
    }
  }
  return best;
}

/** Split the content into the half that may be shown and the half that may not. */
function mockSplitBoard(steps: readonly GlassStep[]): {
  board: { product: string; labels: [string, string] }[];
  key: { real: 0 | 1; notes: [string, string] }[];
} {
  return {
    board: steps.map((s) => ({
      product: s.product,
      labels: [s.panes[0].label, s.panes[1].label],
    })),
    key: steps.map((s) => ({
      real: s.real,
      notes: [s.panes[0].note, s.panes[1].note],
    })),
  };
}

/** SPEC.md: 2–6 seconds, drawn at the boundary because the engine is pure. */
const LIGHT_MIN_MS = 2_000;
const LIGHT_MAX_MS = 6_000;
/** SPEC.md: the head begins to turn 400 ms before the lock. */
const TELEGRAPH_MS = 400;
/** SPEC.md: "a 250 ms grace after the lock for network latency". */
const LOCK_GRACE_MS = 250;

/** Quarter marks of the target: 30 / 60 / 90 at the tuned 120. */
function mockCheckpoints(target: number): number[] {
  const out: number[] = [];
  for (const i of [1, 2, 3]) {
    const at = Math.round((target * i) / 4);
    if (at > 0 && at < target && !out.includes(at)) out.push(at);
  }
  return out;
}

function mockFold(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}]/gu, "");
}

const BOT_NAMES = [
  "Kenji",
  "Priya",
  "Sam",
  "Ade",
  "Grace",
  "Tobias",
  "Yuki",
  "Mei",
  "Rahul",
  "Nadia",
  "Oscar",
  "Lena",
  "Ines",
  // Not a joke: this is the regression test for "nicknames render as text".
  '<img src=x onerror="alert(1)">',
  "  spaced   out  ",
];

/** The mock's clock runs ~1.2s ahead of the browser's, on purpose. */
const SERVER_SKEW_MS = 1_237;

class MockSession {
  sid = "mock-session";
  title = "SA APJ Quorum";
  joinCode = sampleJoinCode();
  phase: SessionPhase = "draft";
  segment: Segment = "lobby";
  seal: Seal = "live";
  practice = false;
  holding: { title: string; line: string } | null = null;
  joinsLocked = false;
  seq = 0;
  participants: MockParticipant[] = [];
  spots: MockSpot[] = [];
  #nextNumber = 1;
  #nextSpotSeq = 1;

  /* ---- trivia ---- */
  questions: readonly MockQuestion[] = QUESTIONS;
  at = 0;
  questionPhase: QuestionPhase = "idle";
  opensAt: number | null = null;
  closesAt: number | null = null;
  suddenDeath = false;
  suddenDeathWinner: string | null = null;
  answers: Record<string, MockAnswer> = {};
  triviaTotals: Record<string, number> = {};
  triviaStreaks: Record<string, number> = {};


  /* ---- the send-off ---- */
  /** Loaded the way the engine loads it: at start-up, before anybody arrives. */
  sendoff: MockSendoff | null = MOCK_SENDOFF;
  sendoffPhase: SendoffPhase = MOCK_SENDOFF.opening.photos.length > 0 ? "opening" : "kudos";
  sendoffAt = 0;

  /* ---- arcade ---- */
  arcadeOn = false;
  arcadeNumbers: Record<string, number> = {};
  arcadeRound: ArcadeRoundKind | null = null;
  arcadeRoundIndex = 0;
  arcadePhase: ArcadePhase = "idle";
  arcadeStanding: Record<string, ArcadeStanding> = {};
  arcadeLounge: Record<string, MockLounge> = {};
  arcadeBanked: Record<string, number> = {};
  arcadeTotals: Record<string, number> = {};
  arcadeStartedAt: number | null = null;
  arcadeEndsAt: number | null = null;
  arcadePlay: MockPlay | null = null;

  /** Roster order, gapless, assigned once and never changed under anyone. */
  assignArcadeNumbers(): void {
    let next = 1;
    for (const n of Object.values(this.arcadeNumbers)) next = Math.max(next, n + 1);
    for (const p of this.participants) {
      if (this.arcadeNumbers[p.pid] === undefined) {
        this.arcadeNumbers[p.pid] = next++;
      }
      this.arcadeStanding[p.pid] ??= "floor";
    }
  }

  arcadeNumber(pid: string): number {
    return this.arcadeNumbers[pid] ?? 0;
  }

  /**
   * Back to a clean lobby, keeping the room and the content.
   *
   * The mock's copy of the `restartSession` reducer case. It has to clear
   * exactly the same fields, because the whole point of driving the console
   * against `?mock=1` is that what the host sees here is what they will see on
   * Friday — a mock that left the arcade register standing would show a clean
   * console over a dirty session and hide the bug this feature exists to
   * avoid.
   *
   * Kept: participants, nicknames, join-order numbers, the join code, the
   * question set. Cleared: every score, every Spot Award, all trivia progress,
   * the arcade entirely, the holding card, the seal and the join lock.
   */
  restart(): void {
    this.phase = "lobby";
    this.segment = "lobby";
    this.seal = "live";
    this.holding = null;
    this.joinsLocked = false;
    this.spots = [];
    for (const p of this.participants) {
      p.raw = {};
      p.status = {};
    }

    // The send-off's content stays loaded and the walk goes back to the
    // start — the reducer's `restartSession`, which says the same thing about
    // re-uploading not being the point of a restart.
    this.sendoffPhase =
      this.sendoff !== null && this.sendoff.opening.photos.length > 0 ? "opening" : "kudos";
    this.sendoffAt = 0;

    this.at = 0;
    this.questionPhase = "idle";
    this.opensAt = null;
    this.closesAt = null;
    this.suddenDeath = false;
    this.suddenDeathWinner = null;
    this.answers = {};
    this.triviaTotals = {};
    this.triviaStreaks = {};

    // The whole register, numbers included. `arcadeOn` is what the projection
    // reads as "the room is in the arcade", so leaving it true would put an
    // arcade view on a phone that is looking at a lobby.
    this.arcadeOn = false;
    this.arcadeNumbers = {};
    this.arcadeRound = null;
    this.arcadeRoundIndex = 0;
    this.arcadePhase = "idle";
    this.arcadeStanding = {};
    this.arcadeLounge = {};
    this.arcadeBanked = {};
    this.arcadeTotals = {};
    this.arcadeStartedAt = null;
    this.arcadeEndsAt = null;
    this.arcadePlay = null;
  }

  /** Everyone back on the Floor: a drain lasts exactly one round. */
  resetFloor(): void {
    this.arcadeStanding = {};
    this.arcadeLounge = {};
    this.arcadeBanked = {};
    for (const p of this.participants) this.arcadeStanding[p.pid] = "floor";
  }

  drain(pid: string, at: number): void {
    this.arcadeStanding[pid] = "drained";
    this.arcadeLounge[pid] = { backing: null, at };
  }

  bank(pid: string, points: number): void {
    if (points <= 0) return;
    this.arcadeBanked[pid] = (this.arcadeBanked[pid] ?? 0) + points;
  }

  /**
   * The grid, which is the same on every surface: numbers and standing, never
   * points and never nicknames. The roster is already on every socket, so
   * this is a rendering rule kept honest by the shape of the cell.
   */
  arcadeGrid(): ArcadeCell[] {
    const live = this.arcadePhase === "running" || this.arcadePhase === "reveal";
    const backers: Record<string, number> = {};
    for (const seat of Object.values(this.arcadeLounge)) {
      if (seat.backing === null) continue;
      backers[seat.backing] = (backers[seat.backing] ?? 0) + 1;
    }
    return this.participants
      .map((p) => {
        const standing = this.arcadeStanding[p.pid] ?? "floor";
        return {
          pid: p.pid,
          playerNumber: this.arcadeNumber(p.pid),
          standing,
          backers: backers[p.pid] ?? 0,
          struck: live && standing === "drained",
        };
      })
      .sort((a, b) => a.playerNumber - b.playerNumber);
  }

  /**
   * The arcade, projected for one role.
   *
   * The rule this exists to enforce: `nextChangeAt` and `headTurnsAt` are the
   * light's schedule, and a phone holding them can tap flat out and stop
   * 401 ms before every lock. They go to the big screen — which *is* the
   * warning — and to the console, and to nobody else. Omitted, never nulled,
   * so the key is not in the bytes.
   */
  arcadeView(role: Role): ArcadeView | undefined {
    if (!this.arcadeOn) return undefined;
    const privileged = role === "host" || role === "screen";
    const host = role === "host";
    const revealed = this.arcadePhase === "reveal";
    const open = this.arcadePhase === "running" || revealed;
    const grid = this.arcadeGrid();
    const play = this.arcadePlay;

    const base: ArcadeView = {
      activityId: "arcade",
      round: this.arcadeRound,
      roundIndex: this.arcadeRoundIndex,
      phase: this.arcadePhase,
      startedAt: this.arcadeStartedAt,
      endsAt: this.arcadeEndsAt,
      grid,
      onFloor: grid.filter((c) => c.standing === "floor").length,
      inLounge: grid.filter((c) => c.standing === "drained").length,
    };

    if (play?.kind === "recruitment") {
      const item = play.items[play.at];
      // `itemEndsAt` is the *item's* clock, and every role gets it: SPEC.md
      // gives Recruitment twenty seconds an item while the round's `endsAt`
      // is two and a half minutes away, so a surface drawing the round clock
      // in the item slot tells the room the wrong number six times running.
      //
      // Omitted, never nulled, while the round card is up and at the reveal,
      // because no item is running then — which is also what the server does.
      // Sending it unconditionally drew `00:00` on the card, since the play
      // carries a zero until the Floor opens.
      const recruitment: ArcadeRecruitmentView = {
        ...(this.arcadePhase === "running" ? { itemEndsAt: play.itemEndsAt } : {}),
        at: play.at,
        of: play.items.length,
        ...(item && (host || open) ? { cue: item.cue } : {}),
        ...(item && (host || revealed)
          ? { answer: item.answer, note: item.note }
          : {}),
        ...(host || revealed
          ? {
              recap: play.items.map((i) => ({
                cue: i.cue,
                answer: i.answer,
                note: i.note,
              })),
              firstThree: play.solvedOrder
                .slice(0, 3)
                .map((pid) => this.arcadeNumber(pid)),
            }
          : {}),
        ...(privileged
          ? {
              answered: Object.keys(play.answered).length,
              eligible: this.participants.length,
              solved: Object.values(play.answered).filter(Boolean).length,
            }
          : {}),
      };
      return { ...base, recruitment };
    }

    if (play?.kind === "glass_bridge") {
      // THE projection of this mock, and the one worth writing twice.
      //
      // The rules, from SPEC.md and the round's own design, none of them read
      // off views.ts:
      //
      // - `key` — which pane is real, and both reveal notes — reaches nobody
      //   but the host until the reveal. Not the big screen either: the big
      //   screen is in the room, and the room contains two waves who have not
      //   crossed.
      // - `stepped` is not projected at all. It says whether somebody's pane
      //   held, and with two panes that is the answer to the step.
      // - `broken` goes to everybody, because the play state only ever writes
      //   an entry when a step *closes* — by then everyone who could use it
      //   has walked past it. That is what waves 2 and 3 are promised.
      // - `board` waits for the Floor to open, as Recruitment's cue does.
      // - the results — who crossed, and the fastest — are the big screen's
      //   and the console's, as `finishOrder` is in Plan / Apply.
      const running = this.arcadePhase === "running";
      const shown = host || running || revealed;
      const glass: ArcadeGlassView = {
        wave: play.wave,
        waveCuts: play.waveCuts,
        waveSeconds: play.waveSeconds,
        of: play.board.length,
        broken: play.broken,
        ...(shown
          ? {
              board: play.board.map((b) => ({
                product: b.product,
                labels: b.labels,
              })),
              position: { ...play.position },
            }
          : {}),
        // Which step the bridge is on follows `board`; the host wants it
        // while the card is up, because it is what they are about to read
        // out. The three clocks do not follow it: the play state carries
        // zeroes until the Floor opens, and a surface handed a zero draws
        // `00:00` at a room that is looking at a round card.
        ...(host || running ? { step: play.step } : {}),
        ...(running
          ? {
              waveStartedAt: play.waveStartedAt,
              stepStartedAt: play.stepStartedAt,
              stepEndsAt: play.stepEndsAt,
            }
          : {}),
        ...(privileged
          ? {
              crossed: play.crossOrder.map((pid) => this.arcadeNumber(pid)),
              ...(mockFastestCrossing(play) === null
                ? {}
                : {
                    fastest: this.arcadeNumber(
                      mockFastestCrossing(play) as string,
                    ),
                  }),
            }
          : {}),
        ...(host ? { elapsedMs: { ...play.elapsedMs } } : {}),
        ...(host || revealed
          ? {
              recap: play.board.map((b, i) => ({
                product: b.product,
                labels: b.labels,
                real: play.key[i]?.real ?? 0,
                notes: play.key[i]?.notes ?? ["", ""],
              })),
            }
          : {}),
      };
      return { ...base, glass };
    }

    if (play?.kind === "plan_apply") {
      return {
        ...base,
        planApply: {
          light: play.light,
          lightChangedAt: play.lightChangedAt,
          target: play.target,
          checkpoints: mockCheckpoints(play.target),
          ...(privileged
            ? {
                nextChangeAt: play.nextChangeAt,
                ...(play.light === "plan"
                  ? { headTurnsAt: play.nextChangeAt - TELEGRAPH_MS }
                  : {}),
                crossed: play.finishOrder.length,
                finishOrder: play.finishOrder.map((pid) => this.arcadeNumber(pid)),
              }
            : {}),
        },
      };
    }
    return base;
  }

  /** One phone's own line. Their number, where they are, and nobody else's. */
  arcadeMine(pid: string): ArcadeMine | undefined {
    if (!this.arcadeOn) return undefined;
    const seat = this.arcadeLounge[pid];
    const play = this.arcadePlay;
    const place =
      play?.kind === "plan_apply" ? play.finishOrder.indexOf(pid) : -1;
    return {
      playerNumber: this.arcadeNumber(pid),
      standing: this.arcadeStanding[pid] ?? "floor",
      banked: this.arcadeBanked[pid] ?? 0,
      total: this.arcadeTotals[pid] ?? 0,
      ...(seat?.backing ? { backing: seat.backing } : {}),
      ...(seat ? { drainedAt: seat.at } : {}),
      ...(play?.kind === "recruitment"
        ? {
            recruitment:
              play.answered[pid] === undefined
                ? { state: "unanswered" as const }
                : { state: "locked" as const, correct: play.answered[pid] },
          }
        : {}),
      ...(play?.kind === "plan_apply"
        ? {
            planApply: {
              resources: play.resources[pid] ?? 0,
              ...(place === -1 ? {} : { place: place + 1 }),
            },
          }
        : {}),
      ...(play?.kind === "glass_bridge" ? { glass: this.glassMine(play, pid) } : {}),
    };
  }

  /**
   * One phone's own line on the bridge: their wave, whether it is their turn,
   * how far they have got, and whether the pane they chose held.
   *
   * Not which pane they chose. This mock does not store it, for the reason the
   * server does not: with two panes, a pane that *held* identifies the real
   * pane exactly as well as one that broke.
   */
  glassMine(play: MockGlassPlay, pid: string): ArcadeMineGlass {
    const wave = mockWaveOf(this.arcadeNumber(pid), play.waveCuts);
    const position = play.position[pid] ?? 0;
    const committed = pid in play.stepped;
    return {
      wave,
      onTheBridge:
        wave === play.wave &&
        this.arcadeStanding[pid] !== "drained" &&
        position < play.board.length,
      step: position,
      committed,
      ...(committed ? { held: play.stepped[pid] === true } : {}),
      across: position >= play.board.length,
    };
  }



  reset(): void {
    this.phase = "draft";
    this.segment = "lobby";
    this.seal = "live";
    this.sendoffPhase =
      this.sendoff !== null && this.sendoff.opening.photos.length > 0 ? "opening" : "kudos";
    this.sendoffAt = 0;
    this.holding = null;
    this.joinsLocked = false;
    this.spots = [];
    for (const p of this.participants) {
      p.raw = {};
      p.status = {};
    }
    this.participants = this.participants.filter((p) => !p.bot);
    this.at = 0;
    this.questionPhase = "idle";
    this.opensAt = null;
    this.closesAt = null;
    this.suddenDeath = false;
    this.suddenDeathWinner = null;
    this.answers = {};
    this.triviaTotals = {};
    this.triviaStreaks = {};
    this.arcadeOn = false;
    this.arcadeNumbers = {};
    this.arcadeRound = null;
    this.arcadeRoundIndex = 0;
    this.arcadePhase = "idle";
    this.arcadeStanding = {};
    this.arcadeLounge = {};
    this.arcadeBanked = {};
    this.arcadeTotals = {};
    this.arcadeStartedAt = null;
    this.arcadeEndsAt = null;
    this.arcadePlay = null;
  }

  /**
   * TODO(tiebreak): this mock has no sudden-death pool.
   *
   * The engine now runs sudden death off tiebreakers held outside the scored
   * set, and `server/views.ts` reads them through `currentQuestion`. This
   * harness still indexes the scored set directly, so a sudden death driven
   * against the mock would show the next un-asked question. The mock is
   * written independently from `views.ts` on purpose — that is how it catches
   * the real projection leaking — so it needs its own pool rather than an
   * import, and that belongs with the surfaces work for the new rounds.
   */
  question(): MockQuestion | undefined {
    return this.questions[this.at];
  }

  /**
   * SPEC.md's arithmetic, written out rather than imported: base points
   * scaled so an answer at the buzzer is worth half an instant one, never
   * less, plus `100 x min(n - 1, 5)` for the n-th consecutive correct answer.
   *
   * Settled at close, not at answer time, because a participant's own state
   * must carry no correctness signal while the question is open.
   */
  settleQuestion(): void {
    const q = this.question();
    if (!q) return;
    for (const p of this.participants) {
      const a = this.answers[p.pid];
      if (!a) {
        this.triviaStreaks[p.pid] = 0;
        continue;
      }
      if (!a.correct || this.suddenDeath) {
        if (!a.correct) this.triviaStreaks[p.pid] = 0;
        continue;
      }
      const t = Math.min(a.ms, q.timeLimitSec * 1000);
      const points = Math.round(q.basePoints * (1 - t / (q.timeLimitSec * 1000) / 2));
      const streak = (this.triviaStreaks[p.pid] ?? 0) + 1;
      const streakBonus = 100 * Math.min(streak - 1, 5);
      this.triviaStreaks[p.pid] = streak;
      a.points = points;
      a.streakBonus = streakBonus;
      this.triviaTotals[p.pid] = (this.triviaTotals[p.pid] ?? 0) + points + streakBonus;
    }
    // Sudden death moves no points, so it must not move the scoreboard either.
    if (this.suddenDeath) return;
    for (const p of this.participants) {
      if (p.status["trivia"] === "bench") continue;
      p.raw["trivia"] = this.triviaTotals[p.pid] ?? 0;
      p.status["trivia"] = "played";
    }
  }

  /** The run of consecutive questions sharing a `Round`, if there is one. */
  round(index: number): TriviaRound | null {
    const here = this.questions[index];
    if (!here || here.round === null) return null;
    let first = index;
    while (first > 0 && this.questions[first - 1]?.round === here.round) first -= 1;
    let last = index;
    while (
      last + 1 < this.questions.length &&
      this.questions[last + 1]?.round === here.round
    ) {
      last += 1;
    }
    const size = last - first + 1;
    if (size < 2) return null;
    return { name: here.round, position: index - first + 1, size, startsHere: index === first };
  }

  triviaPodium(): TriviaPodiumRow[] {
    const rows = this.participants
      .map((p) => ({ p, points: this.triviaTotals[p.pid] ?? 0 }))
      .sort((a, b) => b.points - a.points || a.p.nickname.localeCompare(b.p.nickname));
    if (!rows.some((r) => r.points > 0)) return [];
    const out: TriviaPodiumRow[] = [];
    let rank = 0;
    let seen = 0;
    let prev: number | null = null;
    for (const r of rows) {
      seen += 1;
      if (prev === null || r.points !== prev) {
        rank = seen;
        prev = r.points;
      }
      if (out.length === 5) break;
      out.push({ rank, nickname: r.p.nickname, points: r.points });
    }
    return out;
  }

  /**
   * The trivia block, projected for one role.
   *
   * Written from SPEC.md rather than copied from views.ts, and the optional
   * fields are *omitted* rather than nulled, so a phone's frame does not
   * contain the word `correct` at all until the reveal. If this and the real
   * server ever disagree about that, the disagreement is the bug worth having
   * found.
   */
  triviaView(role: Role): TriviaView | undefined {
    const q = this.question();
    if (!q) return undefined;
    const host = role === "host";
    const revealed = this.questionPhase === "revealed";
    const visible = host || this.questionPhase !== "idle";
    const winner =
      this.suddenDeathWinner === null
        ? null
        : (this.find_pid(this.suddenDeathWinner)?.nickname ?? null);

    const view: TriviaView = {
      activityId: "trivia",
      index: this.at,
      of: this.questions.length,
      phase: this.questionPhase,
      text: visible ? q.text : "",
      answers: visible ? q.answers : [],
      opensAt: this.opensAt,
      closesAt: this.closesAt,
      timeLimitSec: q.timeLimitSec,
      basePoints: q.basePoints,
      suddenDeath: this.suddenDeath,
      suddenDeathWinner: winner,
      round: this.round(this.at),
    };

    const distribution = new Array<number>(q.answers.length).fill(0);
    for (const a of Object.values(this.answers)) {
      const at = distribution[a.choice];
      if (at !== undefined) distribution[a.choice] = at + 1;
    }

    return {
      ...view,
      ...(host || revealed ? { correct: q.correct } : {}),
      ...((host || revealed) && q.note !== null ? { note: q.note } : {}),
      ...(host || (role === "screen" && revealed) ? { distribution } : {}),
      ...(revealed ? { podium: this.triviaPodium() } : {}),
      ...(host || role === "screen"
        ? { answered: Object.keys(this.answers).length, eligible: this.participants.length }
        : {}),
    };
  }

  /** Three states, and the middle one is "locked in" and nothing else. */
  triviaMine(pid: string): TriviaMine {
    const mine = this.answers[pid];
    if (this.questionPhase !== "revealed") {
      return mine === undefined
        ? { state: "unanswered" }
        : { state: "locked", choice: mine.choice };
    }
    return {
      state: "revealed",
      choice: mine?.choice ?? null,
      correct: mine?.correct ?? false,
      points: mine?.points ?? 0,
      streakBonus: mine?.streakBonus ?? 0,
      streak: this.triviaStreaks[pid] ?? 0,
      total: this.triviaTotals[pid] ?? 0,
    };
  }

  key(nickname: string): string {
    return nickname.trim().replace(/\s+/g, " ").toLowerCase();
  }

  find(nickname: string): MockParticipant | undefined {
    const k = this.key(nickname);
    return this.participants.find((p) => p.nicknameKey === k);
  }

  add(nickname: string, bot: boolean): MockParticipant {
    const p: MockParticipant = {
      pid: `p${this.#nextNumber}`,
      nickname: nickname.trim().replace(/\s+/g, " "),
      nicknameKey: this.key(nickname),
      playerNumber: this.#nextNumber++,
      conn: "on",
      raw: {},
      status: {},
      bot,
    };
    this.participants.push(p);
    return p;
  }

  find_pid(pid: string): MockParticipant | undefined {
    return this.participants.find((p) => p.pid === pid);
  }

  activity(id: string): (typeof ACTIVITIES)[number] | undefined {
    return ACTIVITIES.find((a) => a.id === id);
  }

  grantSpot(pid: string, activityId: string, reason: string): MockSpot {
    const spot: MockSpot = {
      seq: this.#nextSpotSeq++,
      pid,
      activityId,
      reason: reason.trim(),
    };
    this.spots.push(spot);
    return spot;
  }

  spotsLeft(activityId: string): number {
    const cap = this.activity(activityId)?.spotCap ?? 0;
    return Math.max(0, cap - this.spots.filter((s) => s.activityId === activityId).length);
  }

  /* ---- scoring: SCORING.md, and nothing else ---- */

  /**
   * Normalise one activity: the top raw among `played` becomes 100, everyone
   * else `round(100 × raw ÷ top)`. Bench is excluded from the top — a
   * facilitator's absence must not set the ceiling for the room.
   */
  #normalise(activityId: string): Map<string, number> {
    let top = 0;
    for (const p of this.participants) {
      if (p.status[activityId] !== "played") continue;
      top = Math.max(top, p.raw[activityId] ?? 0);
    }
    const out = new Map<string, number>();
    for (const p of this.participants) {
      if (p.status[activityId] !== "played") continue;
      // A top of 0 means nobody scored: everyone gets 0, never NaN.
      out.set(p.pid, top > 0 ? Math.round((100 * (p.raw[activityId] ?? 0)) / top) : 0);
    }
    return out;
  }

  /** The whole board, ranked. Ties share a rank and the next rank skips. */
  board(): MockRow[] {
    const normalised = new Map<string, Map<string, number>>();
    for (const a of ACTIVITIES) normalised.set(a.id, this.#normalise(a.id));

    const rows = this.participants.map((p) => {
      const played: number[] = [];
      for (const a of ACTIVITIES) {
        const pts = normalised.get(a.id)?.get(p.pid);
        if (pts !== undefined) played.push(pts);
      }
      // Bench Credit: the mean of their own normalised points where they
      // played in full. Null — not zero — before they have played anything.
      const credit =
        played.length === 0
          ? null
          : Math.round(played.reduce((x, y) => x + y, 0) / played.length);

      const points: Record<string, number | null> = {};
      const bench: string[] = [];
      for (const a of ACTIVITIES) {
        const pts = normalised.get(a.id)?.get(p.pid);
        if (pts !== undefined) {
          points[a.id] = pts;
        } else if (p.status[a.id] === "bench") {
          points[a.id] = credit;
          bench.push(a.id);
        } else {
          points[a.id] = null;
        }
      }
      // An award for an activity they are now benched for does not count:
      // benching after a grant would otherwise be a back door to keeping it.
      const spot =
        this.spots.filter(
          (s) => s.pid === p.pid && p.status[s.activityId] !== "bench",
        ).length * SPOT_AWARD_POINTS;
      const total =
        ACTIVITIES.reduce((n, a) => n + (points[a.id] ?? 0), 0) + spot;
      return { p, points, bench, spot, total };
    });

    rows.sort(
      (a, b) => b.total - a.total || a.p.nickname.localeCompare(b.p.nickname),
    );

    const out: MockRow[] = [];
    let rank = 0;
    let seen = 0;
    let prev: number | null = null;
    for (const r of rows) {
      seen += 1;
      if (prev === null || r.total !== prev) {
        rank = seen;
        prev = r.total;
      }
      out.push({ ...r, rank });
    }
    return out;
  }

  roster(): RosterEntry[] {
    return this.participants.map((p) => ({
      pid: p.pid,
      nickname: p.nickname,
      playerNumber: p.playerNumber,
      conn: p.conn,
    }));
  }

  #row(r: MockRow): StandingRow {
    return {
      rank: r.rank,
      nickname: r.p.nickname,
      total: r.total,
      perActivity: { ...r.points },
      bench: [...r.bench],
      spot: r.spot,
    };
  }

  /** Top five, expanding a tie at fifth. Console and export only. */
  #topFive(board: readonly MockRow[]): MockRow[] {
    if (board.length <= 5) return [...board];
    const fifth = board[4];
    if (!fifth) return [...board];
    return board.filter((r) => r.total >= fifth.total);
  }

  /**
   * What may go on the wire to a phone or the big screen: a hard five, and
   * nothing at all before anyone has scored — an unscored board is an
   * alphabetical slice of the room, not a leaderboard.
   */
  #publicRows(board: readonly MockRow[]): MockRow[] {
    if (!board.some((r) => r.total > 0)) return [];
    return this.#topFive(board).slice(0, 5);
  }

  #scoreRows(board: readonly MockRow[]): ScoreRow[] {
    return board.map((r) => {
      const raw: Record<string, number | null> = {};
      const status: Record<string, ScoreStatus> = {};
      for (const a of ACTIVITIES) {
        const st = r.p.status[a.id] ?? "unset";
        status[a.id] = st;
        raw[a.id] = st === "played" ? (r.p.raw[a.id] ?? 0) : null;
      }
      return {
        pid: r.p.pid,
        nickname: r.p.nickname,
        playerNumber: r.p.playerNumber,
        raw,
        status,
        points: { ...r.points },
        spot: r.spot,
        total: r.total,
        rank: r.rank,
      };
    });
  }

  /**
   * One step through the send-off, forwards or back.
   *
   * The engine's `stepSendoff`, implemented a second time on purpose — the
   * mock is a stand-in for the server and must not borrow the reducer to
   * agree with it. False when the step falls off an end, which is the engine
   * acking a command it understood and did nothing about.
   *
   * Stepping back out of `done` lands on the last real thing rather than on
   * `closing` unconditionally, so correcting an overshoot cannot put an empty
   * frame in front of the room.
   */
  stepSendoff(dir: 1 | -1): boolean {
    const so = this.sendoff;
    if (so === null) return false;
    const kudos = so.kudos.length;
    const hasOpening = so.opening.photos.length > 0;
    const hasClosing =
      so.closing.photos.length > 0 || (so.closing.line ?? "") !== "";
    const at = (phase: SendoffPhase, index: number): boolean => {
      this.sendoffPhase = phase;
      this.sendoffAt = index;
      return true;
    };

    if (dir === 1) {
      if (this.sendoffPhase === "opening") {
        return kudos > 0 ? at("kudos", 0) : hasClosing ? at("closing", 0) : at("done", 0);
      }
      if (this.sendoffPhase === "kudos") {
        if (this.sendoffAt + 1 < kudos) return at("kudos", this.sendoffAt + 1);
        return hasClosing ? at("closing", 0) : at("done", 0);
      }
      if (this.sendoffPhase === "closing") return at("done", 0);
      return false;
    }

    if (this.sendoffPhase === "done") {
      if (hasClosing) return at("closing", 0);
      if (kudos > 0) return at("kudos", kudos - 1);
      return hasOpening ? at("opening", 0) : false;
    }
    if (this.sendoffPhase === "closing") {
      if (kudos > 0) return at("kudos", kudos - 1);
      return hasOpening ? at("opening", 0) : false;
    }
    if (this.sendoffPhase === "kudos") {
      if (this.sendoffAt > 0) return at("kudos", this.sendoffAt - 1);
      return hasOpening ? at("opening", 0) : false;
    }
    return false;
  }

  /**
   * The send-off, projected for one surface.
   *
   * `next` for the host and for nobody else. Implemented here rather than
   * imported from views.ts for the reason the rest of this file is: if the
   * mock copied the projection, the one thing it could never catch is the
   * projection putting the *next* message on the Desktop.
   */
  sendoffView(role: Role): SendoffView | undefined {
    const so = this.sendoff;
    // On the wire whenever one is loaded, not only inside the segment — which
    // is what views.ts does. The surfaces decide what to draw from `segment`.
    if (so === null) return undefined;
    const phase = this.sendoffPhase;
    const kudo = phase === "kudos" ? (so.kudos[this.sendoffAt] ?? null) : null;
    const photos =
      phase === "opening"
        ? so.opening.photos
        : phase === "closing"
          ? so.closing.photos
          : [];
    const view: SendoffView = {
      name: so.name,
      subtitle: so.subtitle,
      phase,
      index: phase === "kudos" ? this.sendoffAt + 1 : 0,
      total: so.kudos.length,
      kudo: kudo === null ? null : { from: kudo.from, message: kudo.message },
      photos,
      seconds: so.opening.seconds,
      // Only the montage's, and only while the montage is up: a music key on
      // a message frame is a track that would start under somebody reading.
      music: phase === "opening" ? so.opening.music : null,
      line: phase === "closing" || phase === "done" ? so.closing.line : null,
    };
    if (role !== "host") return view;
    const after =
      phase === "kudos" ? (so.kudos[this.sendoffAt + 1] ?? null) : (so.kudos[0] ?? null);
    return {
      ...view,
      next: after === null ? null : { from: after.from, message: after.message },
    };
  }

  activities(): ActivitySummary[] {
    return ACTIVITIES.map((a) => ({ ...a, spotsLeft: this.spotsLeft(a.id) }));
  }

  /**
   * The server sends the view for the role. A participant is never handed the
   * sixth-place row, because the only way to keep it off the phone is to never
   * put it on the wire.
   */
  render(role: Role, pid: string | null): RenderState {
    const sealed = this.seal === "sealed";
    const board = this.board();
    const base = {
      sid: this.sid,
      title: this.title,
      phase: this.phase,
      segment: this.segment,
      seal: this.seal,
      practice: this.practice,
      holding: this.holding,
      roster: this.roster(),
      joinsLocked: this.joinsLocked,
      activities: this.activities(),
    };

    const trivia = this.triviaView(role);
    const arcade = this.arcadeView(role);
    const sendoff = this.sendoffView(role);
    const withTrivia = {
      ...base,
      ...(trivia ? { trivia } : {}),
      ...(arcade ? { arcade } : {}),
      ...(sendoff ? { sendoff } : {}),
    };

    if (role === "host") {
      return {
        ...withTrivia,
        // The console shows everything. Sealing is about what the *room* sees,
        // and a host cannot run the session blind.
        standings: this.#topFive(board).map((r) => this.#row(r)),
        joinCode: this.joinCode,
        hostExtras: {
          joinCode: this.joinCode,
          participantCount: this.participants.length,
          awayCount: this.participants.filter((p) => p.conn === "away").length,
          scores: this.#scoreRows(board),
          spots: this.spots.map((s) => ({
            seq: s.seq,
            pid: s.pid,
            activityId: s.activityId,
            reason: s.reason,
          })),
          trivia: {
            answeredBy: Object.keys(this.answers),
            loaded: this.questions.length,
          },
          ...(this.arcadeOn
            ? {
                arcade: {
                  answeredBy:
                    this.arcadePlay?.kind === "recruitment"
                      ? Object.keys(this.arcadePlay.answered)
                      : [],
                  drained: Object.entries(this.arcadeStanding)
                    .filter(([, st]) => st === "drained")
                    .map(([pid]) => pid),
                  backing: Object.fromEntries(
                    Object.entries(this.arcadeLounge)
                      .filter(([, seat]) => seat.backing !== null)
                      .map(([pid, seat]) => [pid, seat.backing as string]),
                  ),
                  banked: { ...this.arcadeBanked },
                  totals: { ...this.arcadeTotals },
                  resources:
                    this.arcadePlay?.kind === "plan_apply"
                      ? { ...this.arcadePlay.resources }
                      : {},
                },
              }
            : {}),
        },
      };
    }

    const standings = sealed ? [] : this.#publicRows(board).map((r) => this.#row(r));
    if (role === "screen") {
      return { ...withTrivia, standings, joinCode: this.joinCode };
    }

    const mine = pid === null ? undefined : this.triviaMine(pid);
    const arcadeMine = pid === null ? undefined : this.arcadeMine(pid);
    const forPhone = {
      ...withTrivia,
      ...(mine ? { triviaMine: mine } : {}),
      ...(arcadeMine ? { arcadeMine } : {}),
    };
    const me = pid === null ? null : board.find((r) => r.p.pid === pid);
    // Sealed omits `own` entirely. The phone has nothing to fall back on, by
    // design: a total it kept through the seal is a sealed total on screen.
    if (me === null || me === undefined || sealed) {
      return { ...forPhone, standings };
    }
    return {
      ...forPhone,
      standings,
      own: { total: me.total, byActivity: { ...me.points } },
    };
  }
}

/* ------------------------------------------------------------------ */
/* The hub                                                             */
/* ------------------------------------------------------------------ */

interface MockConn {
  role: Role | null;
  pid: string | null;
  handlers: TransportHandlers;
  open: boolean;
  /**
   * Frames sent to *this* connection, as the real server counts them.
   *
   * It used to be one counter for the whole session, which was fine while
   * every broadcast went to everybody. A trivia answer does not: it is
   * addressed to the phone that sent it, the console and the big screen. With
   * a shared counter the other twenty-six phones would see the next delta
   * skip, decide they had missed a frame, and all resync at once — a bug in
   * the mock that looks exactly like a bug in the product.
   */
  seq: number;
}

class MockHub {
  readonly session = new MockSession();
  readonly #conns = new Set<MockConn>();
  readonly #cfg: MockConfig;
  #directorStarted = false;
  #directorStopped = false;
  #dropped = false;
  #gapUsed = false;
  #gapNext = false;
  #timers: ReturnType<typeof setTimeout>[] = [];

  constructor(cfg: MockConfig) {
    this.#cfg = cfg;
  }

  connect(handlers: TransportHandlers): Transport {
    const conn: MockConn = { role: null, pid: null, handlers, open: true, seq: 0 };
    this.#conns.add(conn);
    this.#later(() => {
      if (conn.open) handlers.onOpen();
    }, 10);

    return {
      send: (msg) => {
        if (!conn.open) return;
        this.#later(() => this.#receive(conn, msg), this.#cfg.latency);
      },
      close: () => {
        conn.open = false;
        this.#conns.delete(conn);
      },
    };
  }

  /* ---- client → mock server ---- */

  #receive(conn: MockConn, msg: ClientMessage): void {
    if (!conn.open) return;
    switch (msg.t) {
      case "hello":
        this.#hello(conn, msg);
        return;
      case "resync":
        if (conn.role) this.#sendState(conn);
        return;
      case "ping":
        this.#send(conn, {
          t: "pong",
          t0: msg.t0,
          t1: Date.now() + SERVER_SKEW_MS,
        });
        return;
      case "trivia.answer":
        this.#answer(conn, msg.cid, msg.index, msg.choice);
        return;
      case "arcade.answer":
        this.#arcadeAnswer(conn, msg.cid, msg.item, msg.answer);
        return;
      case "arcade.tap":
        this.#arcadeTap(conn, msg.cid, msg.round);
        return;
      case "arcade.step":
        this.#arcadeStep(conn, msg.cid, msg.round, msg.step, msg.choice);
        return;
      case "arcade.back":
        this.#arcadeBack(conn, msg.cid, msg.pid);
        return;
      case "host.cmd":
        if (msg.cmd === null) {
          // The frame still gets an answer on its cid: a console that gets
          // silence cannot tell a rejected click from a dropped one.
          this.#send(conn, {
            t: "refusedCmd",
            cid: msg.cid,
            code: "malformed",
            message: "Command not understood.",
          });
          return;
        }
        this.#hostCmd(conn, msg.cid, msg.cmd);
        return;
    }
  }

  #hello(conn: MockConn, msg: Extract<ClientMessage, { t: "hello" }>): void {
    if (msg.role === "host" || msg.role === "screen") {
      conn.role = msg.role;
      this.#send(conn, {
        t: "welcome",
        role: msg.role,
        sid: this.session.sid,
        serverTime: Date.now() + SERVER_SKEW_MS,
        protocol: 1,
      });
      this.#sendState(conn);
      this.#startDirector();
      return;
    }

    const code = msg.joinCode.trim();
    const nickname = msg.nickname.trim().replace(/\s+/g, " ");

    // A rejoin token beats every other check: this is the phone that slept.
    if (msg.rejoinToken) {
      const existing = this.session.participants.find(
        (p) => `tok-${p.pid}` === msg.rejoinToken,
      );
      if (existing) {
        existing.conn = "on";
        this.#admit(conn, existing);
        return;
      }
    }

    // The shape the join form produces, and any code of that shape is this
    // session: the mock has exactly one. (It used to insist on four capitals,
    // which no join link has produced since the codes became `hvs.` tokens —
    // it refused every participant who tried to join the mock.)
    if (!/^hvs\.[0-9A-Za-z]{8,64}$/.test(code)) {
      return this.#refuse(conn, "no_such_code", `No session with the code ${code}.`);
    }
    // …except one, kept so the locked-lobby refusal is still demonstrable.
    if (/lock$/i.test(code)) {
      return this.#refuse(conn, "lobby_locked", "The host has locked the lobby.");
    }
    if (this.session.joinsLocked) {
      return this.#refuse(conn, "lobby_locked", "The host has locked the lobby.");
    }
    if (nickname.length < 2) {
      return this.#refuse(conn, "invalid_nickname", "Two characters or more.");
    }
    const clash = this.session.find(nickname);
    if (clash && clash.conn === "on") {
      return this.#refuse(
        conn,
        "nickname_taken",
        `${clash.nickname} is already in this session.`,
      );
    }
    const me = clash ?? this.session.add(nickname, false);
    me.conn = "on";
    this.#admit(conn, me);
    this.#startDirector();
  }

  #admit(conn: MockConn, p: MockParticipant): void {
    conn.role = "participant";
    conn.pid = p.pid;
    this.#send(conn, {
      t: "welcome",
      role: "participant",
      sid: this.session.sid,
      pid: p.pid,
      rejoinToken: `tok-${p.pid}`,
      serverTime: Date.now() + SERVER_SKEW_MS,
      protocol: 1,
    });
    this.#sendState(conn);
    this.#broadcastRoster();
  }

  #refuse(
    conn: MockConn,
    reason: Extract<ServerMessage, { t: "refused" }>["reason"],
    message: string,
  ): void {
    this.#send(conn, { t: "refused", reason, message });
  }

  #hostCmd(conn: MockConn, cid: string, cmd: HostCommand): void {
    if (conn.role !== "host") {
      this.#send(conn, {
        t: "refusedCmd",
        cid,
        code: "bad_token",
        message: "Not the host.",
      });
      return;
    }
    // A human took the wheel. The script stops arguing with them.
    this.#directorStopped = true;

    const s = this.session;
    const reject = (code: string, message: string): void => {
      this.#send(conn, { t: "refusedCmd", cid, code, message });
    };
    /** Understood, allowed, and changed nothing. The engine acks these false. */
    const noop = (): void => {
      this.#send(conn, { t: "ack", cid, applied: false });
    };

    switch (cmd.name) {
      case "open":
        if (s.phase !== "draft") {
          return reject("wrong_phase", "The session is already open.");
        }
        s.phase = "lobby";
        s.segment = "lobby";
        break;
      case "start":
        if (s.phase !== "lobby") {
          return reject(
            "wrong_phase",
            s.phase === "running"
              ? "The session is already running."
              : "Open the session before starting it.",
          );
        }
        s.phase = "running";
        break;
      case "close":
        if (s.phase === "closed") return reject("wrong_phase", "Already closed.");
        s.phase = "closed";
        s.segment = "final";
        s.seal = "revealed";
        s.joinsLocked = true;
        break;
      case "session.reopen":
        if (s.phase !== "closed") {
          return reject(
            "wrong_phase",
            s.phase === "draft"
              ? "The session was never opened."
              : "The session is not closed.",
          );
        }
        s.phase = "running";
        s.joinsLocked = false;
        break;
      case "session.restart": {
        if (s.phase === "draft") {
          return reject(
            "wrong_phase",
            "The session was never opened, so there is nothing to clear.",
          );
        }
        // The server's own check, mirrored: a restart frame that does not name
        // this session is not one this session performs.
        if (cmd.confirm !== s.joinCode) {
          return reject("malformed", "Unrecognised command.");
        }
        // The clocks first. A Floor timer that fires after the wipe would
        // start settling a round that no longer exists.
        if (this.#closeTimer !== null) clearTimeout(this.#closeTimer);
        this.#closeTimer = null;
        this.#clearArcadeTimers();
        s.restart();
        break;
      }
      case "segment":
        if (s.phase !== "running") {
          return reject("wrong_phase", "Start the session first.");
        }
        s.segment = cmd.kind;
        break;
      case "holding":
        s.holding =
          cmd.title === "" && cmd.line === ""
            ? null
            : { title: cmd.title, line: cmd.line };
        break;
      case "seal":
        s.seal = cmd.state;
        break;
      case "lobby.lock":
        s.joinsLocked = cmd.locked;
        break;
      // Practice. The mock had no case for it at all, so the frame fell off
      // the end of the switch, was acked as applied, and changed nothing — the
      // one thing a mock must never do, because it is the console's only way
      // to be driven without a room. The engine's two refusals, mirrored: not
      // under a live question, and not under a running round. The round card
      // is allowed, which is where a host decides to practise a game.
      case "practice":
        if (s.questionPhase !== "idle" && s.questionPhase !== "revealed") {
          return reject(
            "wrong_question_phase",
            "A question is open. Reveal it before changing practice.",
          );
        }
        if (s.arcadeOn && s.arcadePhase === "running") {
          return reject(
            "wrong_round_phase",
            "A round is in play. Finish it before changing practice.",
          );
        }
        if (s.practice === cmd.on) return noop();
        s.practice = cmd.on;
        break;
      // The send-off, one step at a time in either direction. Refused with the
      // engine's words when nothing is loaded, and acked as "understood, did
      // nothing" at either end of the walk — which is what the console reads
      // to leave Back unpressable in the montage.
      case "sendoff.next":
        if (s.sendoff === null) {
          return reject("wrong_phase", "No send-off is loaded.");
        }
        if (!s.stepSendoff(1)) return noop();
        break;
      case "sendoff.back":
        if (s.sendoff === null) {
          return reject("wrong_phase", "No send-off is loaded.");
        }
        if (!s.stepSendoff(-1)) return noop();
        break;
      case "participant.kick": {
        const i = s.participants.findIndex((p) => p.pid === cmd.pid);
        if (i === -1) return reject("unknown_participant", "No such participant.");
        s.participants.splice(i, 1);
        break;
      }
      case "participant.release": {
        const p = s.participants.find((x) => x.pid === cmd.pid);
        if (!p) return reject("unknown_participant", "No such participant.");
        p.conn = "away";
        p.nicknameKey = "";
        break;
      }

      /* ---- scoring ---- */

      case "score.set": {
        const activity = s.activity(cmd.activityId);
        if (!activity) return reject("unknown_activity", `No activity ${cmd.activityId}.`);
        const p = s.find_pid(cmd.pid);
        if (!p) return reject("unknown_participant", "No such participant.");
        if (!Number.isFinite(cmd.raw) || cmd.raw < 0) {
          return reject(
            "invalid_score",
            "A raw score must be a finite number, zero or above.",
          );
        }
        // Scoring someone on bench credit is refused rather than stored: the
        // raw would reappear if they were ever un-benched.
        if (p.status[cmd.activityId] === "bench") {
          return reject(
            "bench_cannot_be_scored",
            `${p.nickname} is on bench credit for ${activity.title}.`,
          );
        }
        if (p.status[cmd.activityId] === "played" && p.raw[cmd.activityId] === cmd.raw) {
          return noop();
        }
        p.raw[cmd.activityId] = cmd.raw;
        p.status[cmd.activityId] = "played";
        break;
      }

      case "score.status": {
        const activity = s.activity(cmd.activityId);
        if (!activity) return reject("unknown_activity", `No activity ${cmd.activityId}.`);
        const p = s.find_pid(cmd.pid);
        if (!p) return reject("unknown_participant", "No such participant.");
        if ((p.status[cmd.activityId] ?? "unset") === cmd.status) return noop();
        // Benching discards the raw, exactly as the reducer does.
        if (cmd.status === "played") p.raw[cmd.activityId] = p.raw[cmd.activityId] ?? 0;
        else p.raw[cmd.activityId] = 0;
        p.status[cmd.activityId] = cmd.status;
        break;
      }

      case "spot.grant": {
        const activity = s.activity(cmd.activityId);
        if (!activity) return reject("unknown_activity", `No activity ${cmd.activityId}.`);
        const p = s.find_pid(cmd.pid);
        if (!p) return reject("unknown_participant", "No such participant.");
        // The console must never send this, but the server refuses it anyway:
        // a field that may be blank will be blank.
        if (cmd.reason.trim() === "") {
          return reject(
            "reason_required",
            "A Spot Award needs a reason — it gets read out.",
          );
        }
        if (p.status[cmd.activityId] === "bench") {
          return reject(
            "bench_cannot_receive_spot",
            "They are on bench credit for this activity.",
          );
        }
        if (s.spotsLeft(cmd.activityId) <= 0) {
          return reject("spot_cap_reached", `No Spot Awards left for ${activity.title}.`);
        }
        const spot = s.grantSpot(cmd.pid, cmd.activityId, cmd.reason);
        this.#send(conn, { t: "ack", cid, applied: true });
        this.#broadcastState();
        this.#toast("spot", `Spot Award — ${p.nickname} — ${spot.reason}`);
        return;
      }

      case "spot.revoke": {
        const before = s.spots.length;
        s.spots = s.spots.filter((sp) => sp.seq !== cmd.seq);
        if (s.spots.length === before) return noop();
        break;
      }

      /* ---- trivia ---- */

      case "trivia.open": {
        if (s.questionPhase !== "idle") {
          return reject("wrong_question_phase", "That question is already open.");
        }
        if (!s.question()) return reject("no_more_questions", "That was the last one.");
        this.#send(conn, { t: "ack", cid, applied: true });
        this.#openQuestion(cmd.suddenDeath);
        return;
      }
      case "trivia.close": {
        if (s.questionPhase !== "open") {
          return reject("wrong_question_phase", "No question is open.");
        }
        this.#send(conn, { t: "ack", cid, applied: true });
        this.#closeQuestion();
        this.#broadcastState();
        return;
      }
      case "trivia.reveal": {
        if (s.questionPhase !== "closed") {
          return reject(
            "wrong_question_phase",
            s.questionPhase === "open"
              ? "Close the question before revealing it."
              : "There is nothing to reveal.",
          );
        }
        s.questionPhase = "revealed";
        break;
      }
      /* ---- arcade ---- */

      case "arcade.enter": {
        if (s.phase !== "running") {
          return reject("wrong_phase", "Start the session first.");
        }
        if (s.arcadeOn) return noop();
        s.arcadeOn = true;
        s.assignArcadeNumbers();
        s.resetFloor();
        break;
      }
      case "arcade.round": {
        if (!s.arcadeOn) return reject("not_in_arcade", "Enter the arcade first.");
        if (s.arcadePhase === "card" || s.arcadePhase === "running") {
          return reject("wrong_round_phase", "A round is already in play.");
        }
        this.#startRound(cmd);
        this.#send(conn, { t: "ack", cid, applied: true });
        this.#broadcastState();
        return;
      }
      case "arcade.begin": {
        if (s.arcadePhase !== "card") {
          return reject("wrong_round_phase", "No round card is up.");
        }
        this.#beginPlay();
        this.#send(conn, { t: "ack", cid, applied: true });
        this.#broadcastState();
        return;
      }
      case "arcade.next": {
        if (s.arcadePhase !== "running" || s.arcadePlay?.kind !== "recruitment") {
          return reject("wrong_round_phase", "No item round is running.");
        }
        this.#nextItem();
        this.#send(conn, { t: "ack", cid, applied: true });
        this.#broadcastState();
        return;
      }
      case "arcade.nextStep": {
        const play = s.arcadePlay;
        if (s.arcadePhase !== "running" || play?.kind !== "glass_bridge") {
          return reject("wrong_round_phase", "No bridge round is running.");
        }
        if (play.step + 1 >= play.board.length) {
          return reject("wrong_round_phase", "That was the last step. Send the next wave.");
        }
        this.#nextStep(play);
        this.#send(conn, { t: "ack", cid, applied: true });
        this.#broadcastState();
        return;
      }
      case "arcade.nextWave": {
        const play = s.arcadePlay;
        if (s.arcadePhase !== "running" || play?.kind !== "glass_bridge") {
          return reject("wrong_round_phase", "No bridge round is running.");
        }
        if (play.wave >= 3) {
          return reject("wrong_round_phase", "That was the last wave. End the round.");
        }
        this.#nextWave(play);
        this.#send(conn, { t: "ack", cid, applied: true });
        this.#broadcastState();
        return;
      }
      case "arcade.end": {
        if (s.arcadePhase !== "running") {
          return reject("wrong_round_phase", "No round is running.");
        }
        this.#endRound();
        this.#send(conn, { t: "ack", cid, applied: true });
        this.#broadcastState();
        return;
      }
      case "arcade.reveal": {
        if (s.arcadeRound === null || s.arcadePhase !== "idle") {
          return reject("wrong_round_phase", "There is nothing to reveal.");
        }
        s.arcadePhase = "reveal";
        // The arcade raw lands in the score grid here and not at the close,
        // so the points strip cannot move before the answer is public.
        for (const p of s.participants) {
          if (p.status["arcade"] === "bench") continue;
          p.raw["arcade"] = s.arcadeTotals[p.pid] ?? 0;
          p.status["arcade"] = "played";
        }
        break;
      }

      case "trivia.next": {
        if (s.questionPhase !== "revealed") {
          return reject("wrong_question_phase", "Reveal this one first.");
        }
        if (s.at + 1 >= s.questions.length) {
          return reject("no_more_questions", "That was the last question.");
        }
        s.at += 1;
        s.questionPhase = "idle";
        s.answers = {};
        s.suddenDeath = false;
        s.suddenDeathWinner = null;
        break;
      }
    }
    this.#send(conn, { t: "ack", cid, applied: true });
    this.#broadcastState();
  }

  /* ---- trivia mechanics ---- */

  /**
   * The server's timer, mocked: the question closes at `closesAt` whatever
   * anyone does, and the host closing early clears it. The guard on the
   * index and the deadline is the same one the real runtime uses, because it
   * is the same race — a timeout in flight when the host advances must not
   * close the next question.
   */
  #closeTimer: ReturnType<typeof setTimeout> | null = null;

  #openQuestion(suddenDeath: boolean): void {
    const s = this.session;
    const q = s.question();
    if (!q) return;
    const now = Date.now() + SERVER_SKEW_MS;
    s.questionPhase = "open";
    s.suddenDeath = suddenDeath;
    s.suddenDeathWinner = null;
    s.answers = {};
    s.opensAt = now;
    // Sudden death has no timer at all: it runs until someone is right.
    s.closesAt = suddenDeath ? null : now + q.timeLimitSec * 1000;
    this.#armCloseTimer();
    this.#broadcastState();
    this.#botsAnswer();
  }

  #armCloseTimer(): void {
    const s = this.session;
    if (this.#closeTimer !== null) clearTimeout(this.#closeTimer);
    this.#closeTimer = null;
    if (s.questionPhase !== "open" || s.closesAt === null) return;
    const index = s.at;
    const closesAt = s.closesAt;
    this.#closeTimer = setTimeout(
      () => {
        this.#closeTimer = null;
        if (s.questionPhase !== "open" || s.at !== index || s.closesAt !== closesAt) return;
        this.#closeQuestion();
        this.#broadcastState();
        return;
      },
      Math.max(0, closesAt - (Date.now() + SERVER_SKEW_MS)),
    );
  }

  #closeQuestion(): void {
    const s = this.session;
    if (this.#closeTimer !== null) clearTimeout(this.#closeTimer);
    this.#closeTimer = null;
    s.settleQuestion();
    s.questionPhase = "closed";
    s.opensAt = null;
    s.closesAt = null;
  }

  #answer(conn: MockConn, cid: string, index: number, choice: number): void {
    const s = this.session;
    const pid = conn.pid;
    if (conn.role !== "participant" || pid === null) {
      this.#send(conn, {
        t: "refusedCmd",
        cid,
        code: "forbidden",
        message: "Only a participant can answer.",
      });
      return;
    }
    const refuse = (code: string, message: string): void => {
      this.#send(conn, { t: "refusedCmd", cid, code, message });
    };
    if (s.questionPhase !== "open") return refuse("question_not_open", "That question is closed.");
    if (index !== s.at) return refuse("question_not_open", "That question has moved on.");
    if (s.answers[pid]) return refuse("already_answered", "You are locked in.");
    const q = s.question();
    if (!q || choice < 0 || choice >= q.answers.length) {
      return refuse("invalid_choice", "No such answer.");
    }
    this.#recordAnswer(pid, choice);
    this.#send(conn, { t: "ack", cid, applied: true });
    // Addressed, not broadcast: the count belongs on the console and the big
    // screen, and the only phone that learns anything is the one that tapped.
    // Unless that tap ended a sudden death, in which case the room needs the
    // whole state, because the question just closed.
    if (s.questionPhase === "open") {
      this.#sendStateTo((c) => c.role !== "participant" || c.pid === pid);
    } else {
      this.#broadcastState();
    }
  }

  /** Shared by real taps and by the bots, so both take the same path. */
  #recordAnswer(pid: string, choice: number): void {
    const s = this.session;
    const q = s.question();
    if (!q || s.questionPhase !== "open" || s.answers[pid]) return;
    const correct = q.correct.includes(choice);
    // The mock is the server here, so the response time is the server's
    // clock and nothing the client sent.
    const ms = Math.max(0, Date.now() + SERVER_SKEW_MS - (s.opensAt ?? 0));
    s.answers[pid] = { choice, correct, ms, points: 0, streakBonus: 0 };
    if (s.suddenDeath && correct && s.suddenDeathWinner === null) {
      s.suddenDeathWinner = pid;
      // First correct answer wins, and the question is over. The caller
      // broadcasts; this only moves the state.
      this.#closeQuestion();
    }
  }

  /**
   * The bots tap. Most of them are right, they arrive over a few seconds, and
   * two of them never answer at all — which is what makes "24 of 27" mean
   * something and gives the host a reason to press Close early.
   */
  #botsAnswer(): void {
    const s = this.session;
    const q = s.question();
    if (!q) return;
    const index = s.at;
    const bots = s.participants.filter((p) => p.bot);
    bots.forEach((p, i) => {
      if (i % 7 === 3) return; // two or three people always miss one
      const rightish = (i + index) % 4 !== 0;
      const choice = rightish
        ? (q.correct[0] ?? 0)
        : (q.correct[0] === 0 ? 1 : 0) % q.answers.length;
      const delay = 400 + i * 220 + Math.random() * 900;
      this.#later(() => {
        if (s.at !== index || s.questionPhase !== "open") return;
        this.#recordAnswer(p.pid, choice);
        if (s.questionPhase === "open") {
          this.#sendStateTo((c) => c.role !== "participant" || c.pid === p.pid);
        } else {
          this.#broadcastState();
        }
      }, delay / this.#cfg.speed);
    });
  }


  /* ---- arcade mechanics ---- */

  #lightTimer: ReturnType<typeof setTimeout> | null = null;
  #itemTimer: ReturnType<typeof setTimeout> | null = null;
  #floorTimer: ReturnType<typeof setTimeout> | null = null;
  #botTapTimer: ReturnType<typeof setInterval> | null = null;

  #now(): number {
    return Date.now() + SERVER_SKEW_MS;
  }

  #startRound(cmd: Extract<HostCommand, { name: "arcade.round" }>): void {
    const s = this.session;
    this.#clearArcadeTimers();
    // Every round starts with everyone back on the Floor. Cumulative
    // elimination is the show; it is the wrong shape for a work afternoon.
    s.resetFloor();
    s.arcadeRound = cmd.kind;
    s.arcadePhase = "card";
    s.arcadeStartedAt = null;
    s.arcadeEndsAt = null;
    if (cmd.kind === "recruitment") {
      s.arcadePlay = {
        kind: "recruitment",
        items: RECRUITMENT_ITEMS,
        at: 0,
        secondsPerItem: cmd.secondsPerItem,
        itemEndsAt: 0,
        solvedOrder: [],
        answered: {},
      };
      return;
    }
    if (cmd.kind === "glass_bridge") {
      // The answer is separated from the labels once, here, and never put
      // back together outside the reveal. The content comes from src/arcade/,
      // never from the command — a round config on the wire would be the
      // answer key arriving from a browser.
      const { board, key } = mockSplitBoard(GLASS_BRIDGE_STEPS);
      s.arcadePlay = {
        kind: "glass_bridge",
        board,
        key,
        waveSeconds: cmd.waveSeconds,
        // Fixed now, from the roster that is in the room now, so the waves
        // the round card announces are the waves that cross.
        waveCuts: mockWaveCuts(Object.values(s.arcadeNumbers)),
        wave: 1,
        step: 0,
        // The clocks all start at `beginPlay`. Borrowing the round's for the
        // step would make every step the length of the round.
        waveStartedAt: 0,
        stepStartedAt: 0,
        stepEndsAt: 0,
        broken: board.map(() => null),
        stepped: {},
        position: {},
        elapsedMs: {},
        crossOrder: [],
      };
      return;
    }
    s.arcadePlay = {
      kind: "plan_apply",
      light: "plan",
      lightChangedAt: 0,
      nextChangeAt: 0,
      resources: {},
      target: cmd.target,
      seconds: cmd.seconds,
      finishOrder: [],
    };
  }

  #beginPlay(): void {
    const s = this.session;
    const play = s.arcadePlay;
    if (!play) return;
    const now = this.#now();
    s.arcadePhase = "running";
    s.arcadeStartedAt = now;
    if (play.kind === "recruitment") {
      play.itemEndsAt = now + play.secondsPerItem * 1000;
      s.arcadeEndsAt = now + play.items.length * play.secondsPerItem * 1000;
      this.#armItemTimer();
      this.#botsAnswerItem();
    } else if (play.kind === "glass_bridge") {
      // Wave 1 walks onto the bridge blind, with the longest step it will
      // ever get.
      play.wave = 1;
      play.step = 0;
      play.waveStartedAt = now;
      play.stepStartedAt = now;
      play.stepEndsAt = now + (play.waveSeconds[0] ?? 0) * 1000;
      s.arcadeEndsAt = play.stepEndsAt + this.#glassRemainingMs(play, 1, 0);
      this.#armStepTimer();
      this.#botsStep();
    } else {
      play.light = "plan";
      play.lightChangedAt = now;
      // The first light gets a duration here for the same reason the server
      // does it: the engine has no randomness, so the boundary draws it.
      play.nextChangeAt = now + this.#lightMs();
      s.arcadeEndsAt = now + play.seconds * 1000;
      this.#armLightTimer();
      this.#startBotTaps();
    }
    this.#armFloorTimer();
  }

  #lightMs(): number {
    return LIGHT_MIN_MS + Math.floor(Math.random() * (LIGHT_MAX_MS - LIGHT_MIN_MS + 1));
  }

  #armLightTimer(): void {
    const s = this.session;
    const play = s.arcadePlay;
    if (this.#lightTimer !== null) clearTimeout(this.#lightTimer);
    this.#lightTimer = null;
    if (s.arcadePhase !== "running" || play?.kind !== "plan_apply") return;
    const at = play.nextChangeAt;
    this.#lightTimer = setTimeout(
      () => {
        this.#lightTimer = null;
        const p = s.arcadePlay;
        if (s.arcadePhase !== "running" || p?.kind !== "plan_apply") return;
        if (p.nextChangeAt !== at) return;
        p.light = p.light === "plan" ? "apply" : "plan";
        p.lightChangedAt = this.#now();
        p.nextChangeAt = p.lightChangedAt + this.#lightMs();
        this.#armLightTimer();
        this.#broadcastState();
      },
      Math.max(0, at - this.#now()),
    );
  }

  #armItemTimer(): void {
    const s = this.session;
    const play = s.arcadePlay;
    if (this.#itemTimer !== null) clearTimeout(this.#itemTimer);
    this.#itemTimer = null;
    if (s.arcadePhase !== "running" || play?.kind !== "recruitment") return;
    const at = play.itemEndsAt;
    const item = play.at;
    this.#itemTimer = setTimeout(
      () => {
        this.#itemTimer = null;
        const p = s.arcadePlay;
        if (s.arcadePhase !== "running" || p?.kind !== "recruitment") return;
        if (p.at !== item || p.itemEndsAt !== at) return;
        if (p.at + 1 >= p.items.length) this.#endRound();
        else this.#nextItem();
        this.#broadcastState();
      },
      Math.max(0, at - this.#now()),
    );
  }

  #armFloorTimer(): void {
    const s = this.session;
    if (this.#floorTimer !== null) clearTimeout(this.#floorTimer);
    this.#floorTimer = null;
    if (s.arcadePhase !== "running" || s.arcadeEndsAt === null) return;
    // The step timer owns the Glass Bridge's ending, for the reason the item
    // timer owns Recruitment's: eighteen deadlines accumulate eighteen lots
    // of lag, and a Floor timer at the nominal instant would land on top of
    // wave 3's last step — the six-second one.
    if (s.arcadePlay?.kind === "glass_bridge") return;
    const at = s.arcadeEndsAt;
    this.#floorTimer = setTimeout(
      () => {
        this.#floorTimer = null;
        if (s.arcadePhase !== "running" || s.arcadeEndsAt !== at) return;
        this.#endRound();
        this.#broadcastState();
      },
      Math.max(0, at - this.#now()),
    );
  }

  /* ---- the Glass Bridge ---- */

  #stepTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * How much round is left after the open step's deadline: the rest of this
   * wave, plus every wave that has not walked on yet. Recomputed every time a
   * step opens, so the accumulated lag of eighteen deadlines does not drift
   * the round's end earlier than the truth.
   */
  #glassRemainingMs(play: MockGlassPlay, wave: GlassWave, step: number): number {
    const steps = play.board.length;
    let ms = Math.max(0, steps - step - 1) * (play.waveSeconds[wave - 1] ?? 0) * 1000;
    for (let w = wave + 1; w <= 3; w += 1) {
      ms += steps * (play.waveSeconds[w - 1] ?? 0) * 1000;
    }
    return ms;
  }

  /** Everyone the open step is waiting for. "Not already across" is load-bearing. */
  #bridgeRunners(play: MockGlassPlay): string[] {
    const s = this.session;
    return s.participants
      .filter(
        (p) =>
          s.arcadeStanding[p.pid] !== "drained" &&
          mockWaveOf(s.arcadeNumber(p.pid), play.waveCuts) === play.wave &&
          (play.position[p.pid] ?? 0) < play.board.length,
      )
      .map((p) => p.pid);
  }

  /**
   * Close the open step: drain whoever did not step, and publish the pane
   * that broke.
   *
   * Both halves happen *here* rather than as they occur, and that is the
   * round's one secrecy rule. A pane that broke is the complete answer for
   * that step — with two panes, "the left one broke" is "the right one is
   * real" — so publishing it the instant somebody fell would hand it to the
   * half of their own wave who are still deciding.
   */
  #closeGlassStep(play: MockGlassPlay): void {
    const s = this.session;
    const now = this.#now();
    for (const pid of this.#bridgeRunners(play)) {
      if (pid in play.stepped) continue;
      // Failing to step drains you: a wave crosses as a unit, and somebody
      // left standing on the bridge sits out the rest of the round, which is
      // the one thing the Floor and the Lounge exist to prevent.
      s.drain(pid, now);
    }
    const fell = Object.values(play.stepped).some((held) => !held);
    const answer = play.key[play.step];
    if (fell && answer !== undefined) {
      play.broken[play.step] = answer.real === 0 ? 1 : 0;
    }
    play.stepped = {};
  }

  #armStepTimer(): void {
    const s = this.session;
    const play = s.arcadePlay;
    if (this.#stepTimer !== null) clearTimeout(this.#stepTimer);
    this.#stepTimer = null;
    if (s.arcadePhase !== "running" || play?.kind !== "glass_bridge") return;
    const at = play.stepEndsAt;
    const wave = play.wave;
    const step = play.step;
    this.#stepTimer = setTimeout(
      () => {
        this.#stepTimer = null;
        const p = s.arcadePlay;
        if (s.arcadePhase !== "running" || p?.kind !== "glass_bridge") return;
        if (p.wave !== wave || p.step !== step || p.stepEndsAt !== at) return;
        if (p.step + 1 < p.board.length) this.#nextStep(p);
        else if (p.wave < 3) this.#nextWave(p);
        else this.#endRound();
        this.#broadcastState();
      },
      Math.max(0, at - this.#now()),
    );
  }

  #nextStep(play: MockGlassPlay): void {
    const s = this.session;
    this.#closeGlassStep(play);
    const now = this.#now();
    play.step += 1;
    play.stepStartedAt = now;
    play.stepEndsAt = now + (play.waveSeconds[play.wave - 1] ?? 0) * 1000;
    s.arcadeEndsAt =
      play.stepEndsAt + this.#glassRemainingMs(play, play.wave, play.step);
    this.#armStepTimer();
    this.#botsStep();
  }

  #nextWave(play: MockGlassPlay): void {
    const s = this.session;
    this.#closeGlassStep(play);
    const now = this.#now();
    play.wave = (play.wave + 1) as GlassWave;
    play.step = 0;
    play.waveStartedAt = now;
    play.stepStartedAt = now;
    play.stepEndsAt = now + (play.waveSeconds[play.wave - 1] ?? 0) * 1000;
    s.arcadeEndsAt = play.stepEndsAt + this.#glassRemainingMs(play, play.wave, 0);
    this.#armStepTimer();
    this.#botsStep();
  }

  /**
   * One commitment. The pane is judged, and which pane it was is not kept.
   *
   * Returns whether it held, because the caller has to decide who hears about
   * it and cannot ask afterwards: a fall goes to the whole room and a pane
   * that held goes to three sockets.
   */
  #recordStep(pid: string, choice: 0 | 1, at: number): boolean {
    const s = this.session;
    const play = s.arcadePlay;
    if (play?.kind !== "glass_bridge") return false;
    if (pid in play.stepped) return false;
    const answer = play.key[play.step];
    if (!answer) return false;
    const wave = mockWaveOf(s.arcadeNumber(pid), play.waveCuts);
    const held = choice === answer.real;
    // Decision time, measured from the step's own start. Six of these added
    // up are what "the fastest full crossing" means, because the three waves
    // run at three different step lengths and wall-clock cannot compare them.
    play.elapsedMs[pid] =
      (play.elapsedMs[pid] ?? 0) + Math.max(0, at - play.stepStartedAt);
    play.stepped[pid] = held;
    if (!held) {
      // `broken` is untouched. The pane that has just shattered is the whole
      // answer for this step and half this wave is still deciding.
      s.drain(pid, this.#now());
      return false;
    }
    const position = (play.position[pid] ?? 0) + 1;
    play.position[pid] = position;
    const across = position >= play.board.length;
    // SPEC.md: each step crossed banks 5, wave 1 banks +3 per step for going
    // blind, and the far side is +15. 6 × 8 + 15 = 63, the Floor max.
    s.bank(pid, GLASS_STEP_BANK + (wave === 1 ? GLASS_BLIND_BONUS : 0));
    if (across) {
      s.bank(pid, GLASS_FAR_SIDE);
      play.crossOrder.push(pid);
    }
    return true;
  }

  #nextItem(): void {
    const play = this.session.arcadePlay;
    if (play?.kind !== "recruitment") return;
    play.at += 1;
    play.itemEndsAt = this.#now() + play.secondsPerItem * 1000;
    // Both are per item: a fresh three, and everybody may answer again.
    play.solvedOrder = [];
    play.answered = {};
    this.#armItemTimer();
    this.#botsAnswerItem();
  }

  /**
   * Settle and stop. The Lounge is paid here — SPEC.md's "backed runner
   * crosses +10, backed runner wins +15" — and the totals take the banked
   * points, which a drain never touched.
   */
  #endRound(): void {
    const s = this.session;
    const play = s.arcadePlay;
    this.#clearArcadeTimers();
    // The Glass Bridge's last step has nothing after it to close it, so the
    // round's end closes it — which is also what happens when the host ends
    // a round early with a wave still on the bridge.
    if (play?.kind === "glass_bridge") this.#closeGlassStep(play);
    if (play?.kind === "plan_apply" || play?.kind === "glass_bridge") {
      // The Lounge pays the better of the two and **never their sum**.
      // SPEC.md is explicit that the rule must not change between rounds, and
      // that crossing the line always beats a perfect Lounge: stacking made
      // 25, which tied the 25 a player scores for crossing in fourth place,
      // and let a drained backer finish level with the player who won the
      // Floor. A perfect Lounge round is 15.
      const crossers =
        play.kind === "plan_apply" ? play.finishOrder : play.crossOrder;
      const winner =
        play.kind === "plan_apply"
          ? play.finishOrder[0]
          : mockFastestCrossing(play);
      for (const [pid, seat] of Object.entries(s.arcadeLounge)) {
        const backing = seat.backing;
        if (backing === null) continue;
        if (s.arcadeStanding[backing] !== "floor") continue;
        if (backing === winner) s.bank(pid, 15);
        else if (crossers.includes(backing)) s.bank(pid, 10);
      }
    }
    for (const p of s.participants) {
      const banked = s.arcadeBanked[p.pid] ?? 0;
      s.arcadeTotals[p.pid] = (s.arcadeTotals[p.pid] ?? 0) + banked;
    }
    s.arcadePhase = "idle";
    s.arcadeEndsAt = null;
    s.arcadeRoundIndex += 1;
  }

  #clearArcadeTimers(): void {
    for (const t of [
      this.#lightTimer,
      this.#itemTimer,
      this.#floorTimer,
      this.#stepTimer,
    ]) {
      if (t !== null) clearTimeout(t);
    }
    this.#lightTimer = null;
    this.#itemTimer = null;
    this.#floorTimer = null;
    this.#stepTimer = null;
    if (this.#botTapTimer !== null) clearInterval(this.#botTapTimer);
    this.#botTapTimer = null;
  }

  /* ---- arcade: client frames ---- */

  #arcadeAnswer(conn: MockConn, cid: string, item: number, answer: string): void {
    const s = this.session;
    const pid = conn.pid;
    const refuse = (code: string, message: string): void => {
      this.#send(conn, { t: "refusedCmd", cid, code, message });
    };
    if (conn.role !== "participant" || pid === null) {
      return refuse("forbidden", "Only a participant plays the arcade.");
    }
    const play = s.arcadePlay;
    if (s.arcadePhase !== "running" || play?.kind !== "recruitment") {
      return refuse("wrong_round_phase", "Nothing to answer.");
    }
    if (item !== play.at) return refuse("wrong_round_phase", "That one has moved on.");
    if (pid in play.answered) return refuse("already_answered_item", "You are locked in.");
    this.#recordItemAnswer(pid, answer);
    this.#send(conn, { t: "ack", cid, applied: true });
    // Addressed, not broadcast: the item is open for twenty seconds and the
    // rest of the room is still typing.
    this.#sendStateTo((c) => c.role !== "participant" || c.pid === pid);
  }

  #recordItemAnswer(pid: string, answer: string): void {
    const s = this.session;
    const play = s.arcadePlay;
    if (play?.kind !== "recruitment" || pid in play.answered) return;
    const item = play.items[play.at];
    if (!item) return;
    const folded = mockFold(answer);
    const correct =
      folded !== "" &&
      this.#now() <= play.itemEndsAt &&
      (folded === mockFold(item.answer) ||
        item.accept.some((a) => mockFold(a) === folded));
    play.answered[pid] = correct;
    if (!correct) return;
    // 10, plus 5 for each of the first three correct *in the room*, per item.
    s.bank(pid, 10 + (play.solvedOrder.length < 3 ? 5 : 0));
    play.solvedOrder.push(pid);
  }

  /**
   * One tap, judged against the light at the instant it happened.
   *
   * The grace is one-directional: a tap inside 250 ms of the lock is pulled
   * back to the last instant of the PLAN before it, and nothing is ever
   * pushed the other way. Subtracting it unconditionally would slide a
   * legitimate tap at the start of a PLAN back into the APPLY before it.
   */
  #tapInstant(receivedAt: number, play: MockPlanPlay): number {
    if (play.light !== "apply") return receivedAt;
    const since = play.lightChangedAt;
    if (receivedAt >= since && receivedAt - since < LOCK_GRACE_MS) return since - 1;
    return receivedAt;
  }

  #arcadeTap(conn: MockConn, cid: string, round: number): void {
    const s = this.session;
    const pid = conn.pid;
    const refuse = (code: string, message: string): void => {
      this.#send(conn, { t: "refusedCmd", cid, code, message });
    };
    if (conn.role !== "participant" || pid === null) {
      return refuse("forbidden", "Only a participant plays the arcade.");
    }
    if (!s.arcadeOn) return refuse("not_in_arcade", "The arcade is not open.");
    if (round !== s.arcadeRoundIndex) {
      return refuse("wrong_round_phase", "That round has moved on.");
    }
    const play = s.arcadePlay;
    if (s.arcadePhase !== "running" || play?.kind !== "plan_apply") {
      return refuse("wrong_round_phase", "Nothing to tap.");
    }
    if (s.arcadeStanding[pid] !== "floor") {
      return refuse("not_on_the_floor", "You are in the Lounge. Back a player.");
    }
    this.#recordTap(pid, this.#tapInstant(this.#now(), play));
    this.#send(conn, { t: "ack", cid, applied: true });
    this.#sendStateTo((c) => c.role !== "participant" || c.pid === pid);
  }

  #recordTap(pid: string, at: number): void {
    const s = this.session;
    const play = s.arcadePlay;
    if (play?.kind !== "plan_apply") return;
    if (play.finishOrder.includes(pid)) return;
    if (play.light === "apply" && at >= play.lightChangedAt) {
      // `Error: state lock held by another process`. Drained, not out.
      s.drain(pid, this.#now());
      return;
    }
    const from = play.resources[pid] ?? 0;
    const to = from + 1;
    play.resources[pid] = to;
    for (const c of mockCheckpoints(play.target)) {
      if (from < c && to >= c) s.bank(pid, 5);
    }
    if (to >= play.target) {
      s.bank(pid, 10 + ([15, 10, 5][play.finishOrder.length] ?? 0));
      play.finishOrder.push(pid);
    }
  }

  #arcadeStep(
    conn: MockConn,
    cid: string,
    round: number,
    step: number,
    choice: number,
  ): void {
    const s = this.session;
    const pid = conn.pid;
    const refuse = (code: string, message: string): void => {
      this.#send(conn, { t: "refusedCmd", cid, code, message });
    };
    if (conn.role !== "participant" || pid === null) {
      return refuse("forbidden", "Only a participant plays the arcade.");
    }
    if (!s.arcadeOn) return refuse("not_in_arcade", "The arcade is not open.");
    if (round !== s.arcadeRoundIndex) {
      return refuse("wrong_round_phase", "That round has moved on.");
    }
    const play = s.arcadePlay;
    if (s.arcadePhase !== "running" || play?.kind !== "glass_bridge") {
      return refuse("wrong_round_phase", "There is no bridge.");
    }
    if (s.arcadeStanding[pid] === "drained") {
      return refuse("not_on_the_floor", "You are in the Lounge. Back a player.");
    }
    // Nobody steps out of turn: the whole round is the asymmetry between the
    // waves, and a wave-3 player taking wave 1's step would be taking wave
    // 1's information as well.
    const wave = mockWaveOf(s.arcadeNumber(pid), play.waveCuts);
    if (wave !== play.wave) {
      return refuse(
        "not_your_wave",
        wave > play.wave
          ? `Wave ${wave} is not on the bridge yet. Watch.`
          : `Wave ${wave} has already crossed.`,
      );
    }
    if ((play.position[pid] ?? 0) >= play.board.length) {
      return refuse("wrong_round_phase", "You are already across.");
    }
    if (this.#now() >= play.stepEndsAt) {
      return refuse("floor_locked", "That step has closed.");
    }
    // A frame that crossed a step boundary is a commitment to a pane the
    // player never saw.
    if (step !== play.step) {
      return refuse("wrong_step", `Step ${play.step + 1} is the one that is open.`);
    }
    if (pid in play.stepped) {
      return refuse("already_stepped", "You are on the pane.");
    }
    if (choice !== 0 && choice !== 1) {
      return refuse("invalid_choice", "There are two panes.");
    }
    const held = this.#recordStep(pid, choice, this.#now());
    this.#send(conn, { t: "ack", cid, applied: true });
    // A fall moves the dormitory grid, which is the whole room's surface, so
    // it goes everywhere — and it leaks nothing, because nothing projected
    // from this state says which pane anybody chose. A pane that held moves
    // only the stepper's phone, the console and the big screen.
    if (!held) this.#broadcastState();
    else this.#sendStateTo((c) => c.role !== "participant" || c.pid === pid);
  }

  #arcadeBack(conn: MockConn, cid: string, backing: string): void {
    const s = this.session;
    const pid = conn.pid;
    const refuse = (code: string, message: string): void => {
      this.#send(conn, { t: "refusedCmd", cid, code, message });
    };
    if (conn.role !== "participant" || pid === null) {
      return refuse("forbidden", "Only a participant plays the arcade.");
    }
    const seat = s.arcadeLounge[pid];
    if (!seat) return refuse("not_in_the_lounge", "You are on the Floor.");
    if (backing === pid) return refuse("cannot_back_yourself", "Back somebody else.");
    if (s.arcadeStanding[backing] !== "floor") {
      return refuse("cannot_back_a_drained_player", "They are in the Lounge too.");
    }
    if (s.arcadePhase !== "running") {
      return refuse("floor_locked", "The Floor has closed.");
    }
    // SPEC.md narrows the Lounge on the bridge: "Drained players back someone
    // in a **later** wave." Without the first half, every backer waits for
    // wave 1 to produce a crosser and backs them, which is a certainty rather
    // than a bet; without the second, they switch when their runner falls,
    // which is the same certainty wearing a hat.
    const bridge = s.arcadePlay;
    if (bridge?.kind === "glass_bridge") {
      const held = seat.backing;
      if (held && mockWaveOf(s.arcadeNumber(held), bridge.waveCuts) <= bridge.wave) {
        return refuse("backing_locked", "Your runner is on the bridge. The bet stands.");
      }
      const target = mockWaveOf(s.arcadeNumber(backing), bridge.waveCuts);
      if (target <= bridge.wave) {
        return refuse(
          "must_back_a_later_wave",
          `Wave ${target} is already on the bridge. Back a later wave.`,
        );
      }
    }
    seat.backing = backing;
    this.#send(conn, { t: "ack", cid, applied: true });
    this.#broadcastState();
  }

  /* ---- arcade: the bots ---- */

  #botsAnswerItem(): void {
    const s = this.session;
    const play = s.arcadePlay;
    if (play?.kind !== "recruitment") return;
    const item = play.items[play.at];
    if (!item) return;
    const at = play.at;
    s.participants
      .filter((p) => p.bot)
      .forEach((p, i) => {
        if (i % 6 === 4) return; // somebody always misses one
        const typed = (i + at) % 5 === 0 ? "nomadd" : item.answer;
        this.#later(
          () => {
            const now = s.arcadePlay;
            if (now?.kind !== "recruitment" || now.at !== at) return;
            if (s.arcadePhase !== "running") return;
            this.#recordItemAnswer(p.pid, typed);
            this.#sendStateTo((c) => c.role !== "participant" || c.pid === p.pid);
          },
          (500 + i * 260 + Math.random() * 900) / this.#cfg.speed,
        );
      });
  }

  /**
   * The bots step onto panes, and the asymmetry SPEC.md builds the round on
   * is the thing they demonstrate.
   *
   * Wave 1 goes blind and guesses. Waves 2 and 3 read `broken` off the same
   * projection the room reads it off — the mock's bots are given no more than
   * a participant's frame carries — so they take a published break when there
   * is one and guess when there is not. That is why wave 1 fills the Lounge
   * and why going first is worse, and it is the only way to see it without
   * thirty people in a room.
   *
   * One bot in nine never steps at all, so the timeout drain has something to
   * show, and one drained bot backs somebody in a later wave, so the Lounge
   * and the big screen's backing counts have something to show too.
   */
  #botsStep(): void {
    const s = this.session;
    const play = s.arcadePlay;
    if (play?.kind !== "glass_bridge") return;
    const step = play.step;
    const wave = play.wave;
    const seconds = play.waveSeconds[wave - 1] ?? 6;
    s.participants
      .filter(
        (p) =>
          p.bot &&
          s.arcadeStanding[p.pid] !== "drained" &&
          mockWaveOf(s.arcadeNumber(p.pid), play.waveCuts) === wave &&
          (play.position[p.pid] ?? 0) < play.board.length,
      )
      .forEach((p, i) => {
        // Somebody always freezes. Drained for not stepping, which is a
        // different line on the phone from falling through a pane.
        if ((i + step) % 9 === 3) return;
        // What this bot can see, which is exactly what the wire carries.
        const broke = play.broken[step];
        const known = broke === null ? null : broke === 0 ? 1 : 0;
        const choice: 0 | 1 =
          known !== null
            ? (known as 0 | 1)
            : Math.random() < 0.5
              ? 0
              : 1;
        this.#later(
          () => {
            const now = s.arcadePlay;
            if (now?.kind !== "glass_bridge") return;
            if (s.arcadePhase !== "running") return;
            if (now.wave !== wave || now.step !== step) return;
            if (s.arcadeStanding[p.pid] === "drained") return;
            const held = this.#recordStep(p.pid, choice, this.#now());
            if (!held) this.#broadcastState();
            else {
              this.#sendStateTo((c) => c.role !== "participant" || c.pid === p.pid);
            }
            this.#botsBackFromTheLounge();
          },
          // Spread across the step, and never past its deadline: a bot that
          // commits after the close would be refused by the same guard a
          // phone is, and would look like a bug rather than a bot.
          Math.min(seconds * 900, 300 + i * 220 + Math.random() * seconds * 400) /
            this.#cfg.speed,
        );
      });
  }

  /** A drained bot backs somebody in a later wave, which is the only bet the
   * bridge allows. */
  #botsBackFromTheLounge(): void {
    const s = this.session;
    const play = s.arcadePlay;
    if (play?.kind !== "glass_bridge") return;
    let moved = false;
    for (const p of s.participants) {
      if (!p.bot) continue;
      const seat = s.arcadeLounge[p.pid];
      if (!seat || seat.backing !== null) continue;
      const later = s.participants.filter(
        (x) =>
          s.arcadeStanding[x.pid] === "floor" &&
          x.pid !== p.pid &&
          mockWaveOf(s.arcadeNumber(x.pid), play.waveCuts) > play.wave,
      );
      const pick = later[Math.floor(Math.random() * later.length)];
      if (pick) {
        seat.backing = pick.pid;
        moved = true;
      }
    }
    if (moved) this.#broadcastState();
  }

  /**
   * The bots tap. Most watch the light; a few of them do not, which is what
   * fills the Lounge — and the Lounge is the point of the round. A drained
   * bot then backs somebody, so the big screen has backing to show.
   */
  #startBotTaps(): void {
    const s = this.session;
    if (this.#botTapTimer !== null) clearInterval(this.#botTapTimer);
    this.#botTapTimer = setInterval(() => {
      const play = s.arcadePlay;
      if (s.arcadePhase !== "running" || play?.kind !== "plan_apply") return;
      let moved = false;
      s.participants.forEach((p, i) => {
        if (!p.bot) return;
        if (s.arcadeStanding[p.pid] === "drained") {
          const seat = s.arcadeLounge[p.pid];
          if (seat && seat.backing === null) {
            const floor = s.participants.filter(
              (x) => s.arcadeStanding[x.pid] === "floor",
            );
            const pick = floor[Math.floor(Math.random() * floor.length)];
            if (pick) {
              seat.backing = pick.pid;
              moved = true;
            }
          }
          return;
        }
        // One bot in seven is not watching the light at all.
        const careless = i % 7 === 2;
        if (play.light === "apply" && !careless) return;
        const taps = 1 + Math.floor(Math.random() * 3);
        for (let n = 0; n < taps; n += 1) this.#recordTap(p.pid, this.#now());
        moved = true;
      });
      if (moved) this.#broadcastState();
    }, 220 / this.#cfg.speed);
  }

  #sendStateTo(want: (conn: MockConn) => boolean): void {
    for (const conn of this.#conns) {
      if (conn.role === null || !want(conn)) continue;
      this.#sendState(conn);
    }
  }

  /* ---- mock server → clients ---- */

  /** Stamps the per-connection `seq`, exactly as runtime.ts's `send` does. */
  #send(conn: MockConn, msg: ServerMessage): void {
    if (!conn.open) return;
    let framed = msg;
    if ("seq" in msg) {
      // The injected gap: burn a number so the client sees `last + 2` and
      // does the thing the protocol says, which is ask for the whole state.
      if (this.#gapNext) conn.seq += 1;
      framed = { ...msg, seq: ++conn.seq };
    }
    this.#later(() => {
      if (conn.open) conn.handlers.onMessage(framed);
    }, this.#cfg.latency);
  }

  #sendState(conn: MockConn): void {
    if (conn.role === null) return;
    this.#send(conn, {
      t: "state",
      seq: 0, // replaced per-connection in #send
      state: this.session.render(conn.role, conn.pid),
    });
  }

  #broadcastState(): void {
    for (const conn of this.#conns) {
      if (conn.role === null) continue;
      this.#sendState(conn);
    }
  }

  /** A delta, so the client's `seq` handling is exercised by the normal path. */
  #broadcastRoster(): void {
    if (this.#cfg.gap && !this.#gapUsed && this.session.participants.length >= 5) {
      this.#gapUsed = true;
      this.#gapNext = true;
    }
    const roster = this.session.roster();
    for (const conn of this.#conns) {
      if (conn.role === null) continue;
      // The host's counts and the whole scoring grid live in `hostExtras`,
      // which a roster frame does not carry: a delta would leave the console
      // one joiner behind. They get the whole thing; there is one of them.
      // This is what the real server does — see runtime.ts broadcastRoster.
      if (conn.role === "host") {
        this.#sendState(conn);
        continue;
      }
      this.#send(conn, { t: "roster", seq: 0, roster });
    }
    this.#gapNext = false;
  }

  #toast(kind: "spot" | "text", text: string): void {
    for (const conn of this.#conns) {
      if (conn.role === null) continue;
      this.#send(conn, { t: "toast", seq: 0, kind, text });
    }
  }

  /* ---- the director ---- */

  #later(fn: () => void, ms: number): void {
    this.#timers.push(setTimeout(fn, ms));
  }

  #at(seconds: number, fn: () => void): void {
    const ms = (seconds * 1000) / this.#cfg.speed;
    this.#timers.push(
      setTimeout(() => {
        if (this.#directorStopped) return;
        fn();
      }, ms),
    );
  }

  #startDirector(): void {
    if (this.#directorStarted) return;
    this.#directorStarted = true;

    if (this.#cfg.drop) {
      this.#at(14, () => {
        if (this.#dropped) return;
        this.#dropped = true;
        for (const conn of [...this.#conns]) {
          conn.open = false;
          this.#conns.delete(conn);
          conn.handlers.onClose("mock: the network went away");
        }
      });
    }

    if (!this.#cfg.director) {
      // Manual mode still needs a room, or the console has nothing to show.
      // The session stays in `draft` so the host drives `open` themselves.
      for (let i = 0; i < 6; i++) this.#at(1 + i * 0.4, () => this.#botJoins());
      return;
    }

    for (let i = 0; i < BOT_NAMES.length; i++) {
      this.#at(1.5 + i * 1.1, () => this.#botJoins());
    }

    this.#at(0.5, () => {
      this.session.phase = "lobby";
      this.session.segment = "lobby";
      this.#broadcastState();
    });

    this.#at(9, () => {
      this.session.phase = "running";
      this.session.segment = "holding";
      this.session.holding = {
        title: "Agentic Security TTX",
        line: "Back at 14:20. Prize: the good coffee.",
      };
      this.#broadcastState();
    });

    this.#at(13, () => {
      const p = this.session.participants[2];
      if (p) p.conn = "away";
      this.#broadcastRoster();
    });

    // The TTX: a judged rubric out of 20, and the facilitator who ran it on
    // bench. Raw units differ wildly from the trivia below on purpose — that
    // is the whole reason SCORING.md normalises instead of adding.
    this.#at(18, () => {
      const people = this.session.participants;
      people.forEach((p, i) => {
        if (i === 3) {
          // Ade ran this one. Bench Credit, not a zero.
          p.status["ttx"] = "bench";
          p.raw["ttx"] = 0;
          return;
        }
        p.raw["ttx"] = Math.max(4, 20 - i - Math.floor(Math.random() * 3));
        p.status["ttx"] = "played";
      });
      this.session.segment = "standings";
      this.#broadcastState();
    });

    this.#at(22, () => {
      const star = this.session.participants[1];
      if (!star) return;
      const spot = this.session.grantSpot(star.pid, "ttx", "best question of the day");
      this.#broadcastState();
      this.#toast("spot", `Spot Award — ${star.nickname} — ${spot.reason}`);
    });

    // Trivia, played rather than typed in: one facilitator on bench, then four
    // real questions with the bots tapping. Raw units end up in the thousands
    // against the TTX's twenty, which is the whole reason SCORING.md
    // normalises instead of adding.
    this.#at(24, () => {
      const facilitator = this.session.participants[1];
      if (facilitator) {
        facilitator.status["trivia"] = "bench";
        facilitator.raw["trivia"] = 0;
      }
      this.session.segment = "trivia";
      this.#broadcastState();
    });

    /**
     * One question, on a fixed beat: open, let the bots tap, close early
     * rather than waiting out the timer (which is exactly the dead air the
     * close button exists for), reveal, hold, advance.
     *
     * The last one runs as sudden death, which has no timer at all and ends
     * the moment somebody is right.
     */
    const QUESTION_SECONDS = 11;
    for (let i = 0; i < 4; i += 1) {
      const t = 26 + i * QUESTION_SECONDS;
      const sudden = i === 3;
      this.#at(t, () => this.#openQuestion(sudden));
      // Not for the sudden death: that one closes itself on the first correct
      // answer, and closing it again would be the race the guard is for.
      this.#at(t + 5.5, () => {
        if (this.session.questionPhase !== "open") return;
        this.#closeQuestion();
        this.#broadcastState();
      });
      this.#at(t + 6.5, () => {
        if (this.session.questionPhase !== "closed") return;
        this.session.questionPhase = "revealed";
        this.#broadcastState();
      });
      if (i < 3) {
        this.#at(t + QUESTION_SECONDS - 0.5, () => {
          if (this.session.questionPhase !== "revealed") return;
          this.session.at += 1;
          this.session.questionPhase = "idle";
          this.session.answers = {};
          this.session.suddenDeath = false;
          this.session.suddenDeathWinner = null;
          this.#broadcastState();
        });
      }
    }


    /**
     * The arcade: round 0 Recruitment, then round 1 Plan / Apply.
     *
     * Both run at demo pace rather than SPEC.md's — four seconds an item
     * instead of twenty, twenty-two seconds of Floor instead of seventy-five
     * — because the point of the loop is to watch every screen change, not to
     * play the game. The light durations are the real 2–6 s, since those are
     * what the wipe and the haptic are timed against.
     */
    this.#at(70, () => {
      this.session.segment = "arcade";
      this.session.arcadeOn = true;
      this.session.assignArcadeNumbers();
      this.session.resetFloor();
      this.#broadcastState();
    });
    this.#at(72, () => {
      this.#startRound({
        name: "arcade.round",
        kind: "recruitment",
        secondsPerItem: 4,
      });
      this.#broadcastState();
    });
    this.#at(75, () => {
      this.#beginPlay();
      this.#broadcastState();
    });
    // Six items at four seconds each; the item timer walks them and ends the
    // round on its own, exactly as the server's does.
    this.#at(100, () => {
      if (this.session.arcadePhase !== "idle") return;
      this.session.arcadePhase = "reveal";
      this.#broadcastState();
    });

    this.#at(106, () => {
      this.#startRound({
        name: "arcade.round",
        kind: "plan_apply",
        // A target the bots can actually reach inside the demo Floor, so the
        // finish order and the Lounge's payout are both worth watching.
        target: 60,
        seconds: 22,
      });
      this.#broadcastState();
    });
    this.#at(109, () => {
      this.#beginPlay();
      this.#broadcastState();
    });
    this.#at(133, () => {
      if (this.session.arcadePhase !== "idle") return;
      this.session.arcadePhase = "reveal";
      this.#broadcastState();
    });

    /**
     * Round 5, The Glass Bridge: three waves across six steps.
     *
     * At demo pace — 6 / 4 / 3 seconds a step instead of SPEC.md's 12 / 9 / 6
     * — fast enough that the loop is not mostly this round, slow enough that
     * somebody watching can read two long product names and decide, which is
     * the thing the round is. The *shape* is the real one: wave 1 guesses,
     * wave 2 and wave 3 read the breaks wave 1 left behind off exactly the
     * frame a participant is sent, and the Lounge fills up with wave 1.
     *
     * The scripted mock desynchronises above `speed=1` for the arcade — the
     * bots' own delays are divided by the speed and the server's timers are
     * not — so drive the arcade at `speed=1`.
     */
    this.#at(139, () => {
      this.#startRound({
        name: "arcade.round",
        kind: "glass_bridge",
        waveSeconds: [6, 4, 3],
      });
      this.#broadcastState();
    });
    this.#at(142, () => {
      this.#beginPlay();
      this.#broadcastState();
    });
    // 6 × 6 + 6 × 4 + 6 × 3 = 78 s of bridge, walked by the step timer on its
    // own, exactly as the server's does.
    this.#at(224, () => {
      if (this.session.arcadePhase !== "idle") return;
      this.session.arcadePhase = "reveal";
      for (const p of this.session.participants) {
        if (p.status["arcade"] === "bench") continue;
        p.raw["arcade"] = this.session.arcadeTotals[p.pid] ?? 0;
        p.status["arcade"] = "played";
      }
      this.#broadcastState();
    });

    this.#at(232, () => {
      this.session.segment = "standings";
      this.#broadcastState();
    });

    this.#at(234, () => {
      const p = this.session.participants[4];
      if (!p) return;
      const spot = this.session.grantSpot(
        p.pid,
        "trivia",
        "drew out someone who had not spoken",
      );
      this.#broadcastState();
      this.#toast("spot", `Spot Award — ${p.nickname} — ${spot.reason}`);
    });

    this.#at(236, () => {
      this.session.seal = "sealed";
      this.#broadcastState();
    });

    this.#at(248, () => {
      this.session.seal = "revealed";
      this.session.segment = "final";
      this.#broadcastState();
    });

    /**
     * The send-off, walked the way a host walks it.
     *
     * Here because the Desktop is the surface this segment is mostly about
     * and the Desktop cannot be driven from the console in mock mode — each
     * page carries its own hub, so `?mock=1` is the only way to watch the
     * montage cross-fade, the music arm, and the messages step. The pacing is
     * demo pacing: the montage is cut short at twenty seconds rather than the
     * forty the file asks for — long enough for one cross-fade at the dwell
     * that forty seconds over three photos works out to — and a message holds
     * five seconds instead of however long it takes to read one out.
     */
    this.#at(250, () => {
      this.session.segment = "sendoff";
      this.#broadcastState();
    });
    for (let i = 0; i < 7; i += 1) {
      this.#at(270 + i * 5, () => {
        if (this.session.segment !== "sendoff") return;
        this.session.stepSendoff(1);
        this.#broadcastState();
      });
    }

    // Long enough for the big screen's final reveal to actually finish: four
    // four-second dwells, then the hold on the empty first slot.
    this.#at(312, () => {
      this.#clearArcadeTimers();
      this.session.reset();
      this.#directorStarted = false;
      this.#broadcastState();
      this.#startDirector();
    });
  }

  #botJoins(): void {
    const taken = new Set(this.session.participants.map((p) => p.nicknameKey));
    const name = BOT_NAMES.find((n) => !taken.has(this.session.key(n)));
    if (!name) return;
    this.session.add(name, true);
    this.#broadcastRoster();
  }
}

let hub: MockHub | null = null;

/**
 * A join code for the mock, assembled at runtime.
 *
 * Not a literal: a string of the shape `hvs.` + 24 base62 characters is
 * exactly what GitHub's push protection flags as a Vault root token, and it
 * is right to — a repository cannot tell a convincing fake from a real one.
 */
export function sampleJoinCode(): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let body = "";
  for (let i = 0; i < 24; i += 1) {
    body += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return ["hvs", body].join(".");
}

export function mockTransport(cfg: MockConfig): TransportFactory {
  hub ??= new MockHub(cfg);
  const h = hub;
  return (handlers) => h.connect(handlers);
}

/** The banner every mocked page wears, so nobody demos the fake by accident. */
export function mockBadge(): HTMLElement {
  const el = document.createElement("div");
  el.className = "mock-badge mono";
  el.textContent = "MOCK SERVER";
  return el;
}
