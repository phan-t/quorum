/**
 * The game engine: `reduce(state, event, now) -> {state, effects}`.
 *
 * Pure. No I/O, no clock, no randomness — `now` and any generated id arrive on
 * the event. That is what makes a session replayable from its event log, and
 * what lets the rules be tested with a fake clock.
 *
 * A rejected event returns the state unchanged plus a `reject` effect. The
 * caller decides what to do with it; the engine never throws for a rule
 * violation.
 */

import type {
  Activity,
  ActivityId,
  ArcadePlay,
  ArcadeStanding,
  ArcadeState,
  Audience,
  Effect,
  Event,
  GlassWave,
  LoungeSeat,
  Participant,
  ParticipantId,
  RawScore,
  ReduceResult,
  RejectCode,
  SendoffState,
  SessionState,
  TriviaAnswer,
  TriviaState,
} from "./types.ts";
import { spotsRemaining } from "./scoring.ts";
import {
  assignPlayerNumbers,
  beatMsFor,
  checkpointBank,
  checkpointsFor,
  closeGlassStep,
  closePull,
  closeRound,
  finishBonus,
  GGANBU_MAX_WAGER,
  GGANBU_MIN_WAGER,
  GLASS_FAR_SIDE,
  glassRemainingMs,
  glassStepBank,
  isScrambleOf,
  lateSide,
  lockInForceAt,
  matchesItem,
  PLAN_APPLY_CROSS,
  RECRUITMENT_CORRECT,
  RECRUITMENT_FIRST_BONUS,
  RECRUITMENT_FIRST_PLACES,
  gganbuPairs,
  resolveBeat,
  rosterOrder,
  settleGganbuPrompt,
  tinFor,
  settleRound,
  splitBoard,
  splitPrompts,
  splitTins,
  tinIndexFor,
  tokensOf,
  tugRemainingMs,
  tugSides,
  unsealAnswerFor,
  unsealFloorPoints,
  unsealLetters,
  waveCutsFor,
  waveOf,
} from "./arcade.ts";
import type { GganbuPlay, GlassPlay, TugPlay, UnsealPlay } from "./arcade.ts";
import { clampMs, currentQuestion, idleQuestion, isCorrect,
  partitionTiebreakers, settleQuestion,
  triviaHasBegun,
} from "./trivia.ts";
import { DEFAULT_TIEBREAKERS } from "./tiebreak.ts";

/**
 * Fold a nickname for collision detection.
 *
 * NFKD-normalise, drop combining marks, lowercase, then keep letters and
 * digits **from any script**. The earlier version kept only `[a-z0-9]`, which
 * folded every non-Latin name to the empty string — so a colleague typing
 * their name in Japanese, Hindi or Chinese was told to pick a different one.
 * For an APJ team that is not an edge case.
 *
 * Dropping marks rather than deleting the character also fixes the accent
 * handling, which was backwards: "José" folded to "jos" (so it did *not*
 * collide with "Jose") while "Zoë" folded to "zo" (so it *did* collide with
 * "Zo"). Now "José" and "Jose" collide, and "Zoë" and "Zo" do not.
 *
 * Punctuation and whitespace are still folded away, so "Ann-Marie" collides
 * with "Annmarie" and "A M A R A" with "Amara". That is stronger than SPEC.md
 * describes, and deliberate: near-identical names in a live game are a
 * scorekeeping problem, not a feature.
 */
/**
 * Strip control characters and collapse interior whitespace.
 *
 * ARCHITECTURE.md requires this at the edge. A tab or a newline in a nickname
 * breaks every aligned surface — the console roster, the big screen, the CSV
 * export — and a bidi override can reorder text around it on someone else's
 * screen. The display string is sanitised, not just the collision key.
 */
