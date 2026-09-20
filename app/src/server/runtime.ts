/**
 * The live session: the thin driver around the pure reducer.
 *
 * The engine decides *what* happens; this decides who hears about it. It holds
 * the sockets, applies effects, and projects a view per role. It contains no
 * game rules — if a rule appears here it is in the wrong file.
 */

import type { WebSocket } from "ws";
import { reduce } from "../engine/reducer.ts";
import type {
  Activity,
  Audience,
  Effect,
  Event,
  ParticipantId,
  SessionState,
} from "../engine/types.ts";
import type {
  RefusedReason,
  RenderState,
  Role,
  ServerMessage,
} from "../protocol.ts";
import {
  arcadeStateOf,
  renderStateFor,
  rosterOf,
  triviaStateOf,
} from "./views.ts";
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
  const correction =
    rttMs === null ? 0 : Math.min(rttMs / 2, MAX_LATENCY_CORRECTION_MS);
  return Math.max(0, receivedAt - opensAt - correction);
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
 * When a tap happened, in server time, for the engine to judge against the
 * light.
 *
 * `lockedSince` is `lightChangedAt` while the light is APPLY, and null while
 * it is PLAN. The grace is one-directional on purpose: a tap inside the
 * window is pulled back to the last instant of the PLAN that preceded the
 * lock, and nothing is ever pushed the other way. Subtracting 250 ms
 * unconditionally would be the bug this shape exists to avoid — a legitimate
 * tap at the start of a PLAN would slide back across the boundary into the
 * APPLY before it and drain someone for tapping on green.
 *
 * `lightChangedAt - 1` is always inside the preceding PLAN, because a light
 * lasts at least {@link LIGHT_MIN_MS}.
 */
