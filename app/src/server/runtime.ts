/**
 * The live session: the thin driver around the pure reducer.
 *
 * The engine decides *what* happens; this decides who hears about it. It holds
 * the sockets, applies effects, and projects a view per role. It contains no
 * game rules — if a rule appears here it is in the wrong file.
 */

import type { WebSocket } from "ws";
import { reduce } from "../engine/reducer.ts";
import { lockInForceAt } from "../engine/arcade.ts";
import { slideMs } from "../engine/sendoff.ts";
import { autoBeat, autoFiresAt } from "../engine/trivia.ts";
import type {
  Activity,
  Audience,
  Effect,
  Event,
  OverUnder,
  ParticipantId,
  QuestionPhase,
  SessionState,
  UnsealShape,
} from "../engine/types.ts";
import type {
  RefusedReason,
  RenderState,
  Role,
  ServerMessage,
} from "../protocol.ts";
import {
  arcadeEligible,
  arcadeStateOf,
  prepareViews,
  renderStateFor,
  rosterOf,
  triviaStateOf,
  type PreparedViews,
} from "./views.ts";
import { TIEBREAK_INDEX } from "../protocol.ts";
import { hashToken, newToken } from "./tokens.ts";
import {
  NO_PERSISTENCE,
  type Persister,
  type SessionPersistence,
} from "./persist.ts";
import {
  MAX_REJOIN_TOKENS,
  type LoadedSession,
  type SessionMeta,
  type StoredParticipant,
} from "./store/types.ts";

export interface Client {
  readonly socket: WebSocket;
  readonly role: Role;
  /** Participants only. */
  readonly pid?: ParticipantId;
  /** Last frame received, for the away/amber indicator. */
  lastSeen: number;
  /**
   * Frames sent to *this* client, not engine events.
   *
   * The engine's `state.seq` counts every accepted event, including ones only
   * the host hears about — locking the lobby moves it twice while a phone is
   * sent nothing. The phone then sees its next frame jump, and the protocol
   * says a jump means resync, so thirty phones resync at once over a host
   * toggling a switch. A per-client counter makes consecutive frames true by
   * construction, so a gap only ever means a genuinely lost frame.
   */
  seq: number;
  /**
   * Round trips this process has measured on this socket, newest last.
   *
   * The server's own measurement, from WebSocket ping/pong frames it sent
   * itself — not the client's `ping { t0 }`, which is the client measuring
   * the client's clock and is a number a phone chooses. See
   * {@link correctedResponseMs}.
   */
  rtt: number[];
  /** When the outstanding WebSocket ping went out, or null if none is. */
  pingSentAt: number | null;
}

/* ------------------------------------------------------------------ */
/* Response time                                                       */
/* ------------------------------------------------------------------ */

/**
 * The cap on the latency correction, from ARCHITECTURE.md "Clocks and
 * fairness": "without it a client on a bad connection could be *advantaged*
 * by a large correction, and with it the worst case is a quarter-second gift
 * that applies equally to everyone on a poor link."
 *
 * Concretely: a 4-second round trip would otherwise hand back two seconds of
 * a twenty-second question, which is worth more than answering fast. Capped,
 * the worst anyone can extract is 250 ms — and someone in Bengaluru on hotel
 * Wi-Fi still gets most of their handicap back, which is the point.
 */
export const MAX_LATENCY_CORRECTION_MS = 250;

/** How many round trips the median is taken over. Five, as on the client. */
export const RTT_SAMPLES = 5;

/**
 * Median, not mean: one packet stuck behind a bufferbloated uplink must not
 * move this socket's estimate for the rest of the question. Null when nothing
 * has been measured yet.
 */
export function medianRtt(samples: readonly number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  // An even count takes the mean of the two middle samples rather than the
  // upper one. With two samples — which is the normal state early on, the
  // probe at hello plus the one at the first question — picking the upper
  // meant `[40, 4000]` reported 4000, the exact bufferbloat outlier this
  // function exists to ignore.
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  return lo === undefined || hi === undefined ? null : (lo + hi) / 2;
}

export function recordRtt(client: Client, rttMs: number): void {
  if (!Number.isFinite(rttMs) || rttMs < 0) return;
  client.rtt.push(rttMs);
  while (client.rtt.length > RTT_SAMPLES) client.rtt.shift();
}

/**
 * `serverReceivedAt − opensAt − min(rtt ÷ 2, 250 ms)`, floored at zero.
 *
 * `rtt` null means this socket has not been measured yet, and the correction
 * is then **zero** rather than an average of the room: a correction is a gift
 * of points, and a gift handed out on no evidence is the thing the cap exists
 * to bound. The unmeasured case is the harsh one on purpose.
 *
 * The floor at zero matters for the same reason from the other end. A clock
 * that jumped backwards, or a correction larger than the elapsed time on a
 * tap that arrived in under half a round trip, would otherwise produce a
 * negative `t` — and `round(base × (1 − (t ÷ T) ÷ 2))` with a negative `t` is
 * *more* than the base points, which is a score no answer can earn.
 */
export function correctedResponseMs(
  receivedAt: number,
  opensAt: number,
  rttMs: number | null,
): number {
  return Math.max(0, receivedAt - opensAt - latencyCorrection(rttMs));
}

/** `min(rtt ÷ 2, 250 ms)`, and zero on a socket nobody has measured. */
export function latencyCorrection(rttMs: number | null): number {
  return rttMs === null ? 0 : Math.min(rttMs / 2, MAX_LATENCY_CORRECTION_MS);
}

/* ------------------------------------------------------------------ */
/* Plan / Apply: the light, and the grace after the lock                */
/* ------------------------------------------------------------------ */

/**
 * SPEC.md: "There is a 250 ms grace after the lock for network latency,
 * because a fair game over a video call is one where the last tap before the
 * light changed is not a loss."
 *
 * It is applied *on top of* the ordinary latency correction, and that is not
 * double-counting: the two are the two legs of the round trip. The correction
 * takes off the upstream leg, reconstructing when the thumb actually came off
 * the glass in server time. The grace covers the downstream leg — the lock
 * left the server at `lightChangedAt` and did not reach the phone until half
 * a round trip later, so a tap made in good faith against the light the phone
 * was showing can land after the lock by that much. SPEC flat-rates it at
 * 250 ms rather than making it per-socket, so nobody's grace depends on a
 * number the server measured about them.
 */
export const LOCK_GRACE_MS = 250;

/**
 * How long the boundary may hold Tug of Raft's frames before sending them.
 *
 * The rope is the one round where the engine emits a broadcast per accepted
 * tap, and SPEC.md's 100 bpm means a hundred players credit roughly 167 beats
 * a second between them. Sent as they land that is a full `RenderState` to
 * the console 167 times a second, which measured at ten megabytes a second
 * and half the container's CPU — and with no backpressure anywhere, a laptop
 * that cannot drain it queues frames until the rope it draws is behind the
 * drum everyone can hear.
 *
 * So the boundary holds them. One beat at 100 bpm is 600 ms and the rope
 * moves smoothly at well under that; 120 ms is roughly a fifth of a beat, far
 * below what anyone can see, and it collapses those 167 frames into eight.
 * The engine still decides every credit the instant it arrives — this only
 * changes when the *picture* of it goes out, which is exactly what the
 * reducer's "a throttled tick for the phones belongs at the boundary" meant.
 */
export const BEAT_FLUSH_MS = 120;

/** SPEC.md: "Phases alternate on random durations between 2 and 6 seconds." */
export const LIGHT_MIN_MS = 2_000;
export const LIGHT_MAX_MS = 6_000;

/**
 * One light duration. The engine has no randomness, so this is drawn here and
 * travels to it on `setLight` as an absolute `until`.
 */
export function pickLightMs(rng: () => number): number {
  const r = Math.min(0.999_999, Math.max(0, rng()));
  return LIGHT_MIN_MS + Math.floor(r * (LIGHT_MAX_MS - LIGHT_MIN_MS + 1));
}

/**
 * One seed, for the two rounds that deal something out.
 *
 * Drawn here for exactly the reason a light duration is: the engine has no
 * randomness, and Tug of Raft's sides are "reshuffled by seed before each of
 * three pulls". A 32-bit integer because `seeded()` treats it as one, and a
 * whole number because a seed with a fractional part hashes to the same
 * sides as its neighbours.
 */
export function pickSeed(rng: () => number): number {
  return Math.floor(Math.min(0.999_999_999, Math.max(0, rng())) * 0x1_0000_0000);
}

/**
 * When a tap happened, in server time, for the engine to judge against the
 * light.
 *
 * `lockedSince` is the start of the APPLY window the tap's corrected instant
 * falls in, or null if it fell on green — {@link lockInForceAt} works that
 * out, and it is deliberately *not* "is the light APPLY right now". A tap
 * made deep inside a lock can land after the light has gone back to green,
 * and it still deserves the grace that a tap made at the same instant on a
 * faster socket would have got.
 *
 * The grace is one-directional on purpose: a tap inside the window is pulled
 * back to the last instant of the PLAN that preceded the lock, and nothing is
 * ever pushed the other way. Subtracting 250 ms unconditionally would be the
 * bug this shape exists to avoid — a legitimate tap at the start of a PLAN
 * would slide back across the boundary into the APPLY before it and drain
 * someone for tapping on green.
 *
 * `lockedSince - 1` is always inside the preceding PLAN, because a light
 * lasts at least {@link LIGHT_MIN_MS}.
 */
export function correctedTapAt(
  receivedAt: number,
  rttMs: number | null,
  lockedSince: number | null,
): number {
  const at = receivedAt - latencyCorrection(rttMs);
  if (lockedSince === null) return at;
  if (at >= lockedSince && at - lockedSince < LOCK_GRACE_MS) {
    return lockedSince - 1;
  }
  return at;
}

/* ------------------------------------------------------------------ */
/* Recruitment: the beat after the last answer                        */
/* ------------------------------------------------------------------ */

/**
 * How long a Recruitment item stays open once everybody has answered it.
 *
 * Not zero, because the person who finished the item is still looking down at
 * their phone: their answer left the glass, the Desktop's counter reached
 * "9 of 9 answered", and closing on that instant would move the room on while
 * the one player who has not yet seen anything is the one who ended the wait.
 * Two seconds is long enough for "Locked in." to land and be read, and short
 * enough to be a beat rather than a wait — what is being removed here is
 * SPEC.md's dead air, "waiting out a 30-second timer when everyone has
 * answered", and trading the rest of the item for two seconds is the removal.
 * The tests pin the magnitude as well as the arithmetic, because every expected
 * instant is written in terms of this constant and a grace of zero would
 * satisfy all of them while giving back the thing the grace exists for.
 */
export const ITEM_ANSWERED_GRACE_MS = 2_000;

export interface SessionSecrets {
  readonly hostTokenHash: string;
  readonly screenTokenHash: string;
}

export interface EventRecord {
  readonly seq: number;
  readonly event: Event;
  readonly at: number;
}