export function sanitiseNickname(raw: string): string {
  return raw
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function nicknameKey(nickname: string): string {
  return nickname
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** Shortest usable nickname, in code points. See SPEC.md "Identity". */
export const MIN_NICKNAME_LENGTH = 2;

/**
 * Longest usable nickname, in code points. ARCHITECTURE.md caps these at 24.
 * Enforced here rather than in the client: the client can be bypassed, and
 * every surface would otherwise need its own truncation.
 */
export const MAX_NICKNAME_LENGTH = 24;

export interface NewSessionInput {
  readonly sid: string;
  readonly title: string;
  readonly subtitle?: string | null;
  readonly joinCode: string;
  readonly activities: readonly Activity[];
  readonly tiebreakOrder?: readonly ActivityId[];
}

export function newSession(input: NewSessionInput): SessionState {
  return {
    sid: input.sid,
    title: input.title,
    subtitle: input.subtitle ?? null,
    joinCode: input.joinCode,
    phase: "draft",
    segment: "lobby",
    seal: "live",
    practice: false,
    sendoff: null,
    activities: input.activities,
    tiebreakOrder: input.tiebreakOrder ?? input.activities.map((a) => a.id),
    participants: {},
    scores: Object.fromEntries(input.activities.map((a) => [a.id, {}])),
    spots: [],
    holding: null,
    trivia: null,
    arcade: null,
    joinsLocked: false,
    seq: 0,
    nextPlayerNumber: 1,
  };
}

function reject(to: Audience, code: RejectCode, message: string): Effect[] {
  return [{ kind: "reject", to, code, message }];
}

const BROADCAST_STATE: Effect = { kind: "broadcast", to: "all", what: "state" };
const PERSIST: Effect = { kind: "persist", what: "snapshot" };

/** Standings changed: everyone needs them, and the console always does. */
const BROADCAST_STANDINGS: Effect[] = [
  { kind: "broadcast", to: "all", what: "standings" },
  { kind: "broadcast", to: "host", what: "standings" },
];

/**
 * Write an activity's own totals into the session's per-activity scores.
 *
 * An activity's total *is* its raw score, stored exactly as `setScore` stores
 * a typed one — `{ raw, status: "played" }` — so the Phase 2 scoreboard
 * normalises it with no special case for where the number came from. That is
 * also why nothing here touches the normalisation: SCORING.md's one rule
 * applies to trivia, and to the arcade, because both hand it an ordinary raw.
 *
 * Shared by trivia and the arcade deliberately. The bench rule below is the
 * same statement about a person in both, and two copies of it would be one
 * copy away from disagreeing.
 */
/**
 * One step through the send-off, forward or back, or `null` at either end.
 *
 * Forward and back are the same list read in two directions, so they are one
 * function: an `opening → kudos → closing → done` written twice is two things
 * to keep in step, and the one that gets forgotten is always the reverse.
 *
 * Stepping back out of `done` lands on the last thing there was, not on
 * `closing` unconditionally — a send-off with no closing photos and no closing
 * line would otherwise put an empty screen in front of the room when the host
 * corrects an overshoot.
 */
function stepSendoff(
  so: SendoffState,
  dir: 1 | -1,
  now: number,
): SendoffState | null {
  const kudos = so.content.kudos.length;
  const hasOpening = so.content.opening.photos.length > 0;
  const hasClosing =
    so.content.closing.photos.length > 0 || (so.content.closing.line ?? "") !== "";

  const at = (phase: SendoffState["phase"], index: number): SendoffState => ({
    ...so,
    phase,
    at: index,
    // Stamped on the way in and cleared on the way out, so a Desktop that
    // reloads mid-montage knows how far through it is rather than restarting
    // it in front of everyone.
    openingStartedAt: phase === "opening" ? now : null,
  });

  if (dir === 1) {
    if (so.phase === "opening") return kudos > 0 ? at("kudos", 0) : hasClosing ? at("closing", 0) : at("done", 0);
    if (so.phase === "kudos") {
      if (so.at + 1 < kudos) return at("kudos", so.at + 1);
      return hasClosing ? at("closing", 0) : at("done", 0);
    }
    if (so.phase === "closing") return at("done", 0);
    return null;
  }

  if (so.phase === "done") {
    if (hasClosing) return at("closing", 0);
    if (kudos > 0) return at("kudos", kudos - 1);
    return hasOpening ? at("opening", 0) : null;
  }
  if (so.phase === "closing") {
    if (kudos > 0) return at("kudos", kudos - 1);
    return hasOpening ? at("opening", 0) : null;
  }
  if (so.phase === "kudos") {
    if (so.at > 0) return at("kudos", so.at - 1);
    return hasOpening ? at("opening", 0) : null;
  }
  return null;
}

function withActivityTotals(
  state: SessionState,
  activityId: ActivityId,
  totals: Readonly<Record<ParticipantId, number>>,
): SessionState["scores"] {
  // Practice: the round happened, the round's own totals stand, and the board
  // does not move. Gated here rather than at the two call sites because here
  // is the only way an activity's totals become a score, and a third activity
  // added later gets the behaviour without anyone remembering to ask for it.
  if (state.practice) return state.scores;
  const bucket: Record<ParticipantId, RawScore> = {
    ...(state.scores[activityId] ?? {}),
  };
  for (const [pid, raw] of Object.entries(totals)) {
    const prev = bucket[pid];
    // Bench credit is a statement about a person, not a score. A facilitator
    // who plays along from the bench must not be scored back onto the board —
    // `setScore` refuses the same thing for the same reason.
    if (prev?.status === "bench") continue;
    if (prev?.status === "played" && prev.raw === raw) continue;
    bucket[pid] = { raw, status: "played" };
  }
  return { ...state.scores, [activityId]: bucket };
}

/**
 * Somebody left the room. If a Gganbu round is running, the pair they were
 * half of dissolves and **both** halves play the house.
 *
 * SPEC.md: "a rival who disconnects is replaced by the house". Written when
 * the disconnection happens rather than worked out at the buzzer, for two
 * reasons. The engine has no clock, so at settlement it could only ask "are
 * they connected *now*", which turns a phone that blinked at the wrong second
 * into a different scoreline. And the substitution is something the survivor's
 * screen has to show *during* the round — their rival's name goes and the
 * Front-End Man's takes its place — so it has to be state, not a derivation at
 * the end.
 *
 * **Both halves**, rather than only the one left behind, because the +10 is
 * awarded per player against whoever is in front of them and a one-sided
 * substitution makes the pair's two comparisons disagree. With A on twelve and
 * B on eleven, housing only B pays B (eleven beats the house's ten) *and* A
 * (twelve beats eleven); with A on eight and B on nine it pays neither. Housing
 * both leaves one rule to explain — if your gganbu leaves, you both play the
 * house — and the house is the same ten that the odd one out has been playing
 * all round, so nothing about it is a reward for leaving.
 *
 * Worth stating plainly, because it can cut either way: a player whose rival
 * drops while holding three tokens is now chasing the house's ten, which is
 * harder than what they had. Ten is the only count that does not depend on how
 * the round had been going for somebody who is no longer in it.
 */
function houseThePairOf(
  state: SessionState,
  pid: ParticipantId,
): ArcadeState | null {
  const arcade = state.arcade;
  const play = arcade?.play;
  if (!arcade || play?.kind !== "gganbu") return arcade ?? null;
  if (arcade.phase !== "card" && arcade.phase !== "running") return arcade;
  const rival = play.rivals[pid];
  if (rival === undefined) return arcade;
  if (play.housed[rival] && play.housed[pid]) return arcade;
  return {
    ...arcade,
    play: {
      ...play,
      housed: { ...play.housed, [rival]: true, [pid]: true },
    },
  };
}

export function reduce(
  state: SessionState,
  event: Event,
  now: number,
): ReduceResult {
  const bump = (next: Omit<SessionState, "seq">): SessionState =>
    ({ ...next, seq: state.seq + 1 }) as SessionState;
  const unchanged = (effects: readonly Effect[] = []): ReduceResult => ({
    state,
    effects,
    applied: false,
  });
  const applied = (
    next: Omit<SessionState, "seq">,
    effects: readonly Effect[],
  ): ReduceResult => ({ state: bump(next), effects, applied: true });

  // A closed session is frozen. Only connection churn still lands — people
  // close laptops after the winner is announced, and that is not a rule change.
  //
  // The two exits are exempt, and they are the reason this guard is no longer
  // a one-way door. `close` was irreversible: an accidental one cost the
  // scores, the join code and thirty rejoins, because every route back went
  // through an event this branch refuses. `reopen` carries on with everything
  // intact; `restartSession` goes back to a clean lobby. Both are host-only,
  // both are deliberate, and a closed session is exactly where a host most
  // needs one of them.
  if (
    state.phase === "closed" &&
    event.type !== "disconnect" &&
    event.type !== "reconnect" &&
    event.type !== "close" && // closing twice is idempotent, not an error
    event.type !== "reopen" &&
    event.type !== "restartSession"
  ) {
    return unchanged(
      reject("host", "session_closed", "The session is closed."),
    );
  }

  switch (event.type) {
    /* ---------------- participants ---------------- */

    case "join": {
      // Look the participant up first: a rejoin is not a new join and must
      // survive a locked lobby. A *kicked* participant rejoining is a new
      // join though — SPEC.md: they "can rejoin under a different nickname
      // unless the lobby is locked".
      const existing = state.participants[event.pid];

      if (state.phase === "draft" || state.phase === "closed") {
        return unchanged(
          reject({ pid: event.pid }, "not_joinable", "The session is not open."),
        );
      }
      if (state.joinsLocked && (!existing || existing.kicked)) {
        return unchanged(
          reject(
            { pid: event.pid },
            "joins_locked",
            "The host has locked joining.",
          ),
        );
      }

      const nickname = sanitiseNickname(event.nickname);
      const key = nicknameKey(nickname);
      if (key === "") {
        return unchanged(
          reject({ pid: event.pid }, "invalid_nickname", "Pick a nickname."),
        );
      }
      const glyphs = [...nickname].length;
      if (glyphs < MIN_NICKNAME_LENGTH) {
        return unchanged(
          reject(
            { pid: event.pid },
            "invalid_nickname",
            `Nicknames need at least ${MIN_NICKNAME_LENGTH} characters.`,
          ),
        );
      }
      if (glyphs > MAX_NICKNAME_LENGTH) {
        return unchanged(
          reject(
            { pid: event.pid },
            "invalid_nickname",
            `Nicknames are at most ${MAX_NICKNAME_LENGTH} characters.`,
          ),
        );
      }

      // Kicked: they may come back, but not under the name they were kicked
      // for. SPEC.md — "can rejoin under a different nickname".
      if (existing?.kicked && existing.nicknameKey === key) {
        return unchanged(
          reject(
            { pid: event.pid },
            "kicked",
            "Pick a different nickname to rejoin.",
          ),
        );
      }

      // A kicked name is freed for other people. Burning it forever would
      // punish a real colleague who happens to share it, and it does not stop
      // the person who was kicked: without their rejoin token they are
      // indistinguishable from a new arrival. Nickname-only identity cannot
      // tell those two apart, and pretending otherwise would be theatre. The
      // host's actual tool for a determined troll is locking the lobby.
      const clash = Object.values(state.participants).find(
        (p) => p.nicknameKey === key && p.pid !== event.pid && !p.kicked,
      );
      if (clash) {
        return unchanged(
          reject(
            { pid: event.pid },
            "nickname_taken",
            `${nickname} is already here. Pick another, or ask the host to release it.`,
          ),
        );
      }

      // A rejoin keeps the participant's stored nickname. Renaming is
      // host-only, and a phone reconnecting with whatever is in its text box
      // would otherwise be a rename anyone could perform on themselves —
      // including undoing a rename the host just made.
      const participant: Participant = existing
        ? {
            ...existing,
            ...(existing.kicked ? { nickname, nicknameKey: key } : {}),
            connected: true,
            kicked: false,
          }
        : {
            pid: event.pid,
            nickname,
            nicknameKey: key,
            playerNumber: state.nextPlayerNumber,
            joinedAt: now,
            connected: true,
            kicked: false,
          };

      return applied(
        {
          ...state,
          participants: { ...state.participants, [event.pid]: participant },
          nextPlayerNumber: existing
            ? state.nextPlayerNumber
            : state.nextPlayerNumber + 1,
        },
        [BROADCAST_STATE, ...BROADCAST_STANDINGS, PERSIST],
      );
    }

    case "disconnect":
    case "reconnect": {
      const p = state.participants[event.pid];
      if (!p) return unchanged();
      // A kicked participant does not come back by reconnecting; they rejoin
      // under a new nickname, which is the whole point of the kick.
      if (p.kicked) return unchanged();
      const connected = event.type === "reconnect";
      if (p.connected === connected) return unchanged();
      // "A rival who disconnects is replaced by the house." Recorded at the
      // instant it happens, because the engine has no clock and could not
      // otherwise say *when* a rival stopped being one; and kept if they come
      // back, because their gganbu has spent two prompts playing a house.
      const arcade = connected ? state.arcade : houseThePairOf(state, event.pid);
      const housed = arcade !== state.arcade;
      const rival =
        housed && state.arcade?.play?.kind === "gganbu"
          ? state.arcade.play.rivals[event.pid]
          : undefined;
      return applied(
        { ...state, participants: { ...state.participants, [event.pid]: { ...p, connected } }, arcade },
        // A connection blip is not news to anyone but the host — but a pair
        // dissolving is not a blip. It changes who two people are playing and
        // what their +10 is measured against, so when it happens the two of
        // them are told and it is **written down**: the runtime persists only
        // when the engine asks, and it deliberately never persists a bare
        // connection change ("who is connected is not durable"). Without this
        // a restart would quietly un-house the pair.
        housed
          ? [
              { kind: "broadcast", to: "host", what: "state" },
              { kind: "broadcast", to: { pid: event.pid }, what: "state" },
              ...(rival === undefined
                ? []
                : [
                    {
                      kind: "broadcast",
                      to: { pid: rival },
                      what: "state",
                    } as const,
                  ]),
              PERSIST,
            ]
          : [{ kind: "broadcast", to: "host", what: "state" }],
      );
    }

    case "kick": {
      const p = state.participants[event.pid];
      if (!p || p.kicked) return unchanged();
      return applied(
        {
          ...state,
          participants: {
            ...state.participants,
            [event.pid]: { ...p, kicked: true, connected: false },
          },
          // Kicked is gone for good, which is a disconnection that does not
          // come back. Their gganbu plays the house from here, and so would
          // they if they were still here.
          arcade: houseThePairOf(state, event.pid),
        },
        [BROADCAST_STATE, ...BROADCAST_STANDINGS, PERSIST],
      );
    }

    case "releaseNickname": {
      const p = state.participants[event.pid];
      if (!p || p.nicknameKey === "") return unchanged();
      return applied(
        {
          ...state,
          participants: {
            ...state.participants,
            [event.pid]: { ...p, nicknameKey: "", connected: false },
          },
          // Releasing a nickname takes somebody out of the roster, which is
          // leaving the room by another door. Their gganbu plays the house for
          // the same reason a kick's does.
          arcade: houseThePairOf(state, event.pid),
        },
        [{ kind: "broadcast", to: "host", what: "state" }, PERSIST],
      );
    }

    /* ---------------- lifecycle ---------------- */

    case "open": {
      if (state.phase !== "draft") {
        return unchanged(
          reject("host", "wrong_phase", "The session is already open."),
        );
      }
      return applied({ ...state, phase: "lobby", segment: "lobby" }, [
        BROADCAST_STATE,
        PERSIST,
      ]);
    }

    case "start": {
      if (state.phase !== "lobby") {
        return unchanged(
          reject(
            "host",
            "wrong_phase",
            state.phase === "running"
              ? "The session is already running."
              : "Open the session before starting it.",
          ),
        );
      }
      return applied({ ...state, phase: "running" }, [
        BROADCAST_STATE,
        PERSIST,
      ]);
    }

    case "close": {
      // Closing an unopened session is meaningless; closing a lobby that never
      // started is a real thing a host does when an event is abandoned.
      if (state.phase === "closed") return unchanged();
      if (state.phase === "draft") {
        return unchanged(
          reject("host", "wrong_phase", "The session was never opened."),
        );
      }
      return applied(
        {
          ...state,
          phase: "closed",
          segment: "final",
          seal: "revealed",
          joinsLocked: true,
        },
        [BROADCAST_STATE, ...BROADCAST_STANDINGS, PERSIST],
      );
    }

    /**
     * Undo a close. See the note on the `reopen` event in types.ts.
     *
     * `running` rather than `lobby`, because a close is something that happens
     * to a session that was running and the host's next press should be the
     * one they were about to make. `lobby` would additionally disable every
     * segment button on the console, which is a second thing to undo.
     */
    case "reopen": {
      if (state.phase !== "closed") {
        return unchanged(
          reject(
            "host",
            "wrong_phase",
            state.phase === "draft"
              ? "The session was never opened."
              : "The session is not closed.",
          ),
        );
      }
      return applied({ ...state, phase: "running", joinsLocked: false }, [
        BROADCAST_STATE,
        ...BROADCAST_STANDINGS,
        PERSIST,
      ]);
    }

    /**
     * Back to a clean lobby, keeping the room and the content. See the note on
     * the `restartSession` event in types.ts for what survives and what does
     * not, and why it is one event rather than a sequence of them.
     *
     * Three things here are worth their own sentence.
     *
     * **`arcade: null`, not a rewound arcade.** SPEC.md's promise is that
     * "every participant gets a three-digit number … and keeps it for the
     * whole arcade", and a restart *ends* that arcade: there is no arcade
     * afterwards until the host enters one again, and `enterArcade` hands the
     * numbers out at that point exactly as it did the first time. Keeping the
     * register alive across a restart would mean keeping a non-null `arcade`
     * with no round in it, and `renderStateFor` projects a non-null arcade as
     * "the room is in the arcade" — so a phone sitting in a fresh lobby would
     * be handed an arcade view with a player number and a Floor. That is the
     * half-cleared state this event exists not to produce. In practice the
     * numbers do not even move: `assignPlayerNumbers` walks `rosterOrder`,
     * which sorts on join order, so the same roster is dealt the same numbers
     * second time round. What changes is that somebody who joined *after* the
     * first `enterArcade` — and was therefore appended at the end — takes
     * their place in join order instead. That is the honest answer for a room
     * that is starting again.
     *
     * **The scores are rebuilt from a union.** Every activity in the list, and
     * every key `scores` happens to hold, so there is no bucket left behind
     * for an activity the list no longer mentions — a log-only recovery builds
     * a state with an empty activity list, and a restart there must still
     * leave nothing scored.
     *
     * **`nextPlayerNumber` is kept.** It is the join-order counter, and
     * participants are kept, so re-using a number would hand two people the
     * same one. A restart clears what a session *did*, never who was in it.
     */
    case "restartSession": {
      if (state.phase === "draft") {
        return unchanged(
          reject(
            "host",
            "wrong_phase",
            "The session was never opened, so there is nothing to clear.",
          ),
        );
      }
      const activityIds = new Set([
        ...state.activities.map((a) => a.id),
        ...Object.keys(state.scores),
      ]);
      return applied(
        {
          ...state,
          phase: "lobby",
          segment: "lobby",
          seal: "live",
          // A restart is the room starting again, and leaving practice on
          // through one would be a silent reason the next game scored nothing.
          practice: false,
          // The content stays loaded; where the room got to does not. Same
          // reasoning as the trivia questions: re-uploading is not the point
          // of a restart, and making the host do it would be a surprise.
          sendoff:
            state.sendoff === null
              ? null
              : {
                  ...state.sendoff,
                  phase: state.sendoff.content.opening.photos.length > 0 ? "opening" : "kudos",
                  at: 0,
                  openingStartedAt: null,
                },
          // Participants, nicknames, join-order numbers and kick decisions all
          // survive untouched. A kick is a decision about a person, not a
          // score, and un-kicking somebody as a side effect of wiping the
          // board would be a surprise the host did not ask for.
          scores: Object.fromEntries([...activityIds].map((id) => [id, {}])),
          spots: [],
          holding: null,
          trivia:
            state.trivia === null
              ? null
              : {
                  // The questions and the sudden-death pool stay exactly as
                  // loaded — that is the whole reason not to make the host
                  // re-upload — and everything the set *did* goes.
                  activityId: state.trivia.activityId,
                  questions: state.trivia.questions,
                  tiebreakers: state.trivia.tiebreakers,
                  at: 0,
                  phase: "idle",
                  opensAt: null,
                  closesAt: null,
                  tiebreakAt: 0,
                  tiebreakUsed: 0,
                  tiebreakHeld: null,
                  suddenDeath: false,
                  suddenDeathWinner: null,
                  answers: {},
                  totals: {},
                  streaks: {},
                },
          arcade: null,
          joinsLocked: false,
        },
        [BROADCAST_STATE, ...BROADCAST_STANDINGS, PERSIST],
      );
    }

    case "setPractice": {
      // Read when totals are banked, not when they are earned, so flipping it
      // mid-round would decide retrospectively whether what the room just did
      // counted. Refuse, and say which thing is in the way.
      if (
        state.trivia &&
        state.trivia.phase !== "idle" &&
        state.trivia.phase !== "revealed"
      ) {
        return unchanged(
          reject(
            "host",
            "wrong_question_phase",
            "A question is open. Reveal it before changing practice.",
          ),
        );
      }
      // The round card is the exception, and it is where the decision is
      // actually made: the host is reading the how-to-play out to a room that
      // has never seen this game, which is the moment "let us practise this
      // one" occurs to them. Nothing has been played yet — `startRound` only
      // puts the card up, `beginPlay` is what starts the clock, and
      // `revealRound` is the single place an arcade round reaches the board —
      // so there are no totals for the flag to rule on after the fact.
      // `running` stays refused because by then there are: the room is
      // mid-round, and flipping it there decides retrospectively whether what
      // they just did counted.
      if (state.arcade && state.arcade.phase === "running") {
        return unchanged(
          reject(
            "host",
            "wrong_round_phase",
            "A round is in play. Finish it before changing practice.",
          ),
        );
      }
      if (state.practice === event.on) return unchanged();
      return applied({ ...state, practice: event.on }, [
        BROADCAST_STATE,
        ...BROADCAST_STANDINGS,
        PERSIST,
      ]);
    }

    /**
     * The send-off's content. Same rule as a question set: replace it freely
     * until it has been in front of the room, refuse afterwards. A montage
     * that changes halfway through is a montage nobody can follow, and a
     * message list that changes after three have been read is a list whose
     * numbering no longer matches what the room heard.
     */
    case "loadSendoff": {
      if (event.content.kudos.length === 0 && event.content.opening.photos.length === 0) {
        return unchanged(
          reject("host", "no_questions_loaded", "That send-off has no messages and no photos."),
        );
      }
      if (state.sendoff !== null && state.sendoff.phase !== "opening") {
        return unchanged(
          reject("host", "wrong_phase", "The send-off has started. Restart the session to change it."),
        );
      }
      return applied(
        {
          ...state,
          sendoff: {
            content: event.content,
            phase: event.content.opening.photos.length > 0 ? "opening" : "kudos",
            at: 0,
            openingStartedAt: null,
          },
        },
        [BROADCAST_STATE, PERSIST],
      );
    }

    /**
     * One step on. The whole segment is this and its reverse, because the host
     * drives it with the same space bar as everything else and the only two
     * things they can mean are "next" and "I went too fast".
     */
    case "sendoffNext": {
      const so = state.sendoff;
      if (!so) {
        return unchanged(reject("host", "wrong_phase", "No send-off is loaded."));
      }
      const next = stepSendoff(so, 1, now);
      if (next === null) return unchanged();
      return applied({ ...state, sendoff: next }, [BROADCAST_STATE, PERSIST]);
    }

    case "sendoffBack": {
      const so = state.sendoff;
      if (!so) {
        return unchanged(reject("host", "wrong_phase", "No send-off is loaded."));
      }
      const next = stepSendoff(so, -1, now);
      if (next === null) return unchanged();
      return applied({ ...state, sendoff: next }, [BROADCAST_STATE, PERSIST]);
    }

    case "setSegment": {
      if (state.segment === event.segment) return unchanged();
      return applied({ ...state, segment: event.segment }, [
        BROADCAST_STATE,
        PERSIST,
      ]);
    }

    case "setSeal": {
      if (state.seal === event.seal) return unchanged();
      // Sealing changes what every surface may show, so standings go with it.
      return applied({ ...state, seal: event.seal }, [
        BROADCAST_STATE,
        ...BROADCAST_STANDINGS,
        PERSIST,
      ]);
    }

    case "setHolding": {
      const a = state.holding;
      const b = event.holding;
      const same =
        a === b ||
        (a !== null &&
          b !== null &&
          a.title === b.title &&
          a.line === b.line);
      if (same) return unchanged();
      return applied({ ...state, holding: b }, [BROADCAST_STATE, PERSIST]);
    }

    case "setJoinsLocked": {
      if (state.joinsLocked === event.locked) return unchanged();
      return applied({ ...state, joinsLocked: event.locked }, [
        { kind: "broadcast", to: "host", what: "state" },
        PERSIST,
      ]);
    }

    /* ---------------- scoring ---------------- */

    case "setScore": {
      const activity = state.activities.find((a) => a.id === event.activityId);
      if (!activity) {
        return unchanged(
          reject("host", "unknown_activity", `No activity ${event.activityId}.`),
        );
      }
      const p = state.participants[event.pid];
      if (!p || p.kicked) {
        return unchanged(
          reject("host", "unknown_participant", `No participant ${event.pid}.`),
        );
      }
      // NaN and Infinity poison every downstream comparison: the sort
      // comparator returns NaN and the ranking order becomes undefined.
      if (!Number.isFinite(event.raw) || event.raw < 0) {
        return unchanged(
          reject(
            "host",
            "invalid_score",
            "A raw score must be a finite number, zero or above.",
          ),
        );
      }

      const prev = state.scores[event.activityId]?.[event.pid];
      // Scoring someone who is on bench credit is refused rather than stored:
      // storing it would let the raw reappear if they were ever un-benched.
      if (prev?.status === "bench") {
        return unchanged(
          reject(
            "host",
            "bench_cannot_be_scored",
            `${p.nickname} is on bench credit for ${activity.title}.`,
          ),
        );
      }

      const next: RawScore = { raw: event.raw, status: "played" };
      if (prev && prev.raw === next.raw && prev.status === next.status) {
        return unchanged();
      }
      return applied(
        {
          ...state,
          scores: {
            ...state.scores,
            [event.activityId]: {
              ...(state.scores[event.activityId] ?? {}),
              [event.pid]: next,
            },
          },
        },
        [...BROADCAST_STANDINGS, PERSIST],
      );
    }

    case "setStatus": {
      const activity = state.activities.find((a) => a.id === event.activityId);
      if (!activity) {
        return unchanged(
          reject("host", "unknown_activity", `No activity ${event.activityId}.`),
        );
      }
      const p = state.participants[event.pid];
      if (!p || p.kicked) {
        return unchanged(
          reject("host", "unknown_participant", `No participant ${event.pid}.`),
        );
      }
      const prev = state.scores[event.activityId]?.[event.pid];
      if ((prev?.status ?? "unset") === event.status) return unchanged();

      // Benching discards the raw score: it is no longer meaningful, and
      // leaving it would let it reappear if the status flipped back.
      const next: RawScore = {
        raw: event.status === "played" ? (prev?.raw ?? 0) : 0,
        status: event.status,
      };
      return applied(
        {
          ...state,
          scores: {
            ...state.scores,
            [event.activityId]: {
              ...(state.scores[event.activityId] ?? {}),
              [event.pid]: next,
            },
          },
        },
        [...BROADCAST_STANDINGS, PERSIST],
      );
    }

    case "grantSpot": {
      const activity = state.activities.find((a) => a.id === event.activityId);
      if (!activity) {
        return unchanged(
          reject("host", "unknown_activity", `No activity ${event.activityId}.`),
        );
      }
      const p = state.participants[event.pid];
      if (!p || p.kicked) {
        return unchanged(
          reject("host", "unknown_participant", `No participant ${event.pid}.`),
        );
      }
      if (event.reason.trim() === "") {
        return unchanged(
          reject(
            "host",
            "reason_required",
            "A Spot Award needs a reason — it gets read out.",
          ),
        );
      }
      if (state.scores[event.activityId]?.[event.pid]?.status === "bench") {
        return unchanged(
          reject(
            "host",
            "bench_cannot_receive_spot",
            "They are on bench credit for this activity.",
          ),
        );
      }
      if (spotsRemaining(state, activity) <= 0) {
        return unchanged(
          reject(
            "host",
            "spot_cap_reached",
            `No Spot Awards left for ${activity.title}.`,
          ),
        );
      }
      return applied(
        {
          ...state,
          spots: [
            ...state.spots,
            {
              seq: state.seq + 1,
              pid: event.pid,
              activityId: event.activityId,
              reason: event.reason.trim(),
              at: now,
            },
          ],
        },
        [
          ...BROADCAST_STANDINGS,
          {
            kind: "broadcast",
            to: "all",
            what: "toast",
            detail: event.reason.trim(),
          },
          PERSIST,
        ],
      );
    }

    case "revokeSpot": {
      if (!state.spots.some((sp) => sp.seq === event.seq)) return unchanged();
      return applied(
        { ...state, spots: state.spots.filter((sp) => sp.seq !== event.seq) },
        [...BROADCAST_STANDINGS, PERSIST],
      );
    }

    /* ---------------- trivia ---------------- */

    case "loadTrivia": {
      const activity = state.activities.find((a) => a.id === event.activityId);
      if (!activity) {
        return unchanged(
          reject("host", "unknown_activity", `No activity ${event.activityId}.`),
        );
      }
      // An empty set is not a set. Accepting it would leave the host with a
      // trivia activity that can never open a question and no error to read.
      if (event.questions.length === 0) {
        return unchanged(
          reject("host", "no_questions_loaded", "That file has no questions."),
        );
      }
      // Replace freely until the first question opens, refuse afterwards.
      //
      // SPEC.md says "editing a loaded set means re-uploading" and
      // ARCHITECTURE.md's REST table says the endpoint "validates and replaces
      // the set", so a flat refusal is wrong: the overwhelmingly likely reason
      // to load twice is that the first CSV was the wrong file, noticed in the
      // dry run. But once a question has been opened, a swap silently rewrites
      // the meaning of every total already banked — the raws survive, the
      // questions that produced them do not — so at that point a new session
      // is the only honest answer.
      if (state.trivia && triviaHasBegun(state.trivia)) {
        return unchanged(
          reject(
            "host",
            "trivia_already_started",
            "A question has already been asked. Re-uploading now would not match the scores already banked.",
          ),
        );
      }
      // The tiebreakers come out of the set here, once, so that from this
      // point "the questions" means the scored questions everywhere.
      const split = partitionTiebreakers(
        event.questions,
        event.tiebreakers,
        DEFAULT_TIEBREAKERS,
      );
      // A file of nothing but tiebreakers is a file with no game in it. The
      // same reasoning as an empty set, and a likelier mistake: it is one
      // stray column of Ys.
      if (split.scored.length === 0) {
        return unchanged(
          reject(
            "host",
            "no_questions_loaded",
            "Every question in that file is flagged as a tiebreaker.",
          ),
        );
      }
      return applied(
        {
          ...state,
          trivia: {
            activityId: event.activityId,
            questions: split.scored,
            tiebreakers: split.tiebreakers,
            tiebreakAt: 0,
            tiebreakUsed: 0,
            tiebreakHeld: null,
            at: 0,
            phase: "idle",
            opensAt: null,
            closesAt: null,
            suddenDeath: false,
            suddenDeathWinner: null,
            answers: {},
            totals: {},
            streaks: {},
          },
        },
        [BROADCAST_STATE, PERSIST],
      );
    }

    case "openQuestion": {
      const trivia = state.trivia;
      if (!trivia) {
        return unchanged(
          reject("host", "no_questions_loaded", "Load a question set first."),
        );
      }
      if (state.phase !== "running") {
        return unchanged(
          reject("host", "wrong_phase", "Start the session first."),
        );
      }
      // A sudden death may be opened over a question that has been revealed as
      // well as over an idle one, and that is the point of the fix: a tie is
      // settled *after* the last question, when the phase is `revealed` and
      // `nextQuestion` has nothing left to advance to. It is still refused
      // over an open question — two live questions is two live questions —
      // and over a closed one, which would skip a reveal the room is waiting
      // for.
      const openable =
        trivia.phase === "idle" ||
        (event.suddenDeath && trivia.phase === "revealed");
      if (!openable) {
        return unchanged(
          reject(
            "host",
            "wrong_question_phase",
            trivia.phase === "closed"
              ? "Reveal this question before settling a tie."
              : "This question is already in play.",
          ),
        );
      }
      // Sudden death draws on the pool, and spends what it draws: a question
      // the room has heard cannot be asked again to settle a second tie.
      const tiebreakAt = event.suddenDeath ? trivia.tiebreakUsed : trivia.tiebreakAt;
      const question = event.suddenDeath
        ? trivia.tiebreakers[tiebreakAt]
        : trivia.questions[trivia.at];
      if (!question) {
        return unchanged(
          event.suddenDeath
            ? reject(
                "host",
                "no_tiebreak_question",
                "There are no tiebreak questions left.",
              )
            : reject("host", "no_more_questions", "That was the last question."),
        );
      }
      return applied(
        {
          ...state,
          trivia: {
            ...trivia,
            phase: "open",
            opensAt: now,
            // Sudden death has no timer: it ends when someone is right, not
            // when a clock runs out, so there is no instant to count down to.
            closesAt: event.suddenDeath
              ? null
              : now + question.timeLimitSec * 1000,
            suddenDeath: event.suddenDeath,
            suddenDeathWinner: null,
            tiebreakAt,
            tiebreakUsed: event.suddenDeath
              ? tiebreakAt + 1
              : trivia.tiebreakUsed,
            // `at` is deliberately untouched by a sudden death. The scored set
            // stays exactly where the host left it, which is what makes a
            // tiebreak runnable at any point — including between two scored
            // questions, and including after the last of them.
            //
            // Where it was *in* that question is put aside here and handed
            // back by `nextQuestion`. Without it a tiebreak run straight off a
            // reveal would leave the set `idle` on a question already written
            // to `scores`, which the host could then open and score a second
            // time. A second tiebreak in a row keeps the first one's hold: the
            // thing to come back to is the scored question, not the tiebreak
            // that has just been asked.
            tiebreakHeld: event.suddenDeath
              ? (trivia.suddenDeath
                  ? trivia.tiebreakHeld
                  : { at: trivia.at, phase: trivia.phase, answers: trivia.answers })
              : null,
            // While the tiebreak runs, the scored set has no question in play,
            // and `at` says so by pointing past the end of it. See the note on
            // TriviaState.at: this is what keeps a projection that has not
            // learned about tiebreakers yet from putting an un-asked scored
            // question on thirty phones and reading its answer out.
            ...(event.suddenDeath ? { at: trivia.questions.length } : {}),
            answers: {},
          },
        },
        [BROADCAST_STATE, PERSIST],
      );
    }

    case "answerQuestion": {
      const trivia = state.trivia;
      // The question in play, which during a sudden death is the tiebreaker
      // and not `questions[at]`. Judging an answer against the wrong question
      // is the bug this indirection exists to make impossible.
      const question = trivia ? currentQuestion(trivia) : undefined;
      if (!trivia || !question || trivia.phase !== "open") {
        return unchanged(
          reject(
            { pid: event.pid },
            "question_not_open",
            "That question is closed.",
          ),
        );
      }
      const p = state.participants[event.pid];
      if (!p || p.kicked) {
        return unchanged(
          reject(
            { pid: event.pid },
            "unknown_participant",
            `No participant ${event.pid}.`,
          ),
        );
      }
      // One tap, final. SPEC.md is unambiguous, and the refusal is what stops
      // a double-tap on a laggy phone from being read as a change of mind.
      if (trivia.answers[event.pid]) {
        return unchanged(
          reject(
            { pid: event.pid },
            "already_answered",
            "You are locked in.",
          ),
        );
      }
      if (
        !Number.isInteger(event.choice) ||
        event.choice < 0 ||
        event.choice >= question.answers.length
      ) {
        return unchanged(
          reject({ pid: event.pid }, "invalid_choice", "No such answer."),
        );
      }

      const correct = isCorrect(question, event.choice);
      const answer: TriviaAnswer = {
        choice: event.choice,
        correct,
        // Sudden death has no limit to clamp against — the whole point is that
        // it runs until someone is right — so only the floor applies there.
        ms: clampMs(
          event.ms,
          trivia.suddenDeath ? Infinity : question.timeLimitSec * 1000,
        ),
        // Points are settled at close, not here: see settleQuestion() for why
        // a participant's own state must carry no correctness signal yet.
        points: 0,
        streakBonus: 0,
      };

      return applied(
        {
          ...state,
          trivia: {
            ...trivia,
            answers: { ...trivia.answers, [event.pid]: answer },
            // First correct answer wins, and only the first: a later correct
            // tap does not overwrite the winner.
            suddenDeathWinner:
              trivia.suddenDeath && correct && trivia.suddenDeathWinner === null
                ? event.pid
                : trivia.suddenDeathWinner,
          },
        },
        // Not `to: "all"`. The answer count belongs on the host console and
        // the big screen; the only participant who learns anything is the one
        // who just tapped, and what they learn is "locked in".
        [
          { kind: "broadcast", to: { pid: event.pid }, what: "state" },
          { kind: "broadcast", to: "host", what: "state" },
          { kind: "broadcast", to: "screen", what: "state" },
          // Persist: the runtime only writes the event log when the engine
          // asks it to, so an unpersisted answer is an answer that a restart
          // mid-question loses.
          PERSIST,
        ],
      );
    }

    case "closeQuestion": {
      const trivia = state.trivia;
      if (!trivia) {
        return unchanged(
          reject("host", "no_questions_loaded", "Load a question set first."),
        );
      }
      if (trivia.phase !== "open") {
        return unchanged(
          reject("host", "wrong_question_phase", "No question is open."),
        );
      }
      const settled = settleQuestion(trivia);
      const next: TriviaState = {
        ...trivia,
        phase: "closed",
        // types.ts: these are null unless the question is open. A closed
        // question has no instant left to count down to, and a sudden death
        // never had one — leaving a stale `closesAt` on either is how a phone
        // ends up rendering a countdown to a moment in the past.
        opensAt: null,
        closesAt: null,
        answers: settled.answers,
        totals: settled.totals,
        streaks: settled.streaks,
      };
      // The settled points live on `trivia` and go no further yet.
      //
      // Writing them into `scores` here is what an earlier version did, and it
      // leaked the answer: the participant's own points strip is projected from
      // `scores`, so at the close — before the reveal — a right answer made the
      // strip jump and a wrong one left it flat. No field said "correct" and
      // the phone turned green anyway, which is precisely what SPEC forbids,
      // because the person sitting next to you can read a number as easily as
      // a colour. The scores land at `revealQuestion`, when the answer is
      // public regardless.
      return applied({ ...state, trivia: next }, [BROADCAST_STATE, PERSIST]);
    }

    case "revealQuestion": {
      const trivia = state.trivia;
      if (!trivia) {
        return unchanged(
          reject("host", "no_questions_loaded", "Load a question set first."),
        );
      }
      // Reveal follows close, never replaces it. Revealing an open question
      // would put the answer on the big screen while people are still tapping.
      if (trivia.phase !== "closed") {
        return unchanged(
          reject(
            "host",
            "wrong_question_phase",
            trivia.phase === "open"
              ? "Close the question before revealing it."
              : "There is nothing to reveal.",
          ),
        );
      }
      const revealed: TriviaState = { ...trivia, phase: "revealed" };
      // Sudden death changes no points at all, so it moves no standings.
      return applied(
        {
          ...state,
          trivia: revealed,
          // Deferred from `closeQuestion` on purpose — see the note there.
          ...(trivia.suddenDeath
            ? {}
            : {
                scores: withActivityTotals(
                  state,
                  revealed.activityId,
                  revealed.totals,
                ),
              }),
        },
        [
          BROADCAST_STATE,
          // The reveal ends with the activity's top five, which is standings.
          ...BROADCAST_STANDINGS,
          PERSIST,
        ],
      );
    }

    case "nextQuestion": {
      const trivia = state.trivia;
      if (!trivia) {
        return unchanged(
          reject("host", "no_questions_loaded", "Load a question set first."),
        );
      }
      // Advancing past an open question would drop answers already given and
      // score nobody. Everything else is allowed — advancing from `idle` is
      // how a host skips a question they do not want to ask, which the ⚠️
      // VERIFY discipline in the question bank makes a real need.
      if (trivia.phase === "open") {
        return unchanged(
          reject(
            "host",
            "wrong_question_phase",
            "Close the question before moving on.",
          ),
        );
      }
      // Clearing a sudden death is not advancing the set. The tiebreak was
      // never one of the twenty — `at` did not move when it opened — so it
      // must not move when it is put away, or a tie settled between questions
      // three and four would quietly cost the room question four. It also
      // means this is the way out of a tiebreak run after the last question,
      // where advancing would have nothing to advance to.
      if (trivia.suddenDeath) {
        const held = trivia.tiebreakHeld;
        return applied(
          {
            ...state,
            trivia: {
              ...idleQuestion(trivia, held?.at ?? trivia.at),
              // Back exactly where the tiebreak found it: the same phase, and
              // the same answers for the big screen's distribution. A question
              // that had been revealed comes back `revealed`, which is what
              // stops it being opened — and scored — a second time.
              phase: held?.phase ?? "idle",
              answers: held?.answers ?? {},
              tiebreakHeld: null,
            },
          },
          [BROADCAST_STATE, PERSIST],
        );
      }
      const at = trivia.at + 1;
      if (at >= trivia.questions.length) {
        return unchanged(
          reject("host", "no_more_questions", "That was the last question."),
        );
      }
      // idleQuestion() clears the per-question answers. Totals and streaks
      // are the set's running state and survive.
      return applied({ ...state, trivia: idleQuestion(trivia, at) }, [
        BROADCAST_STATE,
        PERSIST,
      ]);
    }

    /* ---------------- arcade ---------------- */

    case "enterArcade": {
      const activity = state.activities.find((a) => a.id === event.activityId);
      if (!activity) {
        return unchanged(
          reject("host", "unknown_activity", `No activity ${event.activityId}.`),
        );
      }
      if (state.phase !== "running") {
        return unchanged(
          reject("host", "wrong_phase", "Start the session first."),
        );
      }
      const arcade = state.arcade;
      if (arcade && arcade.activityId !== event.activityId) {
        return unchanged(
          reject(
            "host",
            "wrong_phase",
            `The arcade is already running for ${arcade.activityId}.`,
          ),
        );
      }
      const playerNumbers = assignPlayerNumbers(
        state,
        arcade?.playerNumbers ?? {},
      );
      // Re-entering is not an error: it is how the host hands a number to
      // somebody who joined after the arcade started. Numbers already handed
      // out never move — see assignPlayerNumbers().
      if (arcade) {
        if (
          Object.keys(playerNumbers).length ===
          Object.keys(arcade.playerNumbers).length
        ) {
          return unchanged();
        }
        return applied({ ...state, arcade: { ...arcade, playerNumbers } }, [
          BROADCAST_STATE,
          PERSIST,
        ]);
      }
      return applied(
        {
          ...state,
          arcade: {
            activityId: event.activityId,
            playerNumbers,
            round: null,
            roundIndex: 0,
            phase: "idle",
            standing: {},
            lounge: {},
            banked: {},
            totals: {},
            startedAt: null,
            endsAt: null,
            play: null,
          },
        },
        [BROADCAST_STATE, PERSIST],
      );
    }

    case "startRound": {
      const arcade = state.arcade;
      if (!arcade) {
        return unchanged(
          reject("host", "not_in_arcade", "Enter the arcade first."),
        );
      }
      if (state.phase !== "running") {
        return unchanged(
          reject("host", "wrong_phase", "Start the session first."),
        );
      }
      if (arcade.phase === "card" || arcade.phase === "running") {
        return unchanged(
          reject("host", "wrong_round_phase", "A round is already in play."),
        );
      }
      // All six rounds are built, and the config union carries all six, so a
      // mismatch can only mean the host sent the wrong configuration for the
      // round they named. `round_not_built` survives in the wire's vocabulary
      // and is no longer reachable from here.
      if (event.config.kind !== event.round) {
        return unchanged(
          reject(
            "host",
            "invalid_round_config",
            `That configuration is for ${event.config.kind}, not ${event.round}.`,
          ),
        );
      }
      const config = event.config;
      if (config.kind === "recruitment") {
        // An empty round can never be played and gives the host no error to
        // read: the same reasoning as an empty trivia set.
        if (config.items.length === 0) {
          return unchanged(
            reject("host", "wrong_phase", "That round has no items."),
          );
        }
        if (!Number.isFinite(config.secondsPerItem) || config.secondsPerItem <= 0) {
          return unchanged(
            reject("host", "wrong_phase", "Each item needs a timer above zero."),
          );
        }
      } else if (config.kind === "plan_apply") {
        // A target of zero would have everybody across the line on their first
        // tap, before the light had ever turned.
        if (!Number.isInteger(config.target) || config.target <= 0) {
          return unchanged(
            reject("host", "wrong_phase", "The resource target must be a whole number above zero."),
          );
        }
        if (!Number.isFinite(config.seconds) || config.seconds <= 0) {
          return unchanged(
            reject("host", "wrong_phase", "The round needs a length above zero."),
          );
        }
      } else if (config.kind === "unseal") {
        if (config.items.length === 0) {
          return unchanged(
            reject("host", "invalid_round_config", "That round has no tins."),
          );
        }
        // A cue that is not a scramble of its own answer is a tin that cannot
        // be opened: the letters to tap are not on the tiles. The content is
        // hand-written, so it is checked once here rather than discovered by
        // the one person who picked the umbrella.
        const badTin = config.items.findIndex(
          (i) =>
            unsealLetters(i.answer).length === 0 ||
            !isScrambleOf(i.cue, i.answer),
        );
        if (badTin !== -1) {
          return unchanged(
            reject(
              "host",
              "invalid_round_config",
              `Tin ${badTin + 1}'s scramble is not the letters of its word.`,
            ),
          );
        }
        if (!Number.isFinite(config.seconds) || config.seconds <= 0) {
          return unchanged(
            reject(
              "host",
              "invalid_round_config",
              "The round needs a length above zero.",
            ),
          );
        }
      } else if (config.kind === "tug_of_raft") {
        if (!Number.isInteger(config.pulls) || config.pulls <= 0) {
          return unchanged(
            reject(
              "host",
              "invalid_round_config",
              "There has to be at least one pull.",
            ),
          );
        }
        if (!Number.isFinite(config.pullSeconds) || config.pullSeconds <= 0) {
          return unchanged(
            reject(
              "host",
              "invalid_round_config",
              "A pull needs a length above zero.",
            ),
          );
        }
        // A heartbeat of zero has no beats to be on, and a negative one runs
        // backwards. Either divides the whole round by nonsense.
        if (!Number.isFinite(config.bpm) || config.bpm <= 0) {
          return unchanged(
            reject(
              "host",
              "invalid_round_config",
              "The heartbeat needs a tempo above zero.",
            ),
          );
        }
        if (!Number.isFinite(config.seed)) {
          return unchanged(
            reject("host", "invalid_round_config", "That seed is not a number."),
          );
        }
      } else if (config.kind === "gganbu") {
        if (config.prompts.length === 0) {
          return unchanged(
            reject("host", "invalid_round_config", "That round has no prompts."),
          );
        }
        if (
          !Number.isFinite(config.secondsPerPrompt) ||
          config.secondsPerPrompt <= 0
        ) {
          return unchanged(
            reject(
              "host",
              "invalid_round_config",
              "Each prompt needs a timer above zero.",
            ),
          );
        }
        // Nobody can wager out of an empty hand, and a round that starts every
        // player on zero would revoke the room before the first prompt.
        if (
          !Number.isInteger(config.startTokens) ||
          config.startTokens < GGANBU_MIN_WAGER
        ) {
          return unchanged(
            reject(
              "host",
              "invalid_round_config",
              "Everyone has to start with at least one token.",
            ),
          );
        }
        if (!Number.isFinite(config.seed)) {
          return unchanged(
            reject("host", "invalid_round_config", "That seed is not a number."),
          );
        }
      } else {
        // A bridge with no steps is a far side you are standing on.
        if (config.steps.length === 0) {
          return unchanged(
            reject("host", "invalid_round_config", "That bridge has no steps."),
          );
        }
        // Two panes and a `real` that points at one of them. A step that says
        // `real: 2` would drain the whole wave for answering correctly, and
        // the content is hand-written, so it is checked once here rather than
        // discovered at 14:40 in front of the room.
        const badStep = config.steps.findIndex(
          (s) =>
            s.panes.length !== 2 ||
            (s.real !== 0 && s.real !== 1) ||
            s.panes.some((p) => p.label.trim() === ""),
        );
        if (badStep !== -1) {
          return unchanged(
            reject(
              "host",
              "invalid_round_config",
              `Step ${badStep + 1} needs two labelled panes and a real pane of 0 or 1.`,
            ),
          );
        }
        if (
          config.waveSeconds.length !== 3 ||
          config.waveSeconds.some((s) => !Number.isFinite(s) || s <= 0)
        ) {
          return unchanged(
            reject(
              "host",
              "invalid_round_config",
              "Each of the three waves needs a step timer above zero.",
            ),
          );
        }
      }

      // Every round starts with everyone back on the Floor. SPEC.md is
      // emphatic: cumulative elimination would spend the last five minutes
      // with three people playing and thirty watching.
      const standing: Record<ParticipantId, ArcadeStanding> = {};
      for (const p of rosterOrder(state)) standing[p.pid] = "floor";

      const playerNumbers = assignPlayerNumbers(state, arcade.playerNumbers);

      let play: ArcadePlay;
      if (config.kind === "recruitment") {
        play = {
          kind: "recruitment",
          items: config.items,
          at: 0,
          secondsPerItem: config.secondsPerItem,
          // The clocks start at `beginPlay`, not here: the round card is
          // up for twenty seconds and nobody is playing against it.
          itemEndsAt: 0,
          solvedOrder: [],
          answered: {},
        };
      } else if (config.kind === "plan_apply") {
        play = {
          kind: "plan_apply",
          light: "plan",
          lightChangedAt: 0,
          nextChangeAt: 0,
          applySince: null,
          resources: {},
          target: config.target,
          seconds: config.seconds,
          finishOrder: [],
        };
      } else if (config.kind === "unseal") {
        // The word is separated from the letters once, here, and never put
        // back together outside `revealRound`. See splitTins().
        const { tins, key } = splitTins(config.items);
        play = {
          kind: "unseal",
          tins,
          key,
          seconds: config.seconds,
          // Nobody holds a tin yet. The shape picker runs against the round
          // card — "choose a shape, you will be given a sealed tin" — and the
          // tin does not open until `beginPlay`.
          pick: {},
          progress: {},
          docs: {},
          unsealedMs: {},
          unsealOrder: [],
        };
      } else if (config.kind === "tug_of_raft") {
        play = {
          kind: "tug_of_raft",
          pulls: config.pulls,
          pullSeconds: config.pullSeconds,
          beatMs: beatMsFor(config.bpm),
          pull: 0,
          seed: config.seed,
          // Dealt from the roster that is in the room now, so the big screen
          // can put the two sides on the round card. Anyone who arrives after
          // this gets a side on their first tap — see `tapBeat`.
          sides: tugSides(
            rosterOrder(state).map((p) => p.pid),
            config.seed,
          ),
          // The heartbeat starts at `beginPlay`, not here.
          pullStartedAt: 0,
          pullEndsAt: 0,
          onBeats: {},
          lastBeat: {},
          creditedAt: {},
          wins: [0, 0],
        };
      } else if (config.kind === "gganbu") {
        const { board, key } = splitPrompts(config.prompts);
        const roster = rosterOrder(state);
        const tokens: Record<ParticipantId, number> = {};
        for (const p of roster) tokens[p.pid] = config.startTokens;
        // "A rival who disconnects is replaced by the house" — including one
        // who was already gone when the pairs were drawn. Somebody whose phone
        // died in the break is not a rival, they are a frozen token count, and
        // the house is the kinder and the more honest of the two.
        //
        // A pair with an absent half dissolves for **both** of them, exactly
        // as it does when somebody drops mid-round. See houseThePairOf().
        const rivals = gganbuPairs(
          roster.map((p) => p.pid),
          config.seed,
        );
        const housed: Record<ParticipantId, true> = {};
        for (const p of roster) {
          const rival = rivals[p.pid];
          if (rival === undefined) continue;
          if (
            state.participants[rival]?.connected !== true ||
            p.connected !== true
          ) {
            housed[p.pid] = true;
            housed[rival] = true;
          }
        }
        play = {
          kind: "gganbu",
          board,
          key,
          at: 0,
          secondsPerPrompt: config.secondsPerPrompt,
          promptEndsAt: 0,
          startTokens: config.startTokens,
          tokens,
          rivals,
          housed,
          wagers: {},
        };
      } else {
        // The answer is separated from the labels once, here, and never put
        // back together outside `revealRound`. See splitBoard().
        const { board, key } = splitBoard(config.steps);
        play = {
          kind: "glass_bridge",
          board,
          key,
          waveSeconds: config.waveSeconds,
          // Fixed now, from the roster that is in the room now, so that the
          // waves the big screen announces on the round card are the waves
          // that cross. Someone joining during the round is above both cuts
          // and is therefore in wave 3, without anything being recomputed.
          waveCuts: waveCutsFor(Object.values(playerNumbers)),
          wave: 1,
          step: 0,
          // Clocks of its own, all starting at `beginPlay`. Borrowing the
          // round's `endsAt` for the step would make every step the length of
          // the round; borrowing it for the wave would make every wave so.
          waveStartedAt: 0,
          stepStartedAt: 0,
          stepEndsAt: 0,
          broken: config.steps.map(() => null),
          stepped: {},
          position: {},
          elapsedMs: {},
          crossOrder: [],
        };
      }

      return applied(
        {
          ...state,
          arcade: {
            ...arcade,
            playerNumbers,
            round: event.round,
            roundIndex: arcade.round === null ? 0 : arcade.roundIndex + 1,
            phase: "card",
            standing,
            lounge: {},
            // Last round's banked points have already been folded into the
            // totals by `endRound`; this round starts everyone at nothing.
            banked: {},
            startedAt: null,
            endsAt: null,
            play,
          },
        },
        [BROADCAST_STATE, PERSIST],
      );
    }

    case "beginPlay": {
      const arcade = state.arcade;
      if (!arcade) {
        return unchanged(
          reject("host", "not_in_arcade", "Enter the arcade first."),
        );
      }
      const play = arcade.play;
      if (arcade.phase !== "card" || !play) {
        return unchanged(
          reject("host", "wrong_round_phase", "No round card is up."),
        );
      }
      let started: ArcadePlay;
      let endsAt: number;
      if (play.kind === "recruitment") {
        started = { ...play, itemEndsAt: now + play.secondsPerItem * 1000 };
        endsAt = now + play.items.length * play.secondsPerItem * 1000;
      } else if (play.kind === "plan_apply") {
        // The first light is PLAN and the boundary schedules the turn:
        // durations are random 2–6 s and the engine has no randomness.
        started = { ...play, light: "plan", lightChangedAt: now, nextChangeAt: now };
        endsAt = now + play.seconds * 1000;
      } else if (play.kind === "unseal") {
        // The tins open. Whoever picked a shape against the round card is
        // holding one; whoever did not may still pick, and has lost the
        // seconds it takes them.
        started = play;
        endsAt = now + play.seconds * 1000;
      } else if (play.kind === "tug_of_raft") {
        // The heartbeat starts here, and beat 0 is this instant: every beat
        // index in the round is counted from it.
        const pullEndsAt = now + play.pullSeconds * 1000;
        started = { ...play, pull: 0, pullStartedAt: now, pullEndsAt };
        endsAt = pullEndsAt + tugRemainingMs(play, 0);
      } else if (play.kind === "gganbu") {
        const promptEndsAt = now + play.secondsPerPrompt * 1000;
        started = { ...play, at: 0, promptEndsAt };
        endsAt = now + play.board.length * play.secondsPerPrompt * 1000;
      } else {
        // Wave 1 walks onto the bridge blind, with the longest step it will
        // ever get.
        const stepEndsAt = now + play.waveSeconds[0] * 1000;
        started = {
          ...play,
          wave: 1,
          step: 0,
          waveStartedAt: now,
          stepStartedAt: now,
          stepEndsAt,
        };
        endsAt = stepEndsAt + glassRemainingMs(play, 1, 0);
      }
      return applied(
        {
          ...state,
          arcade: {
            ...arcade,
            phase: "running",
            startedAt: now,
            endsAt,
            play: started,
          },
        },
        [BROADCAST_STATE, PERSIST],
      );
    }

    case "submitAnswer": {
      const arcade = state.arcade;
      if (!arcade) {
        return unchanged(
          reject({ pid: event.pid }, "not_in_arcade", "The arcade is not open."),
        );
      }
      const play = arcade.play;
      if (arcade.phase !== "running" || play?.kind !== "recruitment") {
        return unchanged(
          reject(
            { pid: event.pid },
            "wrong_round_phase",
            "There is nothing to answer.",
          ),
        );
      }
      const p = state.participants[event.pid];
      if (!p || p.kicked) {
        return unchanged(
          reject(
            { pid: event.pid },
            "unknown_participant",
            `No participant ${event.pid}.`,
          ),
        );
      }
      // Absent means "joined after the round started", and such a person is
      // put on the Floor by playing: `startRound` fixed the standings before
      // they arrived, so without this they were refused a tap for being in the
      // Lounge *and* refused a bet for being on the Floor — two contradictory
      // sentences on one phone, and nothing they could do about either.
      // Joining late costs them the seconds they missed and nothing else.
      if (arcade.standing[event.pid] === "drained") {
        return unchanged(
          reject(
            { pid: event.pid },
            "not_on_the_floor",
            "You are not on the Floor for this round.",
          ),
        );
      }
      // One answer per item. A typed answer is not a change of mind: the item
      // is twenty seconds long and a second guess would be a second chance
      // nobody else gets.
      if (event.pid in play.answered) {
        return unchanged(
          reject({ pid: event.pid }, "already_answered_item", "You are locked in."),
        );
      }
      const item = play.items[play.at];
      if (!item) {
        return unchanged(
          reject({ pid: event.pid }, "wrong_round_phase", "No item is open."),
        );
      }

      // "Every correct answer *within the timer*". The boundary closes the
      // item on its own clock, so a submission past `itemEndsAt` is a race,
      // not a normal case — and it scores nothing, because the alternative is
      // a timer that only applies to people whose network is fast.
      const correct = now <= play.itemEndsAt && matchesItem(item, event.answer);
      // The first three correct *in the room*, per item: 10 + 5, six times
      // over, is the Floor max of 90.
      const points = correct
        ? RECRUITMENT_CORRECT +
          (play.solvedOrder.length < RECRUITMENT_FIRST_PLACES
            ? RECRUITMENT_FIRST_BONUS
            : 0)
        : 0;

      return applied(
        {
          ...state,
          arcade: {
            ...arcade,
            banked:
              points > 0
                ? {
                    ...arcade.banked,
                    [event.pid]: (arcade.banked[event.pid] ?? 0) + points,
                  }
                : arcade.banked,
            play: {
              ...play,
              answered: { ...play.answered, [event.pid]: correct },
              solvedOrder: correct
                ? [...play.solvedOrder, event.pid]
                : play.solvedOrder,
            },
          },
        },
        // Not `to: "all"`. Who has solved it is on the big screen and the
        // console; the only participant who learns anything is the one who
        // just typed, and what they learn about is their own answer.
        [
          { kind: "broadcast", to: { pid: event.pid }, what: "state" },
          { kind: "broadcast", to: "host", what: "state" },
          { kind: "broadcast", to: "screen", what: "state" },
          PERSIST,
        ],
      );
    }

    case "nextItem": {
      const arcade = state.arcade;
      if (!arcade) {
        return unchanged(
          reject("host", "not_in_arcade", "Enter the arcade first."),
        );
      }
      const play = arcade.play;
      if (arcade.phase !== "running" || play?.kind !== "recruitment") {
        return unchanged(
          reject("host", "wrong_round_phase", "No item round is running."),
        );
      }
      const at = play.at + 1;
      if (at >= play.items.length) {
        return unchanged(
          reject(
            "host",
            "wrong_round_phase",
            "That was the last item. End the round.",
          ),
        );
      }
      const itemEndsAt = now + play.secondsPerItem * 1000;
      return applied(
        {
          ...state,
          arcade: {
            ...arcade,
            // The round ends when the *last item* does, so the Floor's clock
            // is re-derived from the item that is actually open. `beginPlay`
            // could only guess at `begin + items × 20 s`, and every item
            // starts a little after its predecessor's deadline — the timer
            // that opens it has event-loop lag — so the guess drifts earlier
            // than the truth by the accumulated lag. Left alone, that is the
            // last item losing the tail of its twenty seconds.
            endsAt:
              itemEndsAt +
              (play.items.length - 1 - at) * play.secondsPerItem * 1000,
            play: {
              ...play,
              at,
              itemEndsAt,
              // Both are per item: the next item's first three are a fresh
              // three, and everybody may answer again.
              solvedOrder: [],
              answered: {},
            },
          },
        },
        [BROADCAST_STATE, PERSIST],
      );
    }

    case "setLight": {
      const arcade = state.arcade;
      if (!arcade) {
        return unchanged(
          reject("host", "not_in_arcade", "Enter the arcade first."),
        );
      }
      const play = arcade.play;
      if (arcade.phase !== "running" || play?.kind !== "plan_apply") {
        return unchanged(
          reject("host", "wrong_round_phase", "No light round is running."),
        );
      }
      if (play.light === event.light && play.nextChangeAt === event.until) {
        return unchanged();
      }
      return applied(
        {
          ...state,
          arcade: {
            ...arcade,
            play: {
              ...play,
              light: event.light,
              // Re-scheduling the same light must not move the instant taps
              // are judged against, or a player could be drained for a tap
              // that was comfortably inside the PLAN they were looking at.
              lightChangedAt:
                play.light === event.light ? play.lightChangedAt : now,
              // The lock's own start, kept across the turn back to PLAN so a
              // tap that was made during it can still be judged against it.
              // Going back to green does not erase the window that just
              // closed: it closes it at `lightChangedAt`.
              applySince:
                event.light === "apply" && play.light !== "apply"
                  ? now
                  : play.applySince,
              nextChangeAt: event.until,
            },
          },
        },
        [BROADCAST_STATE, PERSIST],
      );
    }

    case "tap": {
      const arcade = state.arcade;
      if (!arcade) {
        return unchanged(
          reject({ pid: event.pid }, "not_in_arcade", "The arcade is not open."),
        );
      }
      const play = arcade.play;
      if (arcade.phase !== "running" || play?.kind !== "plan_apply") {
        return unchanged(
          reject({ pid: event.pid }, "wrong_round_phase", "Nothing to tap."),
        );
      }
      const p = state.participants[event.pid];
      if (!p || p.kicked) {
        return unchanged(
          reject(
            { pid: event.pid },
            "unknown_participant",
            `No participant ${event.pid}.`,
          ),
        );
      }
      // Absent means "joined after the round started", and such a person is
      // put on the Floor by playing: `startRound` fixed the standings before
      // they arrived, so without this they were refused a tap for being in the
      // Lounge *and* refused a bet for being on the Floor — two contradictory
      // sentences on one phone, and nothing they could do about either.
      // Joining late costs them the seconds they missed and nothing else.
      if (arcade.standing[event.pid] === "drained") {
        return unchanged(
          reject(
            { pid: event.pid },
            "not_on_the_floor",
            "You are in the Lounge. Back a player.",
          ),
        );
      }
      // `at` is the corrected instant: the 250 ms grace after a lock is
      // applied at the socket boundary, exactly as a trivia response time is
      // latency-corrected there. Deriving either from `now` would put network
      // time back into the game.
      if (arcade.endsAt !== null && event.at >= arcade.endsAt) {
        return unchanged(
          reject({ pid: event.pid }, "floor_locked", "The Floor is closed."),
        );
      }
      // Already across. Their button is done; a stray tap is not a drain.
      if (play.finishOrder.includes(event.pid)) return unchanged();

      // The light *at the corrected instant*, not the light now. A tap made
      // 1.9 s into a lock over a 400 ms link lands after the flip back to
      // green, and the phone it was made on was plainly pink; judging it
      // against the current light forgives it. See {@link lockInForceAt}.
      if (lockInForceAt(play, event.at) !== null) {
        // `Error: state lock held by another process`. Drained, not out:
        // everything banked stays banked and the Lounge opens.
        return applied(
          {
            ...state,
            arcade: {
              ...arcade,
              standing: { ...arcade.standing, [event.pid]: "drained" },
              lounge: {
                ...arcade.lounge,
                [event.pid]: { backing: null, at: now },
              },
            },
          },
          [BROADCAST_STATE, PERSIST],
        );
      }

      const from = play.resources[event.pid] ?? 0;
      const to = from + 1;
      const crossed = to >= play.target;
      const gained =
        checkpointBank(from, to, checkpointsFor(play.target)) +
        (crossed ? PLAN_APPLY_CROSS + finishBonus(play.finishOrder.length) : 0);

      return applied(
        {
          ...state,
          arcade: {
            ...arcade,
            banked:
              gained > 0
                ? {
                    ...arcade.banked,
                    [event.pid]: (arcade.banked[event.pid] ?? 0) + gained,
                  }
                : arcade.banked,
            play: {
              ...play,
              resources: { ...play.resources, [event.pid]: to },
              finishOrder: crossed
                ? [...play.finishOrder, event.pid]
                : play.finishOrder,
            },
          },
        },
        // An ordinary tap emits nothing. Sixty phones at ten taps a second is
        // six hundred events a second, and a broadcast or a persist each would
        // be six hundred fan-outs or writes a second to carry a number that is
        // reconstructed to the last checkpoint anyway, which is what "banked"
        // means. The phone counts optimistically in the meantime. Milestones
        // are different — they move points, so they are worth a write.
        //
        // But a milestone is still **not** `to: "all"`, and the difference is
        // measured rather than argued: sixty bots over a 75 s Floor hit 144
        // milestones, and at `to: "all"` that was 144 × 60 = 8 640 of the
        // 11 121 state frames the phones received, plus a roster frame each
        // (see runtime.ts). Address it to the people whose surface actually
        // moves and the same round costs 2 625.
        //
        // - A **checkpoint** moves `banked` and `resources`, and the only
        //   surfaces that draw either are the tapper's own phone and the
        //   console. The big screen's projection does not contain them — see
        //   `arcadePlanApplyFor` in views.ts — so it is not sent one.
        // - A **crossing** also moves `finishOrder` and `crossed`, which the
        //   big screen *does* draw. It goes there too.
        //
        // Nobody else's frame changes on either: a phone is never told another
        // player's resources, and the dormitory grid only moves on a drain.
        //
        // (An earlier draft of this comment claimed the runtime re-broadcasts
        // the round at 10 Hz. It does not; there is no periodic broadcast
        // anywhere. The surfaces are driven entirely by these effects.)
        gained > 0
          ? [
              { kind: "broadcast", to: { pid: event.pid }, what: "state" },
              { kind: "broadcast", to: "host", what: "state" },
              ...(crossed
                ? [{ kind: "broadcast", to: "screen", what: "state" } as const]
                : []),
              PERSIST,
            ]
          : [],
      );
    }

    /* ---------------- Round 2 — Unseal ---------------- */

    case "pickShape": {
      const arcade = state.arcade;
      if (!arcade) {
        return unchanged(
          reject({ pid: event.pid }, "not_in_arcade", "The arcade is not open."),
        );
      }
      const play = arcade.play;
      // Picking is allowed against the round card *and* after the Floor
      // opens. The card is what the picker is for — "choose a shape, you will
      // be given a sealed tin" — but a player who joined late, or whose phone
      // woke up slowly, still has to be able to play, and the seconds they
      // spend picking are already the whole cost.
      if (
        play?.kind !== "unseal" ||
        (arcade.phase !== "card" && arcade.phase !== "running")
      ) {
        return unchanged(
          reject(
            { pid: event.pid },
            "wrong_round_phase",
            "There is no tin to choose.",
          ),
        );
      }
      const p = state.participants[event.pid];
      if (!p || p.kicked) {
        return unchanged(
          reject(
            { pid: event.pid },
            "unknown_participant",
            `No participant ${event.pid}.`,
          ),
        );
      }
      if (arcade.standing[event.pid] === "drained") {
        return unchanged(
          reject(
            { pid: event.pid },
            "not_on_the_floor",
            "You are in the Lounge. Back a player.",
          ),
        );
      }
      // Change your mind freely while the tin is still closed, and not once it
      // is open. The shape is a bet made before the word is known, which is
      // the round; a re-pick at second nine would be a second tin.
      if (arcade.phase === "running" && event.pid in play.pick) {
        return unchanged(
          reject(
            { pid: event.pid },
            "already_picked",
            "You are holding that tin.",
          ),
        );
      }
      const at = tinIndexFor(
        play.tins,
        event.shape,
        arcade.playerNumbers[event.pid],
      );
      if (at === -1) {
        return unchanged(
          reject(
            { pid: event.pid },
            "invalid_choice",
            "There is no tin of that shape.",
          ),
        );
      }
      if (play.pick[event.pid] === at) return unchanged();
      return applied(
        {
          ...state,
          arcade: {
            ...arcade,
            play: { ...play, pick: { ...play.pick, [event.pid]: at } },
          },
        },
        // The big screen counts the shapes — four tiles filling up is the
        // round card's whole animation — and the console shows the room. What
        // goes nowhere is *which tin*, which is why the view is a count.
        [
          { kind: "broadcast", to: { pid: event.pid }, what: "state" },
          { kind: "broadcast", to: "host", what: "state" },
          { kind: "broadcast", to: "screen", what: "state" },
          PERSIST,
        ],
      );
    }

    case "tapLetter":
    case "readDocs": {
      const arcade = state.arcade;
      if (!arcade) {
        return unchanged(
          reject({ pid: event.pid }, "not_in_arcade", "The arcade is not open."),
        );
      }
      const play = arcade.play;
      if (arcade.phase !== "running" || play?.kind !== "unseal") {
        return unchanged(
          reject(
            { pid: event.pid },
            "wrong_round_phase",
            "There is nothing to unseal.",
          ),
        );
      }
      const p = state.participants[event.pid];
      if (!p || p.kicked) {
        return unchanged(
          reject(
            { pid: event.pid },
            "unknown_participant",
            `No participant ${event.pid}.`,
          ),
        );
      }
      if (arcade.standing[event.pid] === "drained") {
        return unchanged(
          reject(
            { pid: event.pid },
            "not_on_the_floor",
            "The tin has cracked. Back a player.",
          ),
        );
      }
      if (arcade.endsAt !== null && now >= arcade.endsAt) {
        return unchanged(
          reject({ pid: event.pid }, "floor_locked", "The Floor is closed."),
        );
      }
      const tin = tinFor(play, event.pid);
      const answer = unsealAnswerFor(play, event.pid);
      if (!tin || !answer) {
        return unchanged(
          reject(
            { pid: event.pid },
            "no_shape_picked",
            "Choose a shape first.",
          ),
        );
      }
      const word = unsealLetters(answer.answer);
      const progress = play.progress[event.pid] ?? 0;
      // Already open. Their tin is done; a stray frame is not a crack, exactly
      // as a stray tap is not one in Plan / Apply.
      if (progress >= word.length) return unchanged();

      let correct: boolean;
      if (event.type === "readDocs") {
        // "It reveals the next letter and halves your score for the round."
        // The letter is *committed*, not merely shown: there is then nothing
        // per-player left to project, and the phone's solved row fills in on
        // its own. Press it again and it buys the next one too — in the show
        // the cheat works completely, and what it costs is half the round.
        correct = true;
      } else {
        const tapped = unsealLetters(event.letter)[0];
        if (tapped === undefined) {
          return unchanged(
            reject({ pid: event.pid }, "invalid_letter", "That is not a letter."),
          );
        }
        // A letter that is not on their own tiles is a malformed frame, not a
        // wrong guess, and draining somebody for a bad frame would be the game
        // punishing a phone. It leaks nothing to say so: the tiles are theirs
        // and they are looking at them.
        if (!unsealLetters(tin.cue).includes(tapped)) {
          return unchanged(
            reject(
              { pid: event.pid },
              "invalid_letter",
              "That letter is not on your tin.",
            ),
          );
        }
        correct = tapped === word[progress];
      }

      if (!correct) {
        // "The tin has cracked. Player 017 drained." Everything banked stays
        // banked: 2 a letter, up to the crack.
        const cracked: UnsealPlay = play;
        return applied(
          {
            ...state,
            arcade: {
              ...arcade,
              standing: { ...arcade.standing, [event.pid]: "drained" },
              lounge: {
                ...arcade.lounge,
                [event.pid]: arcade.lounge[event.pid] ?? {
                  backing: null,
                  at: now,
                },
              },
              banked: {
                ...arcade.banked,
                [event.pid]: unsealFloorPoints(cracked, event.pid),
              },
            },
          },
          [BROADCAST_STATE, PERSIST],
        );
      }

      const next = progress + 1;
      const open = next >= word.length;
      const nextPlay: UnsealPlay = {
        ...play,
        progress: { ...play.progress, [event.pid]: next },
        docs:
          event.type === "readDocs"
            ? { ...play.docs, [event.pid]: true }
            : play.docs,
        // Measured from the Floor opening, which is the same instant for
        // everybody. Dithering over the shape picker comes out of your own
        // time, and a player who picked late has not bought a shorter clock.
        unsealedMs: open
          ? {
              ...play.unsealedMs,
              [event.pid]: Math.max(0, now - (arcade.startedAt ?? now)),
            }
          : play.unsealedMs,
        unsealOrder: open
          ? [...play.unsealOrder, event.pid]
          : play.unsealOrder,
      };
      return applied(
        {
          ...state,
          arcade: {
            ...arcade,
            // Assigned rather than added: the Floor score for this round is a
            // function of the tin, the progress and the docs button, and
            // reading the docs at letter nine has to be able to halve what
            // letters one to eight were worth.
            banked: {
              ...arcade.banked,
              [event.pid]: unsealFloorPoints(nextPlay, event.pid),
            },
            play: nextPlay,
          },
        },
        // The tapper's own phone, the console, and the big screen — which
        // draws letter counts and the fastest board, and never a letter.
        // Reading the docs looks identical from outside, because it is one
        // more letter: "Nobody will know."
        [
          { kind: "broadcast", to: { pid: event.pid }, what: "state" },
          { kind: "broadcast", to: "host", what: "state" },
          { kind: "broadcast", to: "screen", what: "state" },
          PERSIST,
        ],
      );
    }

    /* ---------------- Round 3 — Tug of Raft ---------------- */

    case "tapBeat": {
      const arcade = state.arcade;
      if (!arcade) {
        return unchanged(
          reject({ pid: event.pid }, "not_in_arcade", "The arcade is not open."),
        );
      }
      const play = arcade.play;
      if (arcade.phase !== "running" || play?.kind !== "tug_of_raft") {
        return unchanged(
          reject({ pid: event.pid }, "wrong_round_phase", "There is no rope."),
        );
      }
      const p = state.participants[event.pid];
      if (!p || p.kicked) {
        return unchanged(
          reject(
            { pid: event.pid },
            "unknown_participant",
            `No participant ${event.pid}.`,
          ),
        );
      }
      // No drained check, and that is not an omission: nobody drains in this
      // round. SPEC.md is explicit about why — two elimination rounds
      // back-to-back is a downer, and the arcade needs one round that is pure
      // noise — so there is no Lounge here to be refused into.
      if (event.at >= play.pullEndsAt) {
        return unchanged(
          reject({ pid: event.pid }, "floor_locked", "The pull is over."),
        );
      }
      // A frame from before the heartbeat started has no beat to be on.
      if (event.at < play.pullStartedAt) return unchanged();

      // Somebody who was not in the room when the sides were dealt gets one
      // now, rather than being told to watch.
      const dealt = play.sides[event.pid];
      const sides =
        dealt === undefined
          ? { ...play.sides, [event.pid]: lateSide(play.seed, event.pid) }
          : play.sides;

      const was = play.lastBeat[event.pid] ?? -1;
      const judged = resolveBeat(play, was, event.at);
      // One credit per beat: a drum roll on one beat is one pull, or the round
      // would be the tap race the heartbeat exists to prevent.
      const credited =
        !judged.inElection && judged.onBeat && judged.beat > was;
      const last = credited ? judged.beat : judged.lastBeat;

      if (!credited && sides === play.sides && last === was) {
        // An off-beat tap, or a tap swallowed by an election. "Tap off the
        // beat and nothing happens" is the rule, and nothing happening is
        // cheaper than saying so.
        return unchanged();
      }
      return applied(
        {
          ...state,
          arcade: {
            ...arcade,
            play: {
              ...play,
              sides,
              onBeats: credited
                ? {
                    ...play.onBeats,
                    [event.pid]: (play.onBeats[event.pid] ?? 0) + 1,
                  }
                : play.onBeats,
              lastBeat: { ...play.lastBeat, [event.pid]: last },
              creditedAt: credited
                ? { ...play.creditedAt, [event.pid]: event.at }
                : play.creditedAt,
            },
          },
        },
        // **Not** `to: "all"`, and this is the one round where that needs
        // saying, because the rope is on every phone. Thirty players at 100
        // bpm is fifty credits a second, and a fan-out each would be fifteen
        // hundred frames a second to move a rope by a pixel. The big screen is
        // the rope of record and the console is the room; a phone animates its
        // own side and picks the rope up on the next frame it is sent. A
        // throttled tick for the phones belongs at the boundary, not here.
        credited
          ? [
              { kind: "broadcast", to: { pid: event.pid }, what: "state" },
              { kind: "broadcast", to: "host", what: "state" },
              { kind: "broadcast", to: "screen", what: "state" },
              PERSIST,
            ]
          : [],
      );
    }

    case "nextPull": {
      const arcade = state.arcade;
      if (!arcade) {
        return unchanged(
          reject("host", "not_in_arcade", "Enter the arcade first."),
        );
      }
      const play = arcade.play;
      if (arcade.phase !== "running" || play?.kind !== "tug_of_raft") {
        return unchanged(
          reject("host", "wrong_round_phase", "No rope round is running."),
        );
      }
      const pull = play.pull + 1;
      if (pull >= play.pulls) {
        return unchanged(
          reject(
            "host",
            "wrong_round_phase",
            "That was the last pull. End the round.",
          ),
        );
      }
      if (!Number.isFinite(event.seed)) {
        return unchanged(
          reject("host", "invalid_round_config", "That seed is not a number."),
        );
      }
      const close = closePull(play);
      const banked: Record<ParticipantId, number> = { ...arcade.banked };
      for (const [pid, gain] of Object.entries(close.gained)) {
        banked[pid] = (banked[pid] ?? 0) + gain;
      }
      const pullEndsAt = now + play.pullSeconds * 1000;
      return applied(
        {
          ...state,
          arcade: {
            ...arcade,
            banked,
            // Re-derived from the pull that is actually open, for the reason
            // `nextItem` re-derives Recruitment's: each pull starts a little
            // after its predecessor's deadline, and a round end guessed at
            // `beginPlay` drifts earlier than the truth by the accumulated
            // lag.
            endsAt: pullEndsAt + tugRemainingMs(play, pull),
            play: {
              ...play,
              pull,
              seed: event.seed,
              // Reshuffled, so nobody is stuck on a losing side.
              sides: tugSides(
                rosterOrder(state).map((rp) => rp.pid),
                event.seed,
              ),
              pullStartedAt: now,
              pullEndsAt,
              // Every one of these is per pull: a new heartbeat, a new rope,
              // and a leader who has to earn it again.
              onBeats: {},
              lastBeat: {},
              creditedAt: {},
              wins: close.wins,
            },
          },
        },
        [BROADCAST_STATE, PERSIST],
      );
    }

    /* ---------------- Round 4 — Gganbu ---------------- */

    case "wager": {
      const arcade = state.arcade;
      if (!arcade) {
        return unchanged(
          reject({ pid: event.pid }, "not_in_arcade", "The arcade is not open."),
        );
      }
      const play = arcade.play;
      if (arcade.phase !== "running" || play?.kind !== "gganbu") {
        return unchanged(
          reject(
            { pid: event.pid },
            "wrong_round_phase",
            "There is nothing to wager on.",
          ),
        );
      }
      const p = state.participants[event.pid];
      if (!p || p.kicked) {
        return unchanged(
          reject(
            { pid: event.pid },
            "unknown_participant",
            `No participant ${event.pid}.`,
          ),
        );
      }
      if (arcade.standing[event.pid] === "drained") {
        return unchanged(
          reject(
            { pid: event.pid },
            "not_on_the_floor",
            "Your token was revoked. Back a player.",
          ),
        );
      }
      if (
        now >= play.promptEndsAt ||
        (arcade.endsAt !== null && now >= arcade.endsAt)
      ) {
        return unchanged(
          reject({ pid: event.pid }, "floor_locked", "That prompt has closed."),
        );
      }
      // One wager per prompt. A second frame is not a change of mind: fifteen
      // seconds is short enough that a re-stake would be a second look at your
      // rival's face.
      if (event.pid in play.wagers) {
        return unchanged(
          reject({ pid: event.pid }, "already_answered_item", "You are locked in."),
        );
      }
      if (!play.board[play.at]) {
        return unchanged(
          reject({ pid: event.pid }, "wrong_round_phase", "No prompt is open."),
        );
      }
      if (event.pick !== "over" && event.pick !== "under") {
        return unchanged(
          reject({ pid: event.pid }, "invalid_choice", "Over, or under."),
        );
      }
      const held = tokensOf(play, event.pid);
      if (
        !Number.isInteger(event.amount) ||
        event.amount < GGANBU_MIN_WAGER ||
        event.amount > GGANBU_MAX_WAGER ||
        event.amount > held
      ) {
        return unchanged(
          reject(
            { pid: event.pid },
            "invalid_wager",
            `One to ${Math.min(GGANBU_MAX_WAGER, held)} tokens.`,
          ),
        );
      }
      return applied(
        {
          ...state,
          arcade: {
            ...arcade,
            play: {
              ...play,
              // A latecomer is dealt in by playing, at the opening stake.
              tokens:
                play.tokens[event.pid] === undefined
                  ? { ...play.tokens, [event.pid]: held }
                  : play.tokens,
              wagers: {
                ...play.wagers,
                [event.pid]: { pick: event.pick, amount: event.amount },
              },
            },
          },
        },
        // The count of who has wagered goes to the console and the big screen;
        // the contents go nowhere at all until the prompt settles, least of
        // all to the one person in the room who is betting against this
        // player. **Not** `to: "all"`: a rival learning that a wager landed is
        // the whole of what they are allowed to learn, and they learn it from
        // their own frame, not from this one.
        [
          { kind: "broadcast", to: { pid: event.pid }, what: "state" },
          { kind: "broadcast", to: "host", what: "state" },
          { kind: "broadcast", to: "screen", what: "state" },
          PERSIST,
        ],
      );
    }

    case "nextPrompt": {
      const arcade = state.arcade;
      if (!arcade) {
        return unchanged(
          reject("host", "not_in_arcade", "Enter the arcade first."),
        );
      }
      const play = arcade.play;
      if (arcade.phase !== "running" || play?.kind !== "gganbu") {
        return unchanged(
          reject("host", "wrong_round_phase", "No wager round is running."),
        );
      }
      const at = play.at + 1;
      if (at >= play.board.length) {
        return unchanged(
          reject(
            "host",
            "wrong_round_phase",
            "That was the last prompt. End the round.",
          ),
        );
      }
      // The tokens move here and nowhere else. See settleGganbuPrompt().
      const settled = settleGganbuPrompt(play);
      const standing: Record<ParticipantId, ArcadeStanding> = {
        ...arcade.standing,
      };
      const lounge: Record<ParticipantId, LoungeSeat> = { ...arcade.lounge };
      for (const pid of settled.revoked) {
        standing[pid] = "drained";
        lounge[pid] = arcade.lounge[pid] ?? { backing: null, at: now };
      }
      const promptEndsAt = now + play.secondsPerPrompt * 1000;
      const nextPlay: GganbuPlay = {
        ...play,
        at,
        promptEndsAt,
        tokens: settled.tokens,
        wagers: {},
      };
      return applied(
        {
          ...state,
          arcade: {
            ...arcade,
            standing,
            lounge,
            endsAt:
              promptEndsAt +
              (play.board.length - 1 - at) * play.secondsPerPrompt * 1000,
            play: nextPlay,
          },
        },
        // Everybody's frame moves: the token counts are public once they are
        // settled, and a revocation puts a gold seat on the dormitory grid.
        [BROADCAST_STATE, PERSIST],
      );
    }

    case "stepPane": {
      const arcade = state.arcade;
      if (!arcade) {
        return unchanged(
          reject({ pid: event.pid }, "not_in_arcade", "The arcade is not open."),
        );
      }
      const play = arcade.play;
      if (arcade.phase !== "running" || play?.kind !== "glass_bridge") {
        return unchanged(
          reject({ pid: event.pid }, "wrong_round_phase", "There is no bridge."),
        );
      }
      const p = state.participants[event.pid];
      if (!p || p.kicked) {
        return unchanged(
          reject(
            { pid: event.pid },
            "unknown_participant",
            `No participant ${event.pid}.`,
          ),
        );
      }
      if (arcade.standing[event.pid] === "drained") {
        return unchanged(
          reject(
            { pid: event.pid },
            "not_on_the_floor",
            "You are in the Lounge. Back a player.",
          ),
        );
      }
      // Waves are by player number, and a number that has not been handed out
      // yet is wave 3 — see waveOf(). Nobody steps out of turn: the whole
      // round is the asymmetry between the waves, and a wave 3 player taking
      // wave 1's step would be taking wave 1's information as well.
      const wave = waveOf(arcade.playerNumbers[event.pid], play.waveCuts);
      if (wave !== play.wave) {
        return unchanged(
          reject(
            { pid: event.pid },
            "not_your_wave",
            wave > play.wave
              ? `Wave ${wave} is not on the bridge yet. Watch.`
              : `Wave ${wave} has already crossed.`,
          ),
        );
      }
      // Already on the far side. Their bridge is done; a stray frame is not a
      // fall, exactly as a stray tap is not one in Plan / Apply.
      if ((play.position[event.pid] ?? 0) >= play.board.length) {
        return unchanged();
      }
      if (now >= play.stepEndsAt) {
        return unchanged(
          reject({ pid: event.pid }, "floor_locked", "That step has closed."),
        );
      }
      // The step the phone believed was open. A frame that crossed a step
      // boundary is a commitment to a pane the player never saw, and applying
      // it to whatever is open now would drain people for their network.
      if (event.step !== play.step) {
        return unchanged(
          reject(
            { pid: event.pid },
            "wrong_step",
            `Step ${play.step + 1} is the one that is open.`,
          ),
        );
      }
      // One pane per step. A second frame is not a change of mind: you have
      // put your weight on it.
      if (event.pid in play.stepped) {
        return unchanged(
          reject({ pid: event.pid }, "already_stepped", "You are on the pane."),
        );
      }
      if (event.choice !== 0 && event.choice !== 1) {
        return unchanged(
          reject({ pid: event.pid }, "invalid_choice", "There are two panes."),
        );
      }
      const answer = play.key[play.step];
      if (!answer) {
        return unchanged(
          reject({ pid: event.pid }, "wrong_round_phase", "No step is open."),
        );
      }

      const held = event.choice === answer.real;
      // Decision time, which is what the fastest crossing is measured in. The
      // step's own start, never the wave's and never the round's.
      const decidedIn = Math.max(0, now - play.stepStartedAt);
      const position = (play.position[event.pid] ?? 0) + (held ? 1 : 0);
      const across = held && position >= play.board.length;
      const gained = held ? glassStepBank(wave) + (across ? GLASS_FAR_SIDE : 0) : 0;

      const nextPlay: GlassPlay = {
        ...play,
        stepped: { ...play.stepped, [event.pid]: held },
        position: held ? { ...play.position, [event.pid]: position } : play.position,
        elapsedMs: {
          ...play.elapsedMs,
          [event.pid]: (play.elapsedMs[event.pid] ?? 0) + decidedIn,
        },
        crossOrder: across ? [...play.crossOrder, event.pid] : play.crossOrder,
        // `broken` is untouched. A pane that has just shattered is the whole
        // answer for this step and half this wave is still standing on the
        // other side of it — it is published when the step closes, and not
        // one moment earlier. See closeGlassStep().
      };

      return applied(
        {
          ...state,
          arcade: {
            ...arcade,
            standing: held
              ? arcade.standing
              : { ...arcade.standing, [event.pid]: "drained" },
            lounge: held
              ? arcade.lounge
              : { ...arcade.lounge, [event.pid]: { backing: null, at: now } },
            banked:
              gained > 0
                ? {
                    ...arcade.banked,
                    [event.pid]: (arcade.banked[event.pid] ?? 0) + gained,
                  }
                : arcade.banked,
            play: nextPlay,
          },
        },
        // A fall moves the dormitory grid, which is the whole room's surface,
        // so it goes everywhere — and it leaks nothing, because no projection
        // of this state says which pane anybody chose. A pane that held moves
        // only the stepper's own phone, the console and the big screen's
        // position row, which is the same set `submitAnswer` sends to.
        held
          ? [
              { kind: "broadcast", to: { pid: event.pid }, what: "state" },
              { kind: "broadcast", to: "host", what: "state" },
              { kind: "broadcast", to: "screen", what: "state" },
              PERSIST,
            ]
          : [BROADCAST_STATE, PERSIST],
      );
    }

    case "nextStep": {
      const arcade = state.arcade;
      if (!arcade) {
        return unchanged(
          reject("host", "not_in_arcade", "Enter the arcade first."),
        );
      }
      const play = arcade.play;
      if (arcade.phase !== "running" || play?.kind !== "glass_bridge") {
        return unchanged(
          reject("host", "wrong_round_phase", "No bridge round is running."),
        );
      }
      const step = play.step + 1;
      if (step >= play.board.length) {
        return unchanged(
          reject(
            "host",
            "wrong_round_phase",
            "That was the last step. Send the next wave.",
          ),
        );
      }
      // Closing drains whoever did not step and publishes the pane that broke.
      const close = closeGlassStep(state, arcade, play, now);
      const stepEndsAt = now + play.waveSeconds[play.wave - 1]! * 1000;
      return applied(
        {
          ...state,
          arcade: {
            ...arcade,
            standing: close.standing,
            lounge: close.lounge,
            endsAt: stepEndsAt + glassRemainingMs(play, play.wave, step),
            play: {
              ...play,
              step,
              stepStartedAt: now,
              stepEndsAt,
              stepped: {},
              broken: close.broken,
            },
          },
        },
        [BROADCAST_STATE, PERSIST],
      );
    }

    case "nextWave": {
      const arcade = state.arcade;
      if (!arcade) {
        return unchanged(
          reject("host", "not_in_arcade", "Enter the arcade first."),
        );
      }
      const play = arcade.play;
      if (arcade.phase !== "running" || play?.kind !== "glass_bridge") {
        return unchanged(
          reject("host", "wrong_round_phase", "No bridge round is running."),
        );
      }
      if (play.wave >= 3) {
        return unchanged(
          reject(
            "host",
            "wrong_round_phase",
            "That was the last wave. End the round.",
          ),
        );
      }
      // The wave's last step is closed by the wave ending, which is also what
      // closes it when the host cuts a wave short because everyone in it has
      // already fallen.
      const close = closeGlassStep(state, arcade, play, now);
      const wave = (play.wave + 1) as GlassWave;
      const stepEndsAt = now + play.waveSeconds[wave - 1]! * 1000;
      return applied(
        {
          ...state,
          arcade: {
            ...arcade,
            standing: close.standing,
            lounge: close.lounge,
            endsAt: stepEndsAt + glassRemainingMs(play, wave, 0),
            play: {
              ...play,
              wave,
              step: 0,
              waveStartedAt: now,
              stepStartedAt: now,
              stepEndsAt,
              stepped: {},
              broken: close.broken,
            },
          },
        },
        [BROADCAST_STATE, PERSIST],
      );
    }

    case "backPlayer": {
      const arcade = state.arcade;
      if (!arcade) {
        return unchanged(
          reject({ pid: event.pid }, "not_in_arcade", "The arcade is not open."),
        );
      }
      if (arcade.phase !== "running") {
        return unchanged(
          reject(
            { pid: event.pid },
            "wrong_round_phase",
            "The Lounge is not open.",
          ),
        );
      }
      if (arcade.standing[event.pid] !== "drained") {
        return unchanged(
          reject(
            { pid: event.pid },
            "not_in_the_lounge",
            "You are on the Floor. Play.",
          ),
        );
      }
      // "Change it freely until the Floor locks." The Floor locks when the
      // round clock runs out, which is a real window: `endRound` arrives from
      // the boundary a moment later, and a backing changed in between would be
      // a bet placed after the race.
      if (arcade.endsAt !== null && now >= arcade.endsAt) {
        return unchanged(
          reject({ pid: event.pid }, "floor_locked", "The Floor has locked."),
        );
      }
      if (event.backing === event.pid) {
        return unchanged(
          reject(
            { pid: event.pid },
            "cannot_back_yourself",
            "You are in the Lounge. Back somebody still playing.",
          ),
        );
      }
      const backed = state.participants[event.backing];
      if (!backed || backed.kicked) {
        return unchanged(
          reject(
            { pid: event.pid },
            "unknown_participant",
            `No participant ${event.backing}.`,
          ),
        );
      }
      if (arcade.standing[event.backing] !== "floor") {
        return unchanged(
          reject(
            { pid: event.pid },
            "cannot_back_a_drained_player",
            `${backed.nickname} is in the Lounge too.`,
          ),
        );
      }
      // The Glass Bridge narrows who is backable, because SPEC narrows it:
      // "Drained players back someone in a **later** wave."
      //
      // Both halves of that are needed and neither is decoration. Without the
      // first, every backer waits for wave 1 to produce a crosser and then
      // backs them — a runner already on the far side is still on the Floor,
      // so the 10 would be a certainty rather than a bet. Without the second,
      // a backer watches their wave-2 runner fall and switches to a wave-3
      // one, which is the same certainty wearing a hat. A bet is placed
      // before the runner steps onto the bridge, and then it stands.
      const bridge = arcade.play;
      if (bridge?.kind === "glass_bridge") {
        const held = arcade.lounge[event.pid]?.backing;
        if (
          held &&
          waveOf(arcade.playerNumbers[held], bridge.waveCuts) <= bridge.wave
        ) {
          return unchanged(
            reject(
              { pid: event.pid },
              "backing_locked",
              "Your runner is on the bridge. The bet stands.",
            ),
          );
        }
        const targetWave = waveOf(
          arcade.playerNumbers[event.backing],
          bridge.waveCuts,
        );
        if (targetWave <= bridge.wave) {
          return unchanged(
            reject(
              { pid: event.pid },
              "must_back_a_later_wave",
              `Wave ${targetWave} is already on the bridge. Back a later wave.`,
            ),
          );
        }
      }
      const seat = arcade.lounge[event.pid];
      if (seat?.backing === event.backing) return unchanged();
      return applied(
        {
          ...state,
          arcade: {
            ...arcade,
            lounge: {
              ...arcade.lounge,
              // `at` is when they were drained, not when they last changed
              // their mind: the big screen orders the Lounge by arrival.
              [event.pid]: { backing: event.backing, at: seat?.at ?? now },
            },
          },
        },
        // The big screen shows who has backed whom — being backed by six
        // people is its own small pressure — and the console shows the room.
        [
          { kind: "broadcast", to: { pid: event.pid }, what: "state" },
          { kind: "broadcast", to: "host", what: "state" },
          { kind: "broadcast", to: "screen", what: "state" },
          PERSIST,
        ],
      );
    }

    case "endRound": {
      const arcade = state.arcade;
      if (!arcade) {
        return unchanged(
          reject("host", "not_in_arcade", "Enter the arcade first."),
        );
      }
      if (arcade.phase !== "running") {
        return unchanged(
          reject("host", "wrong_round_phase", "No round is running."),
        );
      }
      // Whatever the Floor still owes, before the Lounge is settled against
      // the result: the Bridge's last step, Unseal's fastest bonuses, the last
      // pull, the last prompt and Gganbu's conversion. See closeRound().
      const closed: ArcadeState = closeRound(state, arcade, now);

      // The Floor locks, the Lounge is paid, and the round folds into the
      // arcade total. Who is drained is *not* reset here: the big screen keeps
      // the gold seats and the pink strike up between rounds, and everyone
      // returns to the Floor at the next `startRound`.
      const settled = settleRound(closed);
      return applied(
        {
          ...state,
          arcade: {
            ...closed,
            phase: "idle",
            startedAt: null,
            endsAt: null,
            banked: settled.banked,
            totals: settled.totals,
          },
        },
        // The settled points go no further than `arcade` yet — see
        // `revealRound`, and the same note on `closeQuestion`.
        [BROADCAST_STATE, PERSIST],
      );
    }

    case "revealRound": {
      const arcade = state.arcade;
      if (!arcade) {
        return unchanged(
          reject("host", "not_in_arcade", "Enter the arcade first."),
        );
      }
      if (arcade.round === null || arcade.phase !== "idle") {
        return unchanged(
          reject(
            "host",
            "wrong_round_phase",
            arcade.phase === "running"
              ? "End the round before revealing it."
              : "There is nothing to reveal.",
          ),
        );
      }
      // The arcade total lands in `scores` here rather than at `endRound`.
      //
      // Trivia learned this the hard way: the participant's points strip is
      // projected from `scores`, so writing at the close made the strip jump
      // for a right answer before the reveal and leaked correctness. The
      // arcade's hazard is milder — the phone has already said `Recruited.`,
      // already shown the drain, already counted the resources, so by the end
      // of a round nothing about your own play is still secret — but two
      // things are: the Lounge settlement, and the last item's answer, which
      // is not read out until the reveal. Writing here costs nothing and keeps
      // one rule for both activities: points become public when the answer does.
      return applied(
        {
          ...state,
          arcade: { ...arcade, phase: "reveal" },
          scores: withActivityTotals(state, arcade.activityId, arcade.totals),
        },
        [BROADCAST_STATE, ...BROADCAST_STANDINGS, PERSIST],
      );
    }
  }
}

/** Replay an event log onto a starting state. Used by restart recovery. */
export function replay(
  initial: SessionState,
  events: readonly { event: Event; at: number }[],
): SessionState {
  return events.reduce((s, e) => reduce(s, e.event, e.at).state, initial);
}