export function correctedTapAt(
  receivedAt: number,
  rttMs: number | null,
  lockedSince: number | null,
): number {
  const correction =
    rttMs === null ? 0 : Math.min(rttMs / 2, MAX_LATENCY_CORRECTION_MS);
  const at = receivedAt - correction;
  if (lockedSince === null) return at;
  if (at >= lockedSince && at - lockedSince < LOCK_GRACE_MS) {
    return lockedSince - 1;
  }
  return at;
}

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
  /** Where a `persist` effect goes. Writes never block {@link apply}. */
  readonly persistence: SessionPersistence;
  readonly createdAt: number;
  /** The armed `closeQuestion`, and exactly which question it is armed for. */
  #closeTimer: ReturnType<typeof setTimeout> | null = null;
  #closeTimerFor: { index: number; closesAt: number } | null = null;
  /** The arcade's three clocks. See {@link armArcadeTimers}. */
  #lightTimer: ReturnType<typeof setTimeout> | null = null;
  #lightTimerFor: { round: number; at: number } | null = null;
  #itemTimer: ReturnType<typeof setTimeout> | null = null;
  #itemTimerFor: { round: number; item: number; at: number } | null = null;
  #floorTimer: ReturnType<typeof setTimeout> | null = null;
  #floorTimerFor: { round: number; at: number } | null = null;
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

  meta(now = Date.now()): SessionMeta {
    return {
      sid: this.state.sid,
      title: this.state.title,
      joinCode: this.state.joinCode,
      phase: this.state.phase,
      seal: this.state.seal,
      hostTokenHash: this.secrets.hostTokenHash,
      screenTokenHash: this.secrets.screenTokenHash,
      createdAt: this.createdAt,
      updatedAt: now,
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
          // optimisation. A trivia answer is addressed to the one phone that
          // sent it, the console and the big screen; fanning it to everyone
          // would be thirty frames per tap, roughly eight hundred frames over
          // one question, for a count that twenty-nine of those phones are
          // not shown anyway.
          if (effect.what === "toast") {
            this.sendAll({
              t: "toast",
              seq: this.state.seq,
              kind: "spot",
              text: effect.detail ?? "",
            });
          } else {
            stateTo.push(effect.to);
            // Only a broadcast to the whole room can have moved the roster.
            if (effect.what === "state" && effect.to === "all") sendRoster = true;
          }
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
      this.persistence.snapshot(this.state, now);
      this.persistence.event({ seq, event, at: now });
      if (before.phase !== this.state.phase || before.seal !== this.state.seal) {
        // `phase` is what a restart scans on, so META has to keep up with it.
        this.persistence.meta(this.meta(now));
      }
      if (before.phase !== "closed" && this.state.phase === "closed") {
        // "Exists only while the session is joinable" — a finished session's
        // code stops resolving rather than sending someone to a dead lobby.
        this.persistence.deleteJoinCode(this.state.joinCode);
      }
      if ("pid" in event) this.persistParticipant(event.pid);
    }

    if (stateTo.length > 0) this.sendStateTo(stateTo, now);
    if (sendRoster) this.broadcastRoster(now);
    // Every transition, not just the trivia ones: the timer is a function of
    // the state, so deriving it here means there is no path — open, close,
    // reveal, next, a host closing the session out from under an open
    // question — that can leave one armed for a question that is gone.
    this.armQuestionTimer(now);
    // Same reasoning, for the arcade's clocks: they are a function of the
    // state, so deriving them at the end of every event means there is no
    // path that can leave one armed for a round that is over.
    this.armArcadeTimers(now);
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
      () => {
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
      },
      Math.max(0, want.closesAt - now),
    );
    // Never the reason the process stays up: SIGTERM has thirty seconds and
    // an unfired question timer must not spend any of them.
    timer.unref?.();
    this.#closeTimer = timer;
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
   * Three timers, for the three things the engine cannot do for itself.
   *
   * - **the light**, because the durations are random and the engine has no
   *   randomness;
   * - **the item**, because Recruitment's six items are twenty seconds each
   *   and nobody should have to press a button six times to run them;
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
  armArcadeTimers(now = Date.now()): void {
    this.#armLightTimer(now);
    this.#armItemTimer(now);
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
      () => {
        this.#lightTimer = null;
        this.#lightTimerFor = null;
        this.flipLight(Date.now(), want);
      },
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

  #armItemTimer(now: number): void {
    const arcade = arcadeStateOf(this.state);
    const play = arcade?.play;
    if (!arcade || arcade.phase !== "running" || play?.kind !== "recruitment") {
      return this.#clearItemTimer();
    }
    const want = {
      round: arcade.roundIndex,
      item: play.at,
      at: play.itemEndsAt,
    };
    if (
      this.#itemTimerFor !== null &&
      this.#itemTimerFor.round === want.round &&
      this.#itemTimerFor.item === want.item &&
      this.#itemTimerFor.at === want.at
    ) {
      return;
    }
    this.#clearItemTimer();
    this.#itemTimerFor = want;
    const last = play.at + 1 >= play.items.length;
    const timer = setTimeout(
      () => {
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
          at.play.itemEndsAt !== want.at
        ) {
          return;
        }
        // The last item does not advance to a seventh; it ends the round, and
        // the host reveals when they are ready to read the notes out.
        this.apply(last ? { type: "endRound" } : { type: "nextItem" }, now2);
      },
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

  #armFloorTimer(now: number): void {
    const arcade = arcadeStateOf(this.state);
    if (!arcade || arcade.phase !== "running" || arcade.endsAt === null) {
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
      () => {
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
      },
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
    this.#clearLightTimer();
    this.#clearItemTimer();
    this.#clearFloorTimer();
  }

  /** What the light timer is armed for, for tests and for /status. */
  get armedLightAt(): number | null {
    return this.#lightTimerFor?.at ?? null;
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
    const lockedSince =
      play?.kind === "plan_apply" && play.light === "apply"
        ? play.lightChangedAt
        : null;
    const at = correctedTapAt(receivedAt, medianRtt(client.rtt), lockedSince);
    return this.apply({ type: "tap", pid: client.pid, at }, receivedAt);
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
    if (index !== trivia.at) {
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

  broadcastState(now: number): void {
    for (const c of this.clients) this.sendState(c, now);
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
    for (const c of this.clients) {
      if (audiences.some((to) => SessionRuntime.addressed(to, c))) {
        this.sendState(c, now);
      }
    }
  }

  /** `except` is the client that has just been sent a full state already. */
  broadcastRoster(now: number, except?: Client): void {
    const roster = rosterOf(this.state, this.lastSeenMap(), now);
    for (const c of this.clients) {
      if (c === except) continue;
      // The host's counts live in hostExtras, which a roster frame does not
      // carry — sending them a delta would leave the console's headcount
      // stale. They get the whole thing; there is one of them.
      if (c.role === "host") this.sendState(c, now);
      else this.send(c, { t: "roster", seq: 0, roster });
    }
  }

  refuse(socket: WebSocket, reason: RefusedReason, message: string): void {
    try {
      socket.send(JSON.stringify({ t: "refused", reason, message }));
      socket.close(1008, reason);
    } catch {
      /* already gone */
    }
  }

  /** Participants whose socket has gone quiet are marked away, not removed. */
  sweep(now: number): void {
    this.broadcastRoster(now);
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

  add(state: SessionState, now = Date.now()): CreatedSession {
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
    this.bySid.set(state.sid, runtime);
    // No case folding: the code is base62 and case is significant.
    this.byCode.set(state.joinCode, state.sid);

    // META first: it carries the token hashes, and a session that came back
    // with its scores and no way for the host to sign in would be worse than
    // one that did not come back at all. Then a snapshot, so a crash between
    // creation and the first event still recovers something coherent.
    runtime.persistence.meta(runtime.meta(now));
    runtime.persistence.snapshot(state, now);
    runtime.persistence.joinCode(state.joinCode, state.sid);
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
    for (const p of loaded.participants) {
      runtime.restoreRejoinTokens(p.pid, p.rejoinTokenHashes);
    }
    for (const e of loaded.events) {
      runtime.log.push({ seq: e.seq, event: e.event, at: e.at });
    }
    this.bySid.set(state.sid, runtime);
    this.byCode.set(state.joinCode, state.sid);
    // A restart mid-question: re-arm from the recovered state before anyone
    // reconnects, so a deadline that passed during the gap closes on the first
    // tick rather than leaving a question open forever with nobody to close it.
    runtime.armQuestionTimer();
    // And the arcade's, for the same reason: a round that was running when
    // the process went away comes back with its light turning and its Floor
    // still due to close.
    runtime.armArcadeTimers();
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
}

export const DEFAULT_ACTIVITIES: readonly Activity[] = [
  { id: "ttx", title: "Agentic Security TTX", kind: "manual", spotCap: 2 },
  { id: "trivia", title: "Trivia", kind: "trivia", spotCap: 2 },
  { id: "arcade", title: "Hashi Arcade", kind: "arcade", spotCap: 2 },
];