export class SessionRuntime {
  state: SessionState;
  readonly secrets: SessionSecrets;
  readonly clients = new Set<Client>();
  /** rejoin token hash -> pid. Lets a phone that slept come back as itself. */
  private readonly rejoin = new Map<string, ParticipantId>();
  /** pid -> its token hashes, newest last. The half that has to be stored. */
  private readonly rejoinByPid = new Map<ParticipantId, string[]>();
  /** Append-only, for replay and for settling a scoring dispute after the fact. */
  readonly log: EventRecord[] = [];
  /** The roster as last put on the wire, so an identical one is not resent. */
  #rosterSent: string | null = null;
  /** Where a `persist` effect goes. Writes never block {@link apply}. */
  readonly persistence: SessionPersistence;
  readonly createdAt: number;
  /**
   * When this session last actually changed — not when it was last written.
   *
   * The distinction is the whole of #23. `meta()` used to stamp `updatedAt`
   * with whatever clock the caller happened to be holding, and two of its
   * three callers are not transitions at all: recovery writes every row back
   * at boot, and `shutdown` writes every row back on SIGTERM. So a session
   * that finished in August was marked as having changed on every deploy
   * since, its `ttl` — derived from `updatedAt` — was pushed out 90 days each
   * time, and nothing in the table could ever be described as old.
   *
   * Advanced by {@link apply}, on the transitions the engine asks to be
   * persisted, which is the same condition that decides whether a row is
   * written at all. Seeded from META's stored value on `restore`, so a
   * restart does not reset the clock it is there to preserve.
   */
  updatedAt: number;
  /** The armed `closeQuestion`, and exactly which question it is armed for. */
  #closeTimer: ReturnType<typeof setTimeout> | null = null;
  /** The send-off's auto-advance, and which slide it is armed for. */
  #slideTimer: ReturnType<typeof setTimeout> | null = null;
  #slideTimerFor: { at: number; fireAt: number } | null = null;
  /** Trivia's auto-advance, and which beat of which question it is armed for. */
  #beatTimer: ReturnType<typeof setTimeout> | null = null;
  #beatTimerFor: {
    index: number;
    phase: QuestionPhase;
    fireAt: number;
  } | null = null;
  #closeTimerFor: { index: number; closesAt: number } | null = null;
  /** The arcade's three clocks. See {@link armArcadeTimers}. */
  #lightTimer: ReturnType<typeof setTimeout> | null = null;
  #lightTimerFor: { round: number; at: number } | null = null;
  #itemTimer: ReturnType<typeof setTimeout> | null = null;
  #itemTimerFor: {
    round: number;
    item: number;
    at: number;
    ends: number;
  } | null = null;
  #floorTimer: ReturnType<typeof setTimeout> | null = null;
  #floorTimerFor: { round: number; at: number } | null = null;
  #stepTimer: ReturnType<typeof setTimeout> | null = null;
  #stepTimerFor: {
    round: number;
    wave: number;
    step: number;
    at: number;
  } | null = null;
  #pullTimer: ReturnType<typeof setTimeout> | null = null;
  #pullTimerFor: { round: number; pull: number; at: number } | null = null;
  #promptTimer: ReturnType<typeof setTimeout> | null = null;
  #promptTimerFor: { round: number; prompt: number; at: number } | null = null;
  /**
   * The coalescing tick, and who it owes a frame to. See {@link BEAT_FLUSH_MS}.
   *
   * Audiences rather than clients because that is what the engine names, and
   * because a phone that reconnects between a beat and the flush must not be
   * sent a frame addressed to the socket it arrived on before it existed.
   */
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The last time this session's state threw, or null if it never has.
   *
   * Kept rather than only logged because a log line is something you find once
   * you already suspect, and this is a fault whose whole signature is that
   * nothing looks wrong: the session simply stops advancing. `/healthz` counts
   * these across the registry so the number is on a surface somebody watches.
   *
   * Not only timers, though a timer is where it was first noticed. A state
   * that throws when a clock reads it throws when a socket reads it too, and
   * the socket path is the one that can be re-entered forever by a phone that
   * reconnects — see {@link faulted}.
   */
  #fault: { label: string; at: number; why: string } | null = null;
  #dirtyRoom = false;
  #dirtyHost = false;
  #dirtyScreen = false;
  readonly #dirtyPids = new Set<ParticipantId>();
  /**
   * Where the light durations come from. A field rather than a parameter so a
   * test can make the round deterministic without the production path growing
   * an argument nobody passes.
   */
  rng: () => number = Math.random;

  constructor(
    state: SessionState,
    secrets: SessionSecrets,
    persistence: SessionPersistence = NO_PERSISTENCE,
    createdAt = Date.now(),
  ) {
    this.state = state;
    this.secrets = secrets;
    this.persistence = persistence;
    this.createdAt = createdAt;
    // A session that has never transitioned last changed when it was made.
    // `restore` overwrites this with META's value straight afterwards.
    this.updatedAt = createdAt;
  }

  /* ---------------- participants ---------------- */

  issueRejoinToken(pid: ParticipantId): string {
    const token = newToken();
    const hash = hashToken(token);
    this.rejoin.set(hash, pid);
    const held = [...(this.rejoinByPid.get(pid) ?? []), hash];
    // Only the recent ones are on a device anyone still has, and an unbounded
    // list would grow by one item per reconnect for the whole afternoon.
    while (held.length > MAX_REJOIN_TOKENS) {
      const dropped = held.shift();
      if (dropped) this.rejoin.delete(dropped);
    }
    this.rejoinByPid.set(pid, held);
    this.persistParticipant(pid);
    return token;
  }

  pidForRejoin(token: string): ParticipantId | undefined {
    return this.rejoin.get(hashToken(token));
  }

  /** Reinstate the tokens a restart loaded, so phones come back as themselves. */
  restoreRejoinTokens(pid: ParticipantId, hashes: readonly string[]): void {
    const held = hashes.slice(-MAX_REJOIN_TOKENS);
    for (const h of held) this.rejoin.set(h, pid);
    this.rejoinByPid.set(pid, held);
  }

  /**
   * `SESSION#<sid>` / `PARTICIPANT#<pid>`.
   *
   * The snapshot already has the roster, so this item exists for the one thing
   * the snapshot cannot hold: the rejoin token hashes, which live here rather
   * than in `SessionState` because the engine is pure and holds no secrets.
   */
  private persistParticipant(pid: ParticipantId): void {
    const p = this.state.participants[pid];
    if (!p) return;
    const record: StoredParticipant = {
      pid: p.pid,
      nickname: p.nickname,
      nicknameKey: p.nicknameKey,
      playerNumber: p.playerNumber,
      joinedAt: p.joinedAt,
      kicked: p.kicked,
      rejoinTokenHashes: this.rejoinByPid.get(pid) ?? [],
    };
    this.persistence.participant(record);
  }

  /**
   * The console's staged setup, verbatim.
   *
   * Held on the runtime rather than in `SessionState` on purpose. It is not
   * part of the session's history: no event produces it, the reducer never
   * reads it, and replaying the log must not depend on it. It rides in the
   * META row beside the token hashes, which is where the other things a
   * snapshot cannot carry already live.
   */
  setup: string | null = null;

  /**
   * The META row for this session as it stands.
   *
   * Takes no clock on purpose. It used to take `now`, and three callers passed
   * three different things: `apply` passed the transition's time, which was
   * right, while recovery and `shutdown` passed the moment of a write that
   * changed nothing about the session. `updatedAt` is a claim about the
   * session, not about the write, and the field that holds it is the one thing
   * here that a caller is in no position to know. See {@link updatedAt}.
   */
  meta(): SessionMeta {
    return {
      sid: this.state.sid,
      title: this.state.title,
      joinCode: this.state.joinCode,
      phase: this.state.phase,
      seal: this.state.seal,
      hostTokenHash: this.secrets.hostTokenHash,
      screenTokenHash: this.secrets.screenTokenHash,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      setup: this.setup,
    };
  }

  private lastSeenMap(): Map<ParticipantId, number> {
    const m = new Map<ParticipantId, number>();
    for (const c of this.clients) {
      if (!c.pid) continue;
      m.set(c.pid, Math.max(m.get(c.pid) ?? 0, c.lastSeen));
    }
    return m;
  }

  /* ---------------- applying events ---------------- */

  /**
   * Apply an event and fan the resulting effects out to sockets.
   * Returns whether the engine accepted it, plus any rejection to echo back.
   */
  apply(
    event: Event,
    now: number,
  ): { applied: boolean; rejection?: { code: string; message: string } } {
    const before = this.state;
    const result = reduce(this.state, event, now);
    this.state = result.state;

    if (result.applied) {
      this.log.push({ seq: this.state.seq, event, at: now });
    }

    let rejection: { code: string; message: string } | undefined;
    const stateTo: Audience[] = [];
    let sendRoster = false;
    let persist = false;

    for (const effect of result.effects) {
      switch (effect.kind) {
        case "broadcast":
          // Any broadcast means somebody's view changed. Rather than encoding
          // which fields moved, resend the projection — it is a few hundred
          // bytes for thirty people and it cannot go subtly stale.
          //
          // The *audience* is honoured, though, and that is not an
          // optimisation. A trivia answer is addressed to the console, the big
          // screen and the phones that have locked in — they are the surfaces
          // the answered count is on. Fanning it to everyone would be thirty
          // frames per tap, roughly eight hundred frames over one question,
          // and the ones it would add are for phones still deciding, which are
          // not shown the count and would be sent a frame identical to the one
          // they are already holding.
          //
          // There was a third arm here, for `what: "toast"`, which resolved a
          // Spot Award's recipient out of the post-event state and sent the
          // room a `t: "toast"` frame. Spot Awards were the only producer of
          // one, so the arm, the frame and the effect kind all came out
          // together — see ARCHITECTURE.md's note on the missing frame.
          stateTo.push(effect.to);
          // Only a broadcast to the whole room can have moved the roster —
          // and most of them have not. See {@link broadcastRosterIfChanged}.
          if (effect.what === "state" && effect.to === "all") sendRoster = true;
          break;
        case "reject":
          rejection = { code: effect.code, message: effect.message };
          break;
        case "persist":
          persist = true;
          break;
      }
    }

    // The store write happens after the sockets, and returns immediately: the
    // room sees the reveal at socket speed whatever DynamoDB is doing. It is
    // gated on the engine's own `persist` effect, which is why a disconnect
    // does not write — ARCHITECTURE.md is explicit that who is connected is
    // not durable, and persisting it would bring everyone back "present".
    if (persist && result.applied) {
      const seq = this.state.seq;
      // The one place the session's own clock moves. Everything else that
      // writes these rows — recovery at boot, `shutdown` at SIGTERM — is
      // storing a state it did not change, and must not claim otherwise: that
      // claim is what kept every finished session's `ttl` a fortnight in the
      // future for ever. See {@link updatedAt} and `retiredByAge`.
      this.updatedAt = now;
      this.persistence.snapshot(this.state, now);
      this.persistence.event({ seq, event, at: now });
      if (before.phase !== this.state.phase || before.seal !== this.state.seal) {
        // `phase` is what a restart scans on, so META has to keep up with it.
        this.persistence.meta(this.meta());
      }
      if ("pid" in event) this.persistParticipant(event.pid);
    }

    if (event.type === "tapBeat") {
      // The rope's frames are the ones the tick exists for: marked dirty here
      // and sent on the next flush, coalesced with every other beat in the
      // window. Nothing else in the session is emitted often enough to be
      // worth delaying, and delaying anything else would be a lie about when
      // it happened.
      this.#markDirty(stateTo);
    } else if (stateTo.length > 0 || this.heldFrames > 0) {
      // Anything that is not a beat sends what the beats are holding along
      // with its own frame. That is what makes a round ending immediate:
      // `endRound` and `nextPull` come through here, so the last credits of a
      // pull go out with the result rather than sitting in the tick until
      // after the rope has already been settled on screen.
      this.sendStateTo([...this.#takeDirty(), ...stateTo], now);
    }
    if (sendRoster) this.broadcastRosterIfChanged(now);
    // Every transition, not just the trivia ones: the timer is a function of
    // the state, so deriving it here means there is no path — open, close,
    // reveal, next, a host closing the session out from under an open
    // question — that can leave one armed for a question that is gone.
    this.armQuestionTimer(now);
    // Same reasoning, for the arcade's clocks: they are a function of the
    // state, so deriving them at the end of every event means there is no
    // path that can leave one armed for a round that is over.
    this.armArcadeTimers(now);
    // And the send-off's, for the same reason: auto-advance is a function of
    // the state, so a host who switches back to manual, presses next by hand,
    // or walks out of the segment altogether cannot leave a slide clock
    // running behind them.
    this.#armSlideTimer(now);
    // And trivia's, for the same reason again: whether the set is walking
    // itself is a function of the state, so deriving the clock here means
    // there is no path — Manual, a host pressing Reveal by hand, a sudden
    // death, walking out of the segment — that can leave one armed for a beat
    // that is no longer coming.
    this.armBeatTimer(now);
    return rejection ? { applied: result.applied, rejection } : { applied: result.applied };
  }

  /* ---------------- the question timer ---------------- */

  /**
   * Fire `closeQuestion` at `closesAt`, because the engine has no clock.
   *
   * Idempotent, and keyed on *which* question it is armed for. Three things
   * fall out of that, and all three are races that would otherwise be real:
   *
   * - **The host closes early.** `apply` re-arms at the end of every event,
   *   sees a question that is no longer open, and clears the timer. The two
   *   cannot both land.
   * - **A stale timer from the previous question.** It re-checks the index and
   *   the deadline it was armed for before doing anything, so a timeout that
   *   was in flight when the host advanced does not close the *next* question
   *   a fraction of a second after it opened. Node's loop is single-threaded,
   *   so this check is not racing anything — by the time the callback runs the
   *   state is settled, and it either still matches or the timer is moot.
   * - **Both anyway.** If one did slip through, `closeQuestion` on a question
   *   that is already closed is a rejection from the reducer, not a second
   *   transition. The engine stays the only writer of the rule.
   *
   * A restart mid-question re-arms from the recovered state: `closesAt` in the
   * future is scheduled for the instant it always meant, and one in the past
   * fires immediately, which is ARCHITECTURE.md's "re-arms timers from the
   * state" and leaves the room on the reveal rather than on a question that
   * stopped counting down.
   */
  armQuestionTimer(now = Date.now()): void {
    const trivia = triviaStateOf(this.state);
    const want =
      trivia && trivia.phase === "open" && trivia.closesAt !== null
        ? { index: trivia.at, closesAt: trivia.closesAt }
        : null;

    if (want === null) return this.clearQuestionTimer();
    if (
      this.#closeTimerFor !== null &&
      this.#closeTimerFor.index === want.index &&
      this.#closeTimerFor.closesAt === want.closesAt
    ) {
      return; // already armed for exactly this deadline
    }

    this.clearQuestionTimer();
    this.#closeTimerFor = want;
    const timer = setTimeout(
      this.#onTimer("question", () => {
        this.#closeTimer = null;
        this.#closeTimerFor = null;
        const at = triviaStateOf(this.state);
        if (
          !at ||
          at.phase !== "open" ||
          at.at !== want.index ||
          at.closesAt !== want.closesAt
        ) {
          return; // the host got there first, or moved on
        }
        this.apply({ type: "closeQuestion" }, Date.now());
      }),
      Math.max(0, want.closesAt - now),
    );
    // Never the reason the process stays up: SIGTERM has thirty seconds and
    // an unfired question timer must not spend any of them.
    timer.unref?.();
    this.#closeTimer = timer;
  }

  /**
   * The one place a timer callback is allowed to throw.
   *
   * Every `setTimeout` in this class goes through here, and the reason is that
   * a timer is the one caller of {@link apply} with nobody above it. A socket
   * frame throws into the connection handler; an HTTP request throws into the
   * request handler; both lose one caller. A timer throws into Node's event
   * loop, which has no handler, so the process exits 1 — and under ECS that is
   * a restart, which recovers the same row, which arms the same timer.
   *
   * That loop is the failure this guard exists for. `recoverSessions` already
   * refuses to let one bad row take the boot down, but its per-session catch
   * has returned long before the timers it armed ever fire: recovery genuinely
   * succeeded, the server is listening, and the process dies a tick later with
   * nothing about it in the recovery log. The shims cover the shape recovery
   * reads. Nothing covered the shape a callback reads a moment afterwards.
   *
   * ## Why catching here rather than an `uncaughtException` handler
   *
   * A process-wide handler would also stop the exit, and it would be the wrong
   * fix: it catches the throw where the sid is no longer in scope, so the
   * operator gets a stack trace and no way to tell which of thirty sessions
   * stopped. Here the sid and the timer's name are both in hand. A handler in
   * `main.ts` is still worth having as a second line, and it is not this.
   *
   * ## What a fault costs
   *
   * This session's clock stops. The callback has already cleared its own timer
   * field by the time anything downstream can throw, so nothing re-arms and
   * nothing retries: the round stops advancing and the host has to move it on
   * by hand. Every other session keeps its clocks. That is the same trade
   * `recoverSessions` makes one row at a time, and it is the right one — the
   * alternative on offer is not "this session works", it is "no service".
   *
   * Other timers on the same session are deliberately left armed. A state
   * poisoned enough to break one will probably break the next, which costs a
   * second log line and nothing else; disarming them wholesale would turn one
   * bad callback into a session that has certainly stopped rather than one
   * that may only have stumbled.
   */
  #onTimer(label: string, body: () => void): () => void {
    return () => {
      try {
        body();
      } catch (err) {
        this.recordFault(`${label} timer`, err);
      }
    };
  }

  /**
   * Record that something reading this session's state threw, and say so.
   *
   * Public because the timer callbacks are not the only caller that has to
   * survive it. The socket listeners in `main.ts` call this too: a `ws`
   * listener that throws is **fatal** — the emitter calls it synchronously and
   * does not catch, so with no `uncaughtException` handler the process exits 1.
   * That was measured, not assumed, and it is why the first version of this
   * guard did not close the crash loop it was written for. It stopped the row
   * killing the process on the boot tick; the same row then killed it on the
   * first phone that reconnected, and phones reconnect forever with a ten
   * second cap. Same loop, longer period.
   *
   * `err` is stringified defensively. `String(err)` can itself throw — a
   * null-prototype object has no `toString` — and a report that throws while
   * reporting is the original bug wearing a different hat.
   */
  recordFault(label: string, err: unknown): void {
    let why: string;
    try {
      why = String(err);
    } catch {
      why = "(an error that could not be converted to a string)";
    }
    let sid = "(a session with no readable sid)";
    try {
      const s: unknown = this.state?.sid;
      if (typeof s === "string" && s !== "") sid = s;
    } catch {
      /* leave the placeholder */
    }
    const first = this.#fault === null;
    this.#fault = { label, at: Date.now(), why };
    // Only the first one in full. A faulted session is re-entered by every
    // reconnect and every sweep, and a line per attempt buries the line that
    // said what happened under a thousand saying it again.
    if (first) {
      console.error(
        `  fault: ${sid}: ${label} threw, so this session is quarantined and ` +
          `will refuse new connections; every other session is unaffected — ${why}`,
      );
    }
  }

  /** The last fault on this session, for `/healthz` and `/status`. */
  get fault(): { label: string; at: number; why: string } | null {
    return this.#fault;
  }

  /**
   * Whether this session refuses new connections.
   *
   * A session whose state throws when it is read cannot be served: every
   * `hello` builds a projection from that state, so every reconnect is another
   * attempt on the process. Quarantining is what makes the fault terminal for
   * the session instead of for the task — the row stays in the table, the
   * export path still reads it directly, and a host who needs it can take it
   * up with the snapshot rather than by reloading a page that kills the
   * service each time they try.
   */
  get faulted(): boolean {
    return this.#fault !== null;
  }

  clearQuestionTimer(): void {
    if (this.#closeTimer !== null) clearTimeout(this.#closeTimer);
    this.#closeTimer = null;
    this.#closeTimerFor = null;
  }

  /** The deadline the timer is armed for, for tests and for /status. */
  get armedCloseAt(): number | null {
    return this.#closeTimerFor?.closesAt ?? null;
  }


  /* ---------------- the arcade's clocks ---------------- */

  /**
   * Five timers, for the five things the engine cannot do for itself.
   *
   * - **the light**, because the durations are random and the engine has no
   *   randomness;
   * - **the item**, because Recruitment's seven items are twenty seconds each,
   *   nobody should have to press a button seven times to run them, and an item
   *   everybody has already answered is over before its twenty seconds are;
   * - **the step**, because the Glass Bridge is eighteen deadlines — six
   *   steps for each of three waves — and a host pressing a button eighteen
   *   times is a host who is not watching the room;
   * - **the pull**, because Tug of Raft is three pulls of twenty-five
   *   seconds and the seed for the next one's sides has to come from
   *   somewhere the engine is not;
   * - **the Floor**, because Plan / Apply is seventy-five seconds and then it
   *   is over whether or not anyone is looking at the console.
   *
   * Each is keyed on exactly what it is armed for — the round, and the
   * instant — so re-arming is idempotent, a host who ends the round early
   * clears them, and a timeout that was in flight when the round changed
   * checks the state before it does anything. Node's loop is single-threaded,
   * so by the time a callback runs the state is settled: it either still
   * matches or the timer is moot. And if one slipped through anyway, the
   * engine refuses the event; it stays the only writer of the rule.
   */
  /**
   * The send-off's slide clock, when the host has it playing itself.
   *
   * The server holds it rather than the Desktop, so the console, the Desktop
   * and thirty phones move together and a surface that reloads mid-run lands
   * where the room already is. A montage each client timed for itself was
   * fine while the photographs were a block of their own; once a message can
   * be the next slide, three surfaces drifting apart means the host presses
   * Skip on a message the Desktop has not reached.
   *
   * Only during `run`, and only on auto: the title card and the closing card
   * hold until somebody presses, which is the whole of what "do not start it
   * until I click" and "leave the last frame up" mean.
   *
   * Keyed on the slide and its deadline, so re-arming is idempotent and a
   * timeout in flight when the host presses by hand finds the state has moved
   * and does nothing.
   */
  #armSlideTimer(now: number): void {
    const so = this.state.sendoff;
    const here = so?.phase === "run" ? so.plan[so.at] : undefined;
    if (!so || !so.auto || here === undefined || so.slideAt === null) {
      return this.#clearSlideTimer();
    }
    const want = {
      at: so.at,
      fireAt: so.slideAt + slideMs(here, so.content, so.autoSeconds),
    };
    const armed = this.#slideTimerFor;
    if (armed !== null && armed.at === want.at && armed.fireAt === want.fireAt) return;
    this.#clearSlideTimer();
    this.#slideTimerFor = want;
    const timer = setTimeout(
      this.#onTimer("send-off", () => {
        this.#slideTimer = null;
        this.#slideTimerFor = null;
        const at = this.state.sendoff;
        if (!at || at.phase !== "run" || !at.auto || at.at !== want.at) return;
        this.apply({ type: "sendoffNext" }, Date.now());
      }),
      Math.max(0, want.fireAt - now),
    );
    timer.unref?.();
    this.#slideTimer = timer;
  }

  #clearSlideTimer(): void {
    if (this.#slideTimer !== null) clearTimeout(this.#slideTimer);
    this.#slideTimer = null;
    this.#slideTimerFor = null;
  }

  /**
   * Trivia's beat clock: the reveal, and then the next question.
   *
   * The question already closes itself — {@link armQuestionTimer} — so what
   * this adds is the two beats after it. Twenty-four questions is seventy-two
   * presses, and sixty of them are the host pressing the only thing the
   * console was offering.
   *
   * The rule about *whether* there is a beat is `autoBeat` in
   * engine/trivia.ts and is not restated here; this file holds no game rules.
   * What lives here is the clock and the two races every other timer in this
   * class handles the same way:
   *
   * - **The host gets there first.** `apply` re-arms at the end of every
   *   event, so a manual Reveal mid-wait clears this and re-arms for the beat
   *   that now follows. The two cannot both land, and the host pressing early
   *   is exactly the send-off's answer to the same question: the press does
   *   the thing, the state moves, and auto counts from the new state.
   * - **A stale timer.** It is keyed on the question index *and* its phase
   *   *and* the deadline, and re-checks all three before doing anything, so a
   *   callback in flight when the host moved on does nothing. Node's loop is
   *   single-threaded: by the time it runs, the state is settled.
   * - **Both anyway.** `revealQuestion` on something already revealed is a
   *   rejection from the reducer, not a second transition. The engine stays
   *   the only writer of the rule.
   *
   * `advance` is two events in one callback, `nextQuestion` then
   * `openQuestion`, because a set running itself has to put the next question
   * *up* — see the note on {@link autoBeat}. They go through `apply`
   * separately, so each is logged, persisted and broadcast as itself, and the
   * open re-arms the question's own close timer on the way out. If the first
   * is refused the second is not attempted.
   *
   * A restart re-arms from the recovered state, the way `armQuestionTimer`
   * does: a deadline in the future is scheduled for the instant it always
   * meant, and one in the past fires immediately. That is sharper here than
   * it is for a close — it can open a question the moment the process comes
   * back — and it is still right, because the question it opens gets its full
   * `timeLimitSec` from the instant it opens rather than from the instant it
   * was due. Nobody loses answering time; a phone still reconnecting is in
   * the same position as a phone that reconnects mid-question at any other
   * moment. In practice the case is narrow: Auto is off on every session that
   * comes back through `restartSession`, and a process restart mid-set lands
   * in this branch only if the state was in the two-to-eighteen-second window
   * between a close and the next question.
   */
  // Public, as `armQuestionTimer` is and for the same two reasons: /status
  // wants to say what is armed, and a test wants to re-arm against a deadline
  // it has moved into the past rather than waiting three real seconds.
  armBeatTimer(now = Date.now()): void {
    const trivia = triviaStateOf(this.state);
    const fireAt = trivia === null ? null : autoFiresAt(trivia);
    if (trivia === null || fireAt === null) return this.#clearBeatTimer();

    const want = { index: trivia.at, phase: trivia.phase, fireAt };
    const armed = this.#beatTimerFor;
    if (
      armed !== null &&
      armed.index === want.index &&
      armed.phase === want.phase &&
      armed.fireAt === want.fireAt
    ) {
      return; // already armed for exactly this beat
    }
    this.#clearBeatTimer();
    this.#beatTimerFor = want;
    const timer = setTimeout(
      this.#onTimer("trivia auto", () => {
        this.#beatTimer = null;
        this.#beatTimerFor = null;
        const at = triviaStateOf(this.state);
        if (at === null || at.at !== want.index || at.phase !== want.phase) {
          return; // the host got there first, or moved on
        }
        // Asked again rather than remembered, so a state that changed under
        // the timer — Auto switched off, a sudden death opened — decides now.
        const beat = autoBeat({ ...at, of: at.questions.length });
        if (beat === null) return;
        if (beat === "reveal") {
          this.apply({ type: "revealQuestion" }, Date.now());
          return;
        }
        const stepped = this.apply({ type: "nextQuestion" }, Date.now());
        if (!stepped.applied) return;
        this.apply({ type: "openQuestion", suddenDeath: false }, Date.now());
      }),
      Math.max(0, want.fireAt - now),
    );
    // Never the reason the process stays up, for the reason the close timer
    // is not: SIGTERM has thirty seconds and an unfired beat must not spend
    // any of them.
    timer.unref?.();
    this.#beatTimer = timer;
  }

  #clearBeatTimer(): void {
    if (this.#beatTimer !== null) clearTimeout(this.#beatTimer);
    this.#beatTimer = null;
    this.#beatTimerFor = null;
  }

  /** The beat the timer is armed for, for tests and for /status. */
  get armedBeatAt(): number | null {
    return this.#beatTimerFor?.fireAt ?? null;
  }

  armArcadeTimers(now = Date.now()): void {
    this.#armLightTimer(now);
    this.#armItemTimer(now);
    this.#armStepTimer(now);
    this.#armPullTimer(now);
    this.#armPromptTimer(now);
    this.#armFloorTimer(now);
  }

  #armLightTimer(now: number): void {
    const arcade = arcadeStateOf(this.state);
    const play = arcade?.play;
    if (!arcade || arcade.phase !== "running" || play?.kind !== "plan_apply") {
      return this.#clearLightTimer();
    }
    const want = { round: arcade.roundIndex, at: play.nextChangeAt };
    if (
      this.#lightTimerFor !== null &&
      this.#lightTimerFor.round === want.round &&
      this.#lightTimerFor.at === want.at
    ) {
      return;
    }
    this.#clearLightTimer();
    this.#lightTimerFor = want;
    const timer = setTimeout(
      this.#onTimer("arcade light", () => {
        this.#lightTimer = null;
        this.#lightTimerFor = null;
        this.flipLight(Date.now(), want);
      }),
      Math.max(0, want.at - now),
    );
    timer.unref?.();
    this.#lightTimer = timer;
  }

  /**
   * Turn the light, or — once, at the top of the round — give the first one a
   * duration.
   *
   * `beginPlay` sets PLAN with `nextChangeAt` equal to `lightChangedAt`,
   * because that is as far as a reducer with no clock and no randomness can
   * get. That equality is the signal that this light has never been
   * scheduled, and it is the one case where the light does not flip: the
   * round would otherwise lock a quarter of a second after it started.
   */
  flipLight(now: number, armedFor?: { round: number; at: number }): void {
    const arcade = arcadeStateOf(this.state);
    const play = arcade?.play;
    if (!arcade || arcade.phase !== "running" || play?.kind !== "plan_apply") {
      return;
    }
    if (
      armedFor &&
      (armedFor.round !== arcade.roundIndex || armedFor.at !== play.nextChangeAt)
    ) {
      return; // the round moved on under a timeout already in flight
    }
    const scheduled = play.nextChangeAt > play.lightChangedAt;
    const light = scheduled ? (play.light === "plan" ? "apply" : "plan") : play.light;
    this.apply({ type: "setLight", light, until: now + pickLightMs(this.rng) }, now);
  }

  #clearLightTimer(): void {
    if (this.#lightTimer !== null) clearTimeout(this.#lightTimer);
    this.#lightTimer = null;
    this.#lightTimerFor = null;
  }

  /**
   * Recruitment's item clock: close the open item at its deadline — or two
   * seconds after the last person answers it, whichever comes first.
   *
   * The early close is the same affordance trivia has had since SPEC.md put a
   * close button next to "24 of 27 answered", for the reason SPEC gives there:
   * once everybody has answered, the rest of the timer is dead air. The cost
   * falls hardest on the person who answered *wrong*, whose phone says
   * "Locked in." and will say nothing else until the item ends — so the longest
   * wait in the item lands on whoever most needs it over.
   *
   * The count is the Desktop's own: {@link arcadeEligible}, the "9" in the
   * room's "9 of 9 answered", so the beat ends on the number the room is
   * reading rather than on a second total only the boundary can see. A player
   * who cannot answer — drained by an earlier round, since Recruitment itself
   * drains nobody — is in that total and so keeps the item open for its full
   * twenty seconds. That is the right way round: the alternative closes the
   * item while the counter on the wall still says "7 of 9".
   *
   * Keyed on the round, the item, the instant it will fire *and* the item's own
   * deadline, so re-arming stays idempotent now that those last two can differ.
   * The armed instant only ever moves earlier: every event re-arms, and without
   * that rule each one after the last answer would push the two-second grace
   * two seconds further out and the item would never close at all.
   *
   * That rule has one consequence worth being plain about, because it is the
   * one case where the close is not on a counter the room can see full: a phone
   * that joins inside the grace raises the total, so the item can close on
   * "3 of 4". It is still the better end of the trade. Two seconds is not long
   * enough to read an emoji pair and type a product, so holding the item open
   * for that phone spends the room's time on an answer that was not coming, and
   * a join every two seconds would hold the item open indefinitely.
   *
   * And as with every other timer here, the engine is still the only writer:
   * `nextItem` and `endRound` are the two events the deadline already sent, and
   * a timeout that slipped through on a round that has moved is refused.
   */
  #armItemTimer(now: number): void {
    const arcade = arcadeStateOf(this.state);
    const play = arcade?.play;
    if (!arcade || arcade.phase !== "running" || play?.kind !== "recruitment") {
      return this.#clearItemTimer();
    }
    const eligible = arcadeEligible(this.state);
    // Nobody is not everybody: a host who opens Recruitment before the room has
    // joined is waiting for people, not watching them finish, and zero of zero
    // would run the whole board out in a couple of seconds. `>=` rather than `===`
    // because kicking someone who had already answered takes them out of the
    // total without taking them out of `answered`.
    const everybody = eligible > 0 && Object.keys(play.answered).length >= eligible;
    const want = {
      round: arcade.roundIndex,
      item: play.at,
      at: everybody
        ? Math.min(play.itemEndsAt, now + ITEM_ANSWERED_GRACE_MS)
        : play.itemEndsAt,
      ends: play.itemEndsAt,
    };
    const armed = this.#itemTimerFor;
    if (
      armed !== null &&
      armed.round === want.round &&
      armed.item === want.item &&
      armed.ends === want.ends &&
      armed.at <= want.at
    ) {
      return;
    }
    this.#clearItemTimer();
    this.#itemTimerFor = want;
    const last = play.at + 1 >= play.items.length;
    const timer = setTimeout(
      this.#onTimer("arcade item", () => {
        this.#itemTimer = null;
        this.#itemTimerFor = null;
        const at = arcadeStateOf(this.state);
        const now2 = Date.now();
        if (
          !at ||
          at.phase !== "running" ||
          at.roundIndex !== want.round ||
          at.play?.kind !== "recruitment" ||
          at.play.at !== want.item ||
          at.play.itemEndsAt !== want.ends
        ) {
          return;
        }
        // The last item does not advance to a seventh; it ends the round, and
        // the host reveals when they are ready to read the notes out.
        this.apply(last ? { type: "endRound" } : { type: "nextItem" }, now2);
      }),
      Math.max(0, want.at - now),
    );
    timer.unref?.();
    this.#itemTimer = timer;
  }

  #clearItemTimer(): void {
    if (this.#itemTimer !== null) clearTimeout(this.#itemTimer);
    this.#itemTimer = null;
    this.#itemTimerFor = null;
  }

  /**
   * The Glass Bridge's step clock: close the open step at `stepEndsAt`, and
   * open whatever comes next.
   *
   * Three things come next and the timer picks between them, because they are
   * three different engine events and the engine will refuse the wrong one:
   *
   * - another step in this wave — `nextStep`;
   * - the wave's last step, with waves still waiting — `nextWave`;
   * - wave 3's last step — `endRound`, which closes the step on its way past.
   *
   * All three close the open step, and closing is what drains whoever did not
   * step and publishes the pane that broke. That is the round's one secrecy
   * rule and it lives in the engine (`closeGlassStep`), not here: this timer
   * decides only *when*.
   *
   * Keyed on the round, the wave, the step and the deadline, so re-arming is
   * idempotent, a host advancing early clears it, and a timeout in flight
   * when the bridge moved checks the state before it does anything. Node's
   * loop is single-threaded, so by the time the callback runs the state is
   * settled: it either still matches or it is moot.
   */
  #armStepTimer(now: number): void {
    const arcade = arcadeStateOf(this.state);
    const play = arcade?.play;
    if (!arcade || arcade.phase !== "running" || play?.kind !== "glass_bridge") {
      return this.#clearStepTimer();
    }
    const want = {
      round: arcade.roundIndex,
      wave: play.wave,
      step: play.step,
      at: play.stepEndsAt,
    };
    const armed = this.#stepTimerFor;
    if (
      armed !== null &&
      armed.round === want.round &&
      armed.wave === want.wave &&
      armed.step === want.step &&
      armed.at === want.at
    ) {
      return;
    }
    this.#clearStepTimer();
    this.#stepTimerFor = want;
    const lastStep = play.step + 1 >= play.board.length;
    const lastWave = play.wave >= 3;
    const timer = setTimeout(
      this.#onTimer("glass bridge step", () => {
        this.#stepTimer = null;
        this.#stepTimerFor = null;
        const at = arcadeStateOf(this.state);
        if (
          !at ||
          at.phase !== "running" ||
          at.roundIndex !== want.round ||
          at.play?.kind !== "glass_bridge" ||
          at.play.wave !== want.wave ||
          at.play.step !== want.step ||
          at.play.stepEndsAt !== want.at
        ) {
          return; // the host got there first, or the bridge moved on
        }
        this.apply(
          !lastStep
            ? { type: "nextStep" }
            : !lastWave
              ? { type: "nextWave" }
              : { type: "endRound" },
          Date.now(),
        );
      }),
      Math.max(0, want.at - now),
    );
    timer.unref?.();
    this.#stepTimer = timer;
  }

  #clearStepTimer(): void {
    if (this.#stepTimer !== null) clearTimeout(this.#stepTimer);
    this.#stepTimer = null;
    this.#stepTimerFor = null;
  }

  /** What the step timer is armed for. Null outside the Glass Bridge. */
  get armedStepAt(): number | null {
    return this.#stepTimerFor?.at ?? null;
  }

  /**
   * Tug of Raft's pull clock: settle the open pull at `pullEndsAt`, and deal
   * the next one.
   *
   * Two things come next and the timer picks between them, because they are
   * two different engine events and the engine will refuse the wrong one:
   *
   * - another pull — `nextPull`, which closes this one, pays the winners and
   *   the two leaders, reshuffles the sides and restarts the heartbeat;
   * - the last pull — `endRound`, which settles it on the way past.
   *
   * The seed is drawn here, exactly as a light duration is, and for the same
   * reason: the engine has no randomness, and a replayed log has to deal the
   * same sides twice. It is the one thing this timer decides that the engine
   * could not have.
   *
   * Keyed on the round, the pull and the deadline, so re-arming is
   * idempotent, a host cutting a pull short clears it, and a timeout in
   * flight when the pull changed checks the state before it does anything.
   */
  #armPullTimer(now: number): void {
    const arcade = arcadeStateOf(this.state);
    const play = arcade?.play;
    if (!arcade || arcade.phase !== "running" || play?.kind !== "tug_of_raft") {
      return this.#clearPullTimer();
    }
    const want = {
      round: arcade.roundIndex,
      pull: play.pull,
      at: play.pullEndsAt,
    };
    const armed = this.#pullTimerFor;
    if (
      armed !== null &&
      armed.round === want.round &&
      armed.pull === want.pull &&
      armed.at === want.at
    ) {
      return;
    }
    this.#clearPullTimer();
    this.#pullTimerFor = want;
    const last = play.pull + 1 >= play.pulls;
    const timer = setTimeout(
      this.#onTimer("tug pull", () => {
        this.#pullTimer = null;
        this.#pullTimerFor = null;
        const at = arcadeStateOf(this.state);
        if (
          !at ||
          at.phase !== "running" ||
          at.roundIndex !== want.round ||
          at.play?.kind !== "tug_of_raft" ||
          at.play.pull !== want.pull ||
          at.play.pullEndsAt !== want.at
        ) {
          return; // the host got there first, or the round moved on
        }
        this.apply(
          last
            ? { type: "endRound" }
            : { type: "nextPull", seed: pickSeed(this.rng) },
          Date.now(),
        );
      }),
      Math.max(0, want.at - now),
    );
    timer.unref?.();
    this.#pullTimer = timer;
  }

  #clearPullTimer(): void {
    if (this.#pullTimer !== null) clearTimeout(this.#pullTimer);
    this.#pullTimer = null;
    this.#pullTimerFor = null;
  }

  /** What the pull timer is armed for. Null outside Tug of Raft. */
  get armedPullAt(): number | null {
    return this.#pullTimerFor?.at ?? null;
  }

  /**
   * Gganbu's prompt clock: settle the open prompt at `promptEndsAt`, and open
   * the next one.
   *
   * Two things come next and the timer picks between them, because they are two
   * different engine events and the engine will refuse the wrong one:
   *
   * - another prompt — `nextPrompt`, which settles this one, **moves the
   *   tokens**, revokes whoever reached zero and restarts the fifteen seconds;
   * - the last prompt — `endRound`, which settles it on the way past.
   *
   * Settling is the whole of the round's secrecy rule and it lives in the
   * engine (`settleGganbuPrompt`), not here: tokens move there and nowhere
   * else, which is what keeps a rival's count from twitching while a prompt is
   * still open. This timer decides only *when*, and the host's
   * `arcade.nextPrompt` sends the identical event — one code path, so there is
   * no prompt settled by the clock that behaves differently from one settled by
   * the host for anybody downstream.
   *
   * Keyed on the round, the prompt and the deadline, so re-arming is
   * idempotent, a host settling early clears it, and a timeout in flight when
   * the prompt moved checks the state before it does anything. Node's loop is
   * single-threaded, so by the time the callback runs the state is settled: it
   * either still matches or it is moot.
   */
  #armPromptTimer(now: number): void {
    const arcade = arcadeStateOf(this.state);
    const play = arcade?.play;
    if (!arcade || arcade.phase !== "running" || play?.kind !== "gganbu") {
      return this.#clearPromptTimer();
    }
    const want = {
      round: arcade.roundIndex,
      prompt: play.at,
      at: play.promptEndsAt,
    };
    const armed = this.#promptTimerFor;
    if (
      armed !== null &&
      armed.round === want.round &&
      armed.prompt === want.prompt &&
      armed.at === want.at
    ) {
      return;
    }
    this.#clearPromptTimer();
    this.#promptTimerFor = want;
    const last = play.at + 1 >= play.board.length;
    const timer = setTimeout(
      this.#onTimer("gganbu prompt", () => {
        this.#promptTimer = null;
        this.#promptTimerFor = null;
        const at = arcadeStateOf(this.state);
        if (
          !at ||
          at.phase !== "running" ||
          at.roundIndex !== want.round ||
          at.play?.kind !== "gganbu" ||
          at.play.at !== want.prompt ||
          at.play.promptEndsAt !== want.at
        ) {
          return; // the host got there first, or the round moved on
        }
        this.apply(last ? { type: "endRound" } : { type: "nextPrompt" }, Date.now());
      }),
      Math.max(0, want.at - now),
    );
    timer.unref?.();
    this.#promptTimer = timer;
  }

  #clearPromptTimer(): void {
    if (this.#promptTimer !== null) clearTimeout(this.#promptTimer);
    this.#promptTimer = null;
    this.#promptTimerFor = null;
  }

  /** What the prompt timer is armed for. Null outside Gganbu. */
  get armedPromptAt(): number | null {
    return this.#promptTimerFor?.at ?? null;
  }

  /**
   * The Floor's close — for the rounds the Floor's clock actually owns.
   *
   * Recruitment's is owned by the item timer instead, and only one of them may
   * own it. Seven items are twenty seconds *each*, and each one opens a little
   * after its predecessor's deadline because the timer that opened it ran
   * late; the round therefore ends a little after `beginPlay + 7 × 20 s`, by
   * the accumulated lag — sooner than that whenever an item closed early
   * because the room had finished it. Armed as well, the Floor timer fired at the nominal
   * instant and ended the round while the last item still had its tail to run
   * — the last item, every time, and only the last item. The item timer ends
   * the round on the last item (see {@link #armItemTimer}) and `nextItem`
   * keeps `endsAt` in step for the countdown, so nothing is left unowned.
   *
   * Tug of Raft is excluded for the same reason again: three pulls are three
   * deadlines, the pull timer ends the round after the last one, and
   * `nextPull` keeps `endsAt` in step for the countdown.
   *
   * The Glass Bridge is excluded for exactly the same reason and it matters
   * more there: eighteen deadlines accumulate eighteen lots of event-loop
   * lag, so the round's nominal end is always a little before the truth. The
   * Floor timer firing at the nominal instant would end the round on top of
   * wave 3's last step — the six-second one, the one it can least afford to
   * lose the tail of. The step timer ends the round after that step (see
   * {@link #armStepTimer}) and `nextStep`/`nextWave` keep `endsAt` in step
   * for the countdown, so nothing is unowned here either.
   *
   * Gganbu is excluded for the third time for the same reason: six prompts are
   * six deadlines, the prompt timer ends the round after the last one, and
   * `nextPrompt` keeps `endsAt` in step for the countdown. Here the cost of
   * getting it wrong is not a lost tail but a lost settlement — the Floor timer
   * firing at the nominal instant would end the round on top of the last
   * prompt, with the last wagers of the round still unsettled.
   */
  #armFloorTimer(now: number): void {
    const arcade = arcadeStateOf(this.state);
    if (
      !arcade ||
      arcade.phase !== "running" ||
      arcade.endsAt === null ||
      arcade.play?.kind === "recruitment" ||
      arcade.play?.kind === "glass_bridge" ||
      arcade.play?.kind === "tug_of_raft" ||
      arcade.play?.kind === "gganbu"
    ) {
      return this.#clearFloorTimer();
    }
    const want = { round: arcade.roundIndex, at: arcade.endsAt };
    if (
      this.#floorTimerFor !== null &&
      this.#floorTimerFor.round === want.round &&
      this.#floorTimerFor.at === want.at
    ) {
      return;
    }
    this.#clearFloorTimer();
    this.#floorTimerFor = want;
    const timer = setTimeout(
      this.#onTimer("arcade floor", () => {
        this.#floorTimer = null;
        this.#floorTimerFor = null;
        const at = arcadeStateOf(this.state);
        if (
          !at ||
          at.phase !== "running" ||
          at.roundIndex !== want.round ||
          at.endsAt !== want.at
        ) {
          return;
        }
        this.apply({ type: "endRound" }, Date.now());
      }),
      Math.max(0, want.at - now),
    );
    timer.unref?.();
    this.#floorTimer = timer;
  }

  #clearFloorTimer(): void {
    if (this.#floorTimer !== null) clearTimeout(this.#floorTimer);
    this.#floorTimer = null;
    this.#floorTimerFor = null;
  }

  clearArcadeTimers(): void {
    // The coalescing tick is one of the arcade's clocks, so it goes with
    // them. Whatever it was holding is dropped rather than sent, which is
    // safe because of who calls this: in the running server only the drain in
    // main.ts does, and it closes every socket with 1012 moments later, so at
    // most one tick of rope is lost on a connection that is about to
    // reconnect and be sent the whole state again. Tests call it so the
    // process can exit.
    this.#takeDirty();
    this.#clearLightTimer();
    this.#clearItemTimer();
    this.#clearStepTimer();
    this.#clearPullTimer();
    this.#clearPromptTimer();
    this.#clearFloorTimer();
  }

  /** What the light timer is armed for, for tests and for /status. */
  get armedLightAt(): number | null {
    return this.#lightTimerFor?.at ?? null;
  }

  /**
   * What the item timer is armed for: the item's deadline, or the earlier
   * instant an item everybody has answered will close at. Null when no item is
   * open.
   */
  get armedItemAt(): number | null {
    return this.#itemTimerFor?.at ?? null;
  }

  /**
   * What the Floor timer is armed for. Null in Recruitment, in Tug of Raft, in
   * Gganbu and on the Glass Bridge, whose endings the item, pull, prompt and
   * step timers own — see {@link #armFloorTimer}.
   */
  get armedFloorAt(): number | null {
    return this.#floorTimerFor?.at ?? null;
  }

  /* ---------------- the arcade at the socket boundary ---------------- */

  /**
   * One tap in Plan / Apply, turned into an engine event.
   *
   * This is the only place the 250 ms grace exists, for the same reason the
   * trivia correction lives at this boundary: the engine is pure, has no
   * clock and no notion that a network happened. It is handed the instant the
   * tap is to be judged at, and judges it.
   *
   * `round` is checked here rather than in the reducer because `tap` carries
   * no round id: the driver is the only layer that can tell a tap meant for
   * round 1 from one that arrived after the host started round 2. Everything
   * else — drained, already across, the Floor closed — is the engine's.
   */
  tap(
    client: Client,
    round: number,
    receivedAt: number,
  ): { applied: boolean; rejection?: { code: string; message: string } } {
    if (client.pid === undefined) {
      return {
        applied: false,
        rejection: { code: "unknown_participant", message: "Not a participant." },
      };
    }
    const arcade = arcadeStateOf(this.state);
    if (!arcade) {
      return {
        applied: false,
        rejection: { code: "not_in_arcade", message: "The arcade is not open." },
      };
    }
    if (round !== arcade.roundIndex) {
      return {
        applied: false,
        rejection: {
          code: "wrong_round_phase",
          message: "That round has moved on.",
        },
      };
    }
    const play = arcade.play;
    const rtt = medianRtt(client.rtt);
    // The latency correction first, on its own: it reconstructs when the thumb
    // actually came off the glass, and *that* is the instant everything else
    // is decided from.
    const corrected = receivedAt - latencyCorrection(rtt);
    const lockedSince =
      play?.kind === "plan_apply" ? lockInForceAt(play, corrected) : null;
    const at = correctedTapAt(receivedAt, rtt, lockedSince);
    // The grace is a fiction about the *light*, not about the clock, and it
    // must never carry a tap back across the Floor's close. A round that
    // happens to end within 250 ms of a lock would otherwise accept taps whose
    // corrected instant is past `endsAt`: pulled back to `lockedSince - 1`,
    // they land inside the round, on green, and score. The latency correction
    // still applies — someone on a bad link keeps their last taps — but the
    // grace does not get to reopen a Floor that is shut.
    const judgeAt =
      arcade.endsAt !== null && corrected >= arcade.endsAt ? corrected : at;
    return this.apply({ type: "tap", pid: client.pid, at: judgeAt }, receivedAt);
  }

  /**
   * One step onto a pane, turned into an engine event.
   *
   * The instant matters here for a reason Recruitment's answer has no
   * equivalent of: the engine measures the decision time from `stepStartedAt`
   * to `now`, and six decision times added up are what "the fastest full
   * crossing" is settled on — 15 points to somebody's backer. Measured from
   * the frame's arrival that number carries the player's network, which is
   * the exact unfairness ARCHITECTURE.md's latency correction exists to take
   * out of a trivia answer.
   *
   * So the corrected instant is passed as the event's `now`, rather than on
   * the event. `stepPane` carries no instant of its own — unlike `tap`, whose
   * `at` the boundary computes — and the engine is not this task's to change.
   * The two uses `now` has in this event are both ones that should be
   * corrected: the decision time, and whether the commitment beat the step's
   * deadline. A player on a 400 ms link who chose a pane with 200 ms left
   * stepped in time, and the deadline check now agrees with them.
   *
   * The correction is capped at 250 ms and never pushes an instant forward,
   * so it cannot manufacture a decision time of zero or reach back into a
   * step that had already closed — a frame for a step that is no longer open
   * is refused by the engine on `step`, whatever its instant.
   *
   * `round` is checked here rather than in the reducer, exactly as it is for
   * a tap: `stepPane` carries no round id, and the bridge resets to step 0 at
   * every wave and every round, so step 0 is precisely the index a stale
   * frame carries. Everything else — drained, not your wave, already stepped,
   * already across, a pane that is not one of two — is the engine's, and is
   * left to it.
   */
  step(
    client: Client,
    round: number,
    step: number,
    choice: number,
    receivedAt: number,
  ): { applied: boolean; rejection?: { code: string; message: string } } {
    if (client.pid === undefined) {
      return {
        applied: false,
        rejection: { code: "unknown_participant", message: "Not a participant." },
      };
    }
    const arcade = arcadeStateOf(this.state);
    if (!arcade) {
      return {
        applied: false,
        rejection: { code: "not_in_arcade", message: "The arcade is not open." },
      };
    }
    if (round !== arcade.roundIndex) {
      return {
        applied: false,
        rejection: {
          code: "wrong_round_phase",
          message: "That round has moved on.",
        },
      };
    }
    const corrected = receivedAt - latencyCorrection(medianRtt(client.rtt));
    return this.apply(
      { type: "stepPane", pid: client.pid, step, choice },
      corrected,
    );
  }

  /**
   * Unseal, at the boundary: the shape pick, one letter, and **Read the
   * docs**.
   *
   * One method for the three of them because they share the whole of their
   * boundary work, which is one check: `round` is the arcade's `roundIndex`,
   * and none of the three engine events carries one. A pick or a tap in
   * flight when the host starts the next round would otherwise land on it —
   * and in this round that is not a lost frame but a tin handed to somebody
   * who did not choose it.
   *
   * Everything else — drained, the Floor closed, no shape picked yet, a
   * letter that is not on your own tin, a tin that is already open — is the
   * engine's, and is left to it.
   *
   * `receivedAt` is passed through uncorrected, deliberately. The one instant
   * this round measures is when a tin came open, and the engine measures it
   * from `startedAt`, which is the same instant for everybody: subtracting
   * half a round trip would hand the +10 for the fastest in a shape to
   * whoever has the worst connection. A latency correction belongs where a
   * player is judged against a *deadline they could not see coming* — a lock,
   * a step's close, a beat — and the fastest tin is a race everybody runs on
   * the same clock.
   */
  unseal(
    client: Client,
    round: number,
    event:
      | { type: "pickShape"; shape: UnsealShape }
      | { type: "tapLetter"; letter: string }
      | { type: "readDocs" },
    receivedAt: number,
  ): { applied: boolean; rejection?: { code: string; message: string } } {
    if (client.pid === undefined) {
      return {
        applied: false,
        rejection: { code: "unknown_participant", message: "Not a participant." },
      };
    }
    const arcade = arcadeStateOf(this.state);
    if (!arcade) {
      return {
        applied: false,
        rejection: { code: "not_in_arcade", message: "The arcade is not open." },
      };
    }
    if (round !== arcade.roundIndex) {
      return {
        applied: false,
        rejection: {
          code: "wrong_round_phase",
          message: "That round has moved on.",
        },
      };
    }
    const pid = client.pid;
    return this.apply(
      event.type === "pickShape"
        ? { type: "pickShape", pid, shape: event.shape }
        : event.type === "tapLetter"
          ? { type: "tapLetter", pid, letter: event.letter }
          : { type: "readDocs", pid },
      receivedAt,
    );
  }

  /**
   * One tap at the rope in Tug of Raft, turned into an engine event.
   *
   * **This is where the heartbeat is judged**, and it is the reason the frame
   * carries no timestamp. Whether a tap was on the beat is the entire round —
   * SPEC.md: "a raw tap race rewards whoever's phone registers taps fastest,
   * and the beat means everyone is capped at the same rate" — so a
   * client-chosen instant would be an "I hit every beat" claim that nothing
   * could check, and the cap would be worth exactly nothing.
   *
   * The correction is the same one a trivia answer gets and it matters more
   * here than anywhere else in the product. The beat grid is the server's:
   * beat *n* of the pull is `pullStartedAt + n * beatMs`, and the window
   * around it is ±120 ms at 100 bpm. An uncorrected 300 ms link would miss
   * every beat it hit — the player taps in time with the beat their screen is
   * showing, the frame lands 150 ms late, and a round designed so that
   * "the skill is rhythm, not hardware" would be decided by hardware. Taking
   * the upstream leg off reconstructs when the finger actually came down, in
   * server time, and that is the instant the engine judges.
   *
   * There is no grace to go with it, unlike Plan / Apply's 250 ms. A grace is
   * a fiction about a *state the phone was shown late*; a beat is a grid both
   * ends can compute, the phone is drawing the same one off the same absolute
   * epochs, and a tolerance already exists in the engine and is generous.
   *
   * `round` is checked here for the reason a tap's is: `tapBeat` carries no
   * round id, and the pull resets to 0 at every round.
   */
  beat(
    client: Client,
    round: number,
    receivedAt: number,
  ): { applied: boolean; rejection?: { code: string; message: string } } {
    if (client.pid === undefined) {
      return {
        applied: false,
        rejection: { code: "unknown_participant", message: "Not a participant." },
      };
    }
    const arcade = arcadeStateOf(this.state);
    if (!arcade) {
      return {
        applied: false,
        rejection: { code: "not_in_arcade", message: "The arcade is not open." },
      };
    }
    if (round !== arcade.roundIndex) {
      return {
        applied: false,
        rejection: {
          code: "wrong_round_phase",
          message: "That round has moved on.",
        },
      };
    }
    const at = receivedAt - latencyCorrection(medianRtt(client.rtt));
    return this.apply({ type: "tapBeat", pid: client.pid, at }, receivedAt);
  }

  /**
   * One wager in Gganbu, turned into an engine event.
   *
   * The instant is corrected, and the reason is narrower than anywhere else in
   * the arcade: this round measures no instant at all. There is no
   * fastest-anything award in it, `wager` stores no time, and the only thing
   * `now` decides is whether the stake beat the prompt's close. So the
   * correction can admit a frame and can never score one — a player on a
   * 400 ms link who staked with 200 ms left on their own countdown did stake in
   * time, and the deadline check now agrees with them. The correction is capped
   * at 250 ms and never pushes an instant forward, so it cannot reach back into
   * a prompt that had already settled: a stake for the previous prompt is
   * refused by `floor_locked` whatever its instant, because settling closes it.
   *
   * `round` is checked here rather than in the reducer, exactly as a tap's is:
   * `wager` carries no round id, and the prompt resets to 0 at every round, so
   * prompt 0 is precisely the index a stale frame would land on. The *prompt*
   * index is deliberately not on the frame at all — the engine writes against
   * whichever prompt is open and the clock refuses a late one, which is the
   * same guard an index would have been and one fewer number to disagree
   * about.
   *
   * Everything else is the engine's and is left to it: drained, the Floor
   * closed, the prompt closed, a second wager on the same prompt, a stake that
   * is not one to five, and a stake larger than the hand — `invalid_wager`,
   * which is the only refusal that needs to know what they hold.
   */
  wager(
    client: Client,
    round: number,
    pick: OverUnder,
    amount: number,
    receivedAt: number,
  ): { applied: boolean; rejection?: { code: string; message: string } } {
    if (client.pid === undefined) {
      return {
        applied: false,
        rejection: { code: "unknown_participant", message: "Not a participant." },
      };
    }
    const arcade = arcadeStateOf(this.state);
    if (!arcade) {
      return {
        applied: false,
        rejection: { code: "not_in_arcade", message: "The arcade is not open." },
      };
    }
    if (round !== arcade.roundIndex) {
      return {
        applied: false,
        rejection: {
          code: "wrong_round_phase",
          message: "That round has moved on.",
        },
      };
    }
    const corrected = receivedAt - latencyCorrection(medianRtt(client.rtt));
    return this.apply(
      { type: "wager", pid: client.pid, pick, amount },
      corrected,
    );
  }

  /**
   * One typed answer in Recruitment. `item` is the index it was meant for, so
   * a submission sent as the item rolls over is refused rather than landing
   * on an emoji pair the person has not seen.
   */
  submitAnswer(
    client: Client,
    item: number,
    answer: string,
    receivedAt: number,
  ): { applied: boolean; rejection?: { code: string; message: string } } {
    if (client.pid === undefined) {
      return {
        applied: false,
        rejection: { code: "unknown_participant", message: "Not a participant." },
      };
    }
    const play = arcadeStateOf(this.state)?.play;
    if (play?.kind !== "recruitment") {
      return {
        applied: false,
        rejection: { code: "wrong_round_phase", message: "Nothing to answer." },
      };
    }
    if (item !== play.at) {
      return {
        applied: false,
        rejection: {
          code: "wrong_round_phase",
          message: "That one has moved on.",
        },
      };
    }
    return this.apply(
      { type: "submitAnswer", pid: client.pid, answer },
      receivedAt,
    );
  }

  /** The Lounge backs a player. Changeable until the Floor locks. */
  back(
    client: Client,
    backing: ParticipantId,
    receivedAt: number,
  ): { applied: boolean; rejection?: { code: string; message: string } } {
    if (client.pid === undefined) {
      return {
        applied: false,
        rejection: { code: "unknown_participant", message: "Not a participant." },
      };
    }
    return this.apply(
      { type: "backPlayer", pid: client.pid, backing },
      receivedAt,
    );
  }

  /**
   * A participant's tap, turned into an engine event at the socket boundary.
   *
   * This is the only place a response time is computed, and it is computed
   * from this process's clock and this process's latency estimate for this
   * socket. The frame carried no timestamp; the engine is handed `ms` and
   * never learns that a network existed.
   *
   * The `index` check is here rather than in the reducer because
   * `answerQuestion` has no question id on it: the driver is the only layer
   * that can tell a tap meant for question 7 from one that arrived after the
   * host advanced to question 8. Everything else — closed, already answered,
   * choice out of range — is the engine's to refuse, and is left to it.
   */
  answer(
    client: Client,
    index: number,
    choice: number,
    receivedAt: number,
  ): { applied: boolean; rejection?: { code: string; message: string } } {
    if (client.pid === undefined) {
      return {
        applied: false,
        rejection: { code: "unknown_participant", message: "Not a participant." },
      };
    }
    const trivia = triviaStateOf(this.state);
    if (!trivia) {
      return {
        applied: false,
        rejection: { code: "no_questions_loaded", message: "No questions loaded." },
      };
    }
    // A tap on a sudden death carries `TIEBREAK_INDEX`, the position every
    // surface is shown for one; it means the tiebreak open now, and nothing
    // when none is. Any other index has to be the question in play.
    const current =
      index === TIEBREAK_INDEX ? trivia.suddenDeath : index === trivia.at;
    if (!current) {
      return {
        applied: false,
        rejection: {
          code: "question_not_open",
          message: "That question has moved on.",
        },
      };
    }
    const ms =
      trivia.opensAt === null
        ? 0
        : correctedResponseMs(receivedAt, trivia.opensAt, medianRtt(client.rtt));
    return this.apply(
      { type: "answerQuestion", pid: client.pid, choice, ms },
      receivedAt,
    );
  }

  /* ---------------- sending ---------------- */

  /**
   * One socket's frame. A fan-out prepares the projection once instead — see
   * {@link prepareViews} and {@link #sendPrepared}.
   */
  viewFor(client: Client, now: number): RenderState {
    return renderStateFor(this.state, {
      role: client.role,
      ...(client.pid ? { pid: client.pid } : {}),
      lastSeen: this.lastSeenMap(),
      now,
    });
  }

  send(client: Client, message: ServerMessage): void {
    if (client.socket.readyState !== 1) return; // OPEN
    const framed =
      "seq" in message ? { ...message, seq: ++client.seq } : message;
    try {
      client.socket.send(JSON.stringify(framed));
    } catch {
      // A socket that fails mid-send is already gone; the close handler tidies up.
    }
  }

  sendAll(message: ServerMessage): void {
    // Each send stamps its own per-client seq, so this cannot be hoisted.
    for (const c of this.clients) this.send(c, message);
  }

  sendState(client: Client, now: number): void {
    this.send(client, {
      t: "state",
      seq: 0, // replaced per-client in send()
      state: this.viewFor(client, now),
    });
  }

  /** The frame this socket's role and pid take out of a prepared projection. */
  private static frameOf(views: PreparedViews, client: Client): RenderState {
    if (client.role === "host") return views.host();
    if (client.role === "screen") return views.screen();
    return views.participant(client.pid);
  }

  private sendPrepared(client: Client, views: PreparedViews): void {
    this.send(client, {
      t: "state",
      seq: 0, // replaced per-client in send()
      state: SessionRuntime.frameOf(views, client),
    });
  }

  broadcastState(now: number): void {
    if (this.clients.size === 0) return;
    const views = prepareViews(this.state, this.lastSeenMap(), now);
    for (const c of this.clients) this.sendPrepared(c, views);
  }

  /** Whether one engine audience covers this socket. */
  private static addressed(to: Audience, client: Client): boolean {
    if (to === "all") return true;
    if (to === "host") return client.role === "host";
    if (to === "screen") return client.role === "screen";
    return client.pid !== undefined && client.pid === to.pid;
  }

  /**
   * One state frame to every client any of these audiences names, and exactly
   * one: a participant who is also named by `all` must not get two.
   */
  sendStateTo(audiences: readonly Audience[], now: number): void {
    if (audiences.length === 0) return;
    // Prepared once for the whole fan-out. Standings, the roster, the grid
    // and the round views are a function of `(state, role)` — projecting per
    // socket recomputed all of that once per client, so a hundred phones
    // meant a hundred identical sorts of the same scores. See
    // {@link prepareViews}.
    let views: PreparedViews | null = null;
    for (const c of this.clients) {
      if (!audiences.some((to) => SessionRuntime.addressed(to, c))) continue;
      views ??= prepareViews(this.state, this.lastSeenMap(), now);
      this.sendPrepared(c, views);
    }
  }

  /* ---------------- the coalescing tick ---------------- */

  /**
   * How many audiences the tick owes a frame to.
   *
   * Public because it is the only way to assert the thing the tick is for —
   * that a credited beat has been counted and *not* yet put on the wire.
   */
  get heldFrames(): number {
    return (
      (this.#dirtyRoom ? 1 : 0) +
      (this.#dirtyHost ? 1 : 0) +
      (this.#dirtyScreen ? 1 : 0) +
      this.#dirtyPids.size
    );
  }

  #markDirty(audiences: readonly Audience[]): void {
    if (audiences.length === 0) return; // an off-beat tap broadcasts nothing
    for (const to of audiences) {
      if (to === "all") this.#dirtyRoom = true;
      else if (to === "host") this.#dirtyHost = true;
      else if (to === "screen") this.#dirtyScreen = true;
      else this.#dirtyPids.add(to.pid);
    }
    // Not re-armed on every beat: the window starts at the first beat it
    // holds and closes `BEAT_FLUSH_MS` later, so a room that never stops
    // tapping still gets a frame on every tick. Re-arming would let a busy
    // rope starve itself indefinitely.
    if (this.#flushTimer !== null) return;
    const timer = setTimeout(
      this.#onTimer("frame flush", () => {
        this.#flushTimer = null;
        this.flushFrames(Date.now());
      }),
      BEAT_FLUSH_MS,
    );
    timer.unref?.();
    this.#flushTimer = timer;
  }

  /** Empties the tick and returns what it was holding, as audiences. */
  #takeDirty(): Audience[] {
    const out: Audience[] = [];
    if (this.#dirtyRoom) out.push("all");
    if (this.#dirtyHost) out.push("host");
    if (this.#dirtyScreen) out.push("screen");
    for (const pid of this.#dirtyPids) out.push({ pid });
    this.#dirtyRoom = false;
    this.#dirtyHost = false;
    this.#dirtyScreen = false;
    this.#dirtyPids.clear();
    if (this.#flushTimer !== null) clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
    return out;
  }

  /**
   * Send whatever the tick is holding, now.
   *
   * The timer's own callback, and the way a test gets a deterministic flush
   * without waiting on a real clock.
   */
  flushFrames(now: number): void {
    this.sendStateTo(this.#takeDirty(), now);
  }

  /** `except` is the client that has just been sent a full state already. */
  broadcastRoster(now: number, except?: Client): void {
    const roster = rosterOf(this.state, this.lastSeenMap(), now);
    this.#rosterSent = JSON.stringify(roster);
    for (const c of this.clients) {
      if (c === except) continue;
      // The host's counts live in hostExtras, which a roster frame does not
      // carry — sending them a delta would leave the console's headcount
      // stale. They get the whole thing; there is one of them.
      if (c.role === "host") this.sendState(c, now);
      else this.send(c, { t: "roster", seq: 0, roster });
    }
  }

  /**
   * The roster, but only when it has actually moved since it last went out.
   *
   * A `to: "all"` state broadcast used to force one unconditionally, which
   * cost a second full frame on every socket — the host's is a whole
   * `RenderState`, not a delta — for every checkpoint, every light turn and
   * every drain. Over a 75 s Floor with sixty players that was 11 100 roster
   * frames to the phones alongside 11 121 state frames, and not one of them
   * carried anything new: the roster moves on join, disconnect, reconnect,
   * kick and release, and every one of those paths calls
   * {@link broadcastRoster} directly (see main.ts). It does not move on a tap.
   *
   * The comparison is on the projected roster rather than on the event type,
   * because the away/amber flag is a function of the clock as well as of the
   * state and `sweep` is not the only thing that can flip it.
   */
  private broadcastRosterIfChanged(now: number): void {
    const roster = rosterOf(this.state, this.lastSeenMap(), now);
    if (JSON.stringify(roster) === this.#rosterSent) return;
    this.broadcastRoster(now);
  }

  refuse(socket: WebSocket, reason: RefusedReason, message: string): void {
    try {
      socket.send(JSON.stringify({ t: "refused", reason, message }));
      socket.close(1008, reason);
    } catch {
      /* already gone */
    }
  }

  /**
   * Participants whose socket has gone quiet are marked away, not removed.
   *
   * Every fifteen seconds, so that amber appears without anyone having to do
   * anything — but only when something has actually gone amber or come back.
   * A quiet room of sixty was otherwise sixty frames every sweep to repaint a
   * roster that had not changed.
   */
  sweep(now: number): void {
    this.broadcastRosterIfChanged(now);
  }
}

/* ------------------------------------------------------------------ */

export interface CreatedSession {
  readonly runtime: SessionRuntime;
  /** Shown once, at creation. Never retrievable afterwards. */
  readonly hostToken: string;
  readonly screenToken: string;
}

export class SessionRegistry {
  private readonly bySid = new Map<string, SessionRuntime>();
  private readonly byCode = new Map<string, string>();
  /** Null in a bare registry: sessions are then in memory and nowhere else. */
  private readonly persister: Persister | null;

  constructor(persister: Persister | null = null) {
    this.persister = persister;
  }

  private persistenceFor(sid: string): SessionPersistence {
    return this.persister ? this.persister.forSession(sid) : NO_PERSISTENCE;
  }

  add(state: SessionState, now = Date.now(), setup: string | null = null): CreatedSession {
    const hostToken = newToken();
    const screenToken = newToken();
    const runtime = new SessionRuntime(
      state,
      {
        hostTokenHash: hashToken(hostToken),
        screenTokenHash: hashToken(screenToken),
      },
      this.persistenceFor(state.sid),
      now,
    );
    runtime.setup = setup;
    this.bySid.set(state.sid, runtime);
    // No case folding: the code is base62 and case is significant.
    this.byCode.set(state.joinCode, state.sid);

    // META first: it carries the token hashes, and a session that came back
    // with its scores and no way for the host to sign in would be worse than
    // one that did not come back at all. Then a snapshot, so a crash between
    // creation and the first event still recovers something coherent.
    runtime.persistence.meta(runtime.meta());
    runtime.persistence.snapshot(state, now);
    return { runtime, hostToken, screenToken };
  }

  /**
   * Put a session loaded from the store back in the registry.
   *
   * The caller has already rebuilt the state; this reattaches the identity
   * (token hashes, rejoin tokens, join code) that the snapshot does not carry.
   */
  restore(
    loaded: LoadedSession,
    state: SessionState,
  ): SessionRuntime {
    const runtime = new SessionRuntime(
      state,
      {
        hostTokenHash: loaded.meta.hostTokenHash,
        screenTokenHash: loaded.meta.screenTokenHash,
      },
      this.persistenceFor(state.sid),
      loaded.meta.createdAt,
    );
    runtime.setup = loaded.meta.setup ?? null;
    // The clock the row came in with, not this boot's. Recovery is about to
    // write this row straight back, and if that write moved `updatedAt` the
    // session would look freshly changed on every deploy — which is how a
    // session that finished in August stayed permanently young. See
    // `retiredByAge`.
    //
    // The fallbacks are not tidiness. `updatedAt` is what the DynamoDB store
    // derives `ttl` from, so carrying a zero back out of a row that has no
    // usable timestamp would write an expiry ninety days after the epoch —
    // which is to say in the past, which is to say DynamoDB deletes the
    // session. Recovery must not be the thing that destroys the row it is
    // recovering. A row that cannot say when it last changed is stamped with
    // this boot instead: that is the old behaviour, it is wrong in the
    // direction of keeping things, and it applies only to a row written before
    // `updatedAt` existed or by hand.
    const stamped = [loaded.meta.updatedAt, loaded.meta.createdAt].find(
      (t) => typeof t === "number" && Number.isFinite(t) && t > 0,
    );
    runtime.updatedAt = stamped ?? Date.now();
    for (const p of loaded.participants) {
      runtime.restoreRejoinTokens(p.pid, p.rejoinTokenHashes);
    }
    for (const e of loaded.events) {
      runtime.log.push({ seq: e.seq, event: e.event, at: e.at });
    }
    this.bySid.set(state.sid, runtime);
    this.byCode.set(state.joinCode, state.sid);
    try {
      // A restart mid-question: re-arm from the recovered state before anyone
      // reconnects, so a deadline that passed during the gap closes on the
      // first tick rather than leaving a question open forever with nobody to
      // close it.
      runtime.armQuestionTimer();
      // And the arcade's, for the same reason: a round that was running when
      // the process went away comes back with its light turning and its Floor
      // still due to close.
      runtime.armArcadeTimers();
    } catch (err) {
      // Arming reads the state, so it can throw on a poisoned row — and some
      // of it throws *synchronously*, before any timer is scheduled: a
      // recruitment round whose `play.items` is missing dies inside
      // `#armItemTimer` on `play.items.length`, right here.
      //
      // The two `set` calls above have already happened at that point, and
      // this throw leaves `recoverSessions` to log the row as COULD NOT BE
      // REBUILT and skip it. Both were true at once: the boot log said the
      // session was not recovered, and the session was live in the registry
      // with a join code that resolved to it. A phone could walk into a room
      // the log said did not exist.
      //
      // So the registration is undone. Registering after arming instead would
      // leave a scheduled timer pointing at a runtime nobody can reach, which
      // is the same inconsistency facing the other way.
      this.bySid.delete(state.sid);
      this.byCode.delete(state.joinCode);
      throw err;
    }
    return runtime;
  }

  bySessionId(sid: string): SessionRuntime | undefined {
    return this.bySid.get(sid);
  }

  byJoinCode(code: string): SessionRuntime | undefined {
    const sid = this.byCode.get(code.trim());
    return sid ? this.bySid.get(sid) : undefined;
  }

  takenCodes(): Set<string> {
    return new Set(this.byCode.keys());
  }

  all(): SessionRuntime[] {
    return [...this.bySid.values()];
  }

  /** `sessionsLive` in /healthz — the deploy-freeze signal. */
  liveCount(): number {
    return this.all().filter(
      (r) => r.state.phase === "lobby" || r.state.phase === "running",
    ).length;
  }

  socketCount(): number {
    return this.all().reduce((n, r) => n + r.clients.size, 0);
  }

  /**
   * Sessions whose clock has stopped because a timer callback threw.
   *
   * On `/healthz` because the fault is silent by construction: the process
   * stays up, the sockets stay open, the state is still served, and the only
   * symptom is a round that does not advance — which looks, from outside,
   * exactly like a host who has not pressed the button yet. A count here is
   * what turns "somebody eventually notices" into something a check can see.
   */
  stalledCount(): number {
    return this.all().filter((r) => r.faulted).length;
  }
}

/**
 * What a new session scores **when it does not say**.
 *
 * Only a default now. An event sets its own list in `session.json`, staging
 * sends it to `POST /api/sessions` and `src/activities/import.ts` validates
 * it — see docs/event-config.md. What is left here is what a session created
 * without that key gets: every session made before the key existed, and every
 * event happy with trivia and the arcade.
 *
 * The tabletop exercise used to be in this list as a `manual` activity, a
 * column for the host to type results into because it is judged off-platform.
 * It came out on 24 Sep 2026: the exercise is run and judged by somebody else,
 * and a leaderboard column that only fills in if the host remembers to ask for
 * the numbers and type them is a column that is usually empty and always
 * slightly wrong. Making that change meant editing this file to change one
 * event's scoring, which is the thing `activities` exists to stop. `manual`
 * remains a supported kind and its machinery is untouched, so an event that
 * wants an off-platform activity scored adds one back in its own file.
 */
export const DEFAULT_ACTIVITIES: readonly Activity[] = [
  { id: "trivia", title: "Trivia", kind: "trivia" },
  { id: "arcade", title: "Hashi Arcade", kind: "arcade" },
];
