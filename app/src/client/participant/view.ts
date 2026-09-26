/**
 * The participant view: everything below the join screen.
 *
 * It is a module rather than a page because the host console renders one too,
 * at 180px in the corner, live. "What does the room see right now" is the
 * question a host asks most, and answering it with the same code that answers
 * it on the phone is the only way the answer stays true.
 *
 * The view has no navigation and takes no input. The host decides what it
 * shows; this renders it.
 */

import type {
  ArcadeMine,
  ArcadeView,
  RenderState,
  TriviaMine,
  TriviaView,
} from "../../protocol.ts";
import type { UnsealShape } from "../../engine/types.ts";
import { append, h, replace, setAttr, setClass, setText } from "../shared/dom.ts";
import {
  ARCADE_ROUND_CARD,
  HOW_TO_PLAY,
  ARCADE_ROUND_LABEL,
  HOUSE,
  KEY_HINT,
  LIGHT_FACE,
  PLAY_RULE,
  SEALED_LINE,
  UNSEAL_FACE,
  STAFF_CARD,
  STATE_LOCK_ERROR,
  answerKeyIndex,
  answerTiles,
  UNSEAL_NOTHING_SAID,
  backedProgress,
  bridgeSteps,
  clipName,
  finalRevealMs,
  floorEntries,
  formatCountdown,
  glassBackable,
  glassCrossing,
  gridEntries,
  isTapKey,
  itemEndsAt,
  latestCheckpoint,
  lobbyAdmission,
  lobbyRoom,
  paneKeyIndex,
  playerName,
  playerTag,
  pointsStripCells,
  pointsStripText,
  questionLabel,
  raftArrival,
  raftDrain,
  remainingMs,
  resolveView,
  resourceBar,
  stepFraction,
  timerFraction,
  tugBeatAt,
  tugElectionAt,
  tugPullWinner,
  tugRope,
  unsealLetterKey,
  unsealSlot,
  unsealTiles,
  type BridgeEntry,
  type RaftEntry,
  type RaftMood,
  type RaftPlan,
  type UnsealSaid,
  type ViewKind,
} from "../shared/view.ts";

export interface ParticipantView {
  readonly root: HTMLElement;
  update(state: RenderState | null, nickname: string | null): void;
  setBanner(text: string | null): void;
  /** The tap was refused. Drop the optimistic "locked in" and let them retry. */
  clearPendingAnswer(): void;
  /**
   * A step onto a pane was refused. Give the two panes back.
   *
   * The commitment is shown the instant the key comes up — under six seconds
   * a phone that waits for the server is a phone that gets pressed twice —
   * so a refusal has to be able to take it off again, or the person believes
   * they are standing on a pane they never reached. Exactly the reason
   * `clearPendingAnswer` exists for a trivia tap.
   */
  clearPendingStep(): void;
}

export interface ParticipantViewOptions {
  compact?: boolean;
  /** Corrected server time. Every countdown on this page is drawn off it. */
  now?: () => number;
  /** Absent on the console's preview, which is a picture and not a phone. */
  onAnswer?: (index: number, choice: number) => void;
  onArcadeTap?: (round: number) => void;
  onArcadeAnswer?: (item: number, answer: string) => void;
  onArcadeStep?: (round: number, step: number, choice: 0 | 1) => void;
  onArcadeShape?: (round: number, shape: UnsealShape) => void;
  onArcadeLetter?: (round: number, letter: string) => void;
  onArcadeDocs?: (round: number) => void;
  onArcadeBeat?: (round: number) => void;
  onArcadeBack?: (pid: string) => void;
}

/**
 * The optimistic tap, held until the server's state says otherwise.
 *
 * Keyed by question index so it cannot survive into the next question, and
 * cleared by a refusal. A phone on a slow link must show "locked in" the
 * instant the thumb comes off the glass — the alternative is a second tap.
 */
interface Pending {
  index: number;
  choice: number;
}

interface Scene {
  node: HTMLElement;
  update(state: RenderState, nickname: string | null): void;
  /** Called a few times a second while mounted. Only the timer needs it. */
  tick?(state: RenderState): void;
  /** The arcade only: a refused commitment, taken back off the screen. */
  clearStep?(): void;
  stop?(): void;
}

/** Fast enough that the number never looks stuck, slow enough to cost nothing. */
const TICK_MS = 200;

export function createParticipantView(
  opts: ParticipantViewOptions = {},
): ParticipantView {
  const banner = h("div", {
    class: "p-banner",
    attrs: { hidden: true, role: "status", "aria-live": "polite" },
  });
  /**
   * Practice, said to the player.
   *
   * Not the banner above, which the socket owns for connection state. This is
   * always in the tree and hidden when it does not apply, because a player who
   * thinks a round counted and learns afterwards that it did not has been
   * misled by the screen, and the fix for that is a word on the screen rather
   * than a promise the host makes out loud once.
   */
  const practice = h("p", {
    class: "p-practice label",
    attrs: { hidden: true, role: "status", "aria-live": "polite" },
    text: "Practice — this one does not count",
  });
  const stage = h("main", { class: "p-stage" });
  // A group, so the `aria-label` below is honoured: the visual is a row of
  // swatches and numbers, and the label is the sentence they add up to.
  const strip = h("div", { class: "p-strip mono", role: "group" });
  const root = h("div", { class: opts.compact ? "p-root compact" : "p-root" }, [
    banner,
    practice,
    stage,
    strip,
  ]);

  let kind: ViewKind | null = null;
  let scene: Scene | null = null;
  let pending: Pending | null = null;
  let last: RenderState | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;

  const now = opts.now ?? ((): number => Date.now());

  /** Only a scene that asked for it gets a heartbeat, and only while mounted. */
  const setTicking = (on: boolean): void => {
    if (on === (ticker !== null)) return;
    if (!on) {
      if (ticker !== null) clearInterval(ticker);
      ticker = null;
      return;
    }
    ticker = setInterval(() => {
      if (last !== null) scene?.tick?.(last);
    }, TICK_MS);
  };

  const ctx: SceneCtx = {
    now,
    pending: () => pending,
    live: opts.onAnswer !== undefined || opts.onArcadeTap !== undefined,
    tap: (index, choice) => {
      if (opts.onAnswer === undefined) return;
      // One tap and it is final, so the guard is here as well as on the
      // server: a double-tap on a laggy phone must not produce two frames.
      if (pending !== null) return;
      pending = { index, choice };
      opts.onAnswer(index, choice);
      if (last !== null) scene?.update(last, null);
    },
    arcadeTap: (round) => opts.onArcadeTap?.(round),
    arcadeAnswer: (item, answer) => opts.onArcadeAnswer?.(item, answer),
    arcadeStep: (round, step, choice) =>
      opts.onArcadeStep?.(round, step, choice),
    arcadeShape: (round, shape) => opts.onArcadeShape?.(round, shape),
    arcadeLetter: (round, letter) => opts.onArcadeLetter?.(round, letter),
    arcadeDocs: (round) => opts.onArcadeDocs?.(round),
    arcadeBeat: (round) => opts.onArcadeBeat?.(round),
    arcadeBack: (pid) => opts.onArcadeBack?.(pid),
  };

  /**
   * Their own total and per-activity points — and nothing at all while sealed.
   *
   * The server omits `own` when the standings are sealed, and the strip takes
   * that literally: no numbers, nothing remembered from before the seal,
   * nothing derived from the standings. SCORING.md's seal is "no surface shows
   * cumulative standings", and a participant's own total is one of the
   * surfaces it names. The strip itself stays — a chrome that vanishes reads
   * as a bug — wearing the lock instead of the numbers.
   */
  const renderStrip = (state: RenderState): void => {
    const sealed = state.seal === "sealed";
    const own = sealed ? null : (state.own ?? null);
    const cells = pointsStripCells(own, state.activities);
    replace(strip, [
      sealed
        ? null
        : h("span", { class: "strip-you mono" }, [
            h("span", { class: "strip-you-label", text: "YOU" }),
            h("span", {
              class: "strip-you-total",
              text: own === null ? "—" : String(own.total),
            }),
          ]),
      ...cells.map((cell) =>
        h("span", { class: "strip-cell mono" }, [
          h("span", {
            class: "strip-swatch",
            attrs: { style: `background:${cell.hue}`, "aria-hidden": "true" },
          }),
          h("span", { class: "strip-cell-label", text: cell.label }),
          h("span", {
            class: "strip-cell-value",
            text: cell.value === null ? "—" : String(cell.value),
          }),
        ]),
      ),
      sealed ? lockGlyph("strip-lock") : null,
      sealed
        ? h("span", { class: "strip-sealed label", text: "scores hidden" })
        : null,
    ]);
    strip.classList.toggle("frozen", sealed);
    // The visual is a row of swatches and numbers; the label is the sentence.
    strip.setAttribute(
      "aria-label",
      sealed ? "Your points are sealed" : pointsStripText(own, state.activities),
    );
  };

  return {
    root,

    setBanner(text) {
      if (text === null) {
        banner.hidden = true;
        banner.textContent = "";
      } else {
        banner.hidden = false;
        setText(banner, text);
      }
    },

    clearPendingAnswer() {
      pending = null;
      if (last !== null) scene?.update(last, null);
    },

    clearPendingStep() {
      scene?.clearStep?.();
      if (last !== null) scene?.update(last, null);
    },

    update(state, nickname) {
      if (state === null) return;
      last = state;
      practice.hidden = !state.practice;
      // The optimistic tap lives exactly as long as its question. The server's
      // answer supersedes it; so does the next question.
      if (
        pending !== null &&
        (state.trivia === undefined ||
          state.trivia.index !== pending.index ||
          state.triviaMine?.state !== "unanswered")
      ) {
        pending = null;
      }
      const next = resolveView(state);
      if (next !== kind) {
        scene?.stop?.();
        kind = next;
        scene = buildScene(next, ctx);
        replace(stage, [scene.node]);
        stage.dataset["view"] = next;
        setTicking(scene.tick !== undefined);
      }
      scene?.update(state, nickname);
      renderStrip(state);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Scenes                                                              */
/* ------------------------------------------------------------------ */

interface SceneCtx {
  now(): number;
  pending(): Pending | null;
  /**
   * False on the console's preview, which is a picture of a phone and must
   * not be able to play the round the host is running.
   */
  live: boolean;
  tap(index: number, choice: number): void;
  arcadeTap(round: number): void;
  arcadeAnswer(item: number, answer: string): void;
  arcadeStep(round: number, step: number, choice: 0 | 1): void;
  arcadeShape(round: number, shape: UnsealShape): void;
  arcadeLetter(round: number, letter: string): void;
  arcadeDocs(round: number): void;
  arcadeBeat(round: number): void;
  arcadeBack(pid: string): void;
}

function buildScene(kind: ViewKind, ctx: SceneCtx): Scene {
  switch (kind) {
    case "waiting":
      return sceneWaiting();
    case "lobby":
      return sceneLobby();
    case "sendoff":
      return sceneSendoff();
    case "holding":
      return sceneHolding();
    case "standings":
      return sceneStandings(false);
    case "final":
      return sceneStandings(true);
    case "sealed":
      return sceneSealed();
    case "trivia":
      return sceneTrivia(ctx);
    case "arcade":
      return sceneArcade(ctx);
  }
}

function sceneWaiting(): Scene {
  const title = h("h1", { class: "display xl" });
  const node = h("section", { class: "v v-waiting" }, [
    h("p", { class: "label", text: "Quorum" }),
    title,
    h("p", { class: "v-note", text: "Waiting for the host to open the session." }),
  ]);
  return {
    node,
    update(state) {
      setText(title, state.title);
    },
  };
}

/**
 * The send-off, on the player's own screen.
 *
 * The same message the room is looking at, as text, and not a shrunken copy
 * of the Desktop: no photos, no montage, nothing to tap. Somebody whose
 * screen-share has frozen is still reading along, which at this point in a
 * session matters more than it does anywhere else — and the person being
 * celebrated is not made to watch the room watch a second copy of themselves.
 *
 * The points strip stays. The competition is usually not settled yet when
 * this runs, and taking the scoreboard away mid-send-off reads as the session
 * having ended.
 *
 * A kudo runs to 145 words, so the type is fitted the way the Desktop's is —
 * by the square root of the length, holding the area roughly constant — and
 * the message is the one box allowed to scroll if a short window still cannot
 * hold it. Reading is the only thing happening on this screen; the no-scroll
 * rule is about play.
 */
function sceneSendoff(): Scene {
  const who = h("p", { class: "label so-for" });
  const whoSub = h("p", { class: "label so-for-sub", attrs: { hidden: true } });
  const message = h("p", { class: "so-message" });
  const from = h("p", { class: "so-from" });
  const note = h("p", { class: "v-note so-note" });
  /**
   * The montage, on the phone too.
   *
   * It used to say "Photos, on the shared screen." — true, and useless to
   * somebody whose share had frozen, or who was on a phone, or who was simply
   * looking down. The photos are already served without a token so that an
   * `<img>` can carry them, so there is nothing to solve here beyond showing
   * them. Decorative, hence `alt=""`: the montage has no words and inventing
   * captions for somebody's holiday photographs would be worse than silence.
   */
  const photo = h("img", {
    class: "so-photo",
    attrs: { alt: "", decoding: "async", hidden: true },
  }) as HTMLImageElement;
  const farewellName = h("p", { class: "so-farewell-name", attrs: { hidden: true } });
  const node = h("section", { class: "v v-sendoff" }, [
    who,
    farewellName,
    whoSub,
    note,
    photo,
    message,
    from,
  ]);
  let rotation: ReturnType<typeof setInterval> | null = null;
  let showing = "";

  const stopPhotos = (): void => {
    if (rotation !== null) clearInterval(rotation);
    rotation = null;
    photo.hidden = true;
    showing = "";
  };

  /**
   * Show the one photograph the server says is up.
   *
   * The run has a clock and it is the server's, so the phone follows the
   * broadcast rather than rotating on its own — a pocket screen a beat ahead
   * of the shared one is the thing that makes a room look at their phones
   * instead of the front.
   */
  const showPhoto = (sid: string, key: string): void => {
    if (rotation !== null) clearInterval(rotation);
    rotation = null;
    if (key === showing) return;
    showing = key;
    photo.src = `/api/sessions/${encodeURIComponent(sid)}/assets/${encodeURIComponent(key)}`;
    photo.hidden = false;
  };

  /** Cycle a phase's photos. Restarted only when the set itself changes. */
  const runPhotos = (sid: string, keys: readonly string[], seconds: number): void => {
    const key = keys.join("|");
    if (key === showing) return;
    stopPhotos();
    if (keys.length === 0) return;
    showing = key;
    const urls = keys.map(
      (k) => `/api/sessions/${encodeURIComponent(sid)}/assets/${encodeURIComponent(k)}`,
    );
    let at = 0;
    const step = (): void => {
      const url = urls[at % urls.length];
      at += 1;
      if (url === undefined) return;
      photo.src = url;
      photo.hidden = false;
    };
    step();
    // The same pacing as the Desktop, floored so a long list does not flicker.
    const each = Math.max(2_500, Math.round((seconds * 1000) / Math.max(1, keys.length)));
    rotation = setInterval(step, each);
  };

  // A photo that 404s leaves the last good one up rather than a broken glyph.
  photo.addEventListener("error", () => {
    photo.hidden = true;
  });
  return {
    node,
    update(state) {
      const so = state.sendoff;
      if (!so) {
        // The host walked into the step and this event staged no send-off.
        // Said in words rather than left blank, the same as the Desktop.
        setText(who, "Send-off");
        setText(note, "Nothing staged for this event.");
        note.hidden = false;
        message.hidden = true;
        from.hidden = true;
        return;
      }
      setText(who, so.phase === "title" ? "Farewell" : so.name);
      setText(farewellName, so.name);
      farewellName.hidden = so.phase !== "title";
      setText(whoSub, so.subtitle ?? "");
      whoSub.hidden = (so.subtitle ?? "") === "";
      node.dataset["phase"] = so.phase;

      // The Farewell card: the name and its date, and nothing else. The room
      // is being asked to read one thing.
      if (so.phase === "title") {
        message.hidden = true;
        from.hidden = true;
        note.hidden = true;
        stopPhotos();
        return;
      }

      const k = so.kudo;
      if (k !== null) {
        setText(message, k.message);
        setText(from, k.from);
        message.hidden = false;
        from.hidden = false;
        message.style.setProperty("--so-size", kudoSize(so.longest));
        // Which one of how many, so a phone that lost the share still knows
        // where the room is. Quiet: it is not the content.
        setText(
          note,
          so.parts > 1
            ? `${so.index} of ${so.total} · ${so.part}/${so.parts}`
            : `${so.index} of ${so.total}`,
        );
        note.hidden = false;
        stopPhotos();
        return;
      }

      from.hidden = true;
      const line = so.phase === "closing" || so.phase === "done" ? so.line : null;
      setText(message, line ?? "");
      message.hidden = line === null || line === "";
      message.style.removeProperty("--so-size");
      // The run is stepped by the server, one key at a time; the closing
      // montage still cycles here because nothing else is driving it.
      if (so.phase === "run") {
        if (so.photo !== null) showPhoto(state.sid, so.photo);
        else stopPhotos();
      } else runPhotos(state.sid, so.photos, so.seconds);
      setText(note, "");
      note.hidden = true;
    },
  };
}

/**
 * The size for one message: constant *area*, not constant type.
 *
 * The same fit the Desktop uses, in a range this screen can hold — a browser
 * window beside a video call, or a phone in a pocket at the back of a room.
 */
/**
 * One size for every message in the set, from the longest.
 *
 * Not from the message being shown. Sizing each one on its own meant the type
 * jumped between people, which reads as some messages mattering more than
 * others — they do not, and a farewell is the last place to imply it. The
 * Desktop does the same thing by measuring; a phone is narrow enough that the
 * arithmetic is close enough and much cheaper.
 */
function kudoSize(longest: number): string {
  const n = Math.max(1, longest);
  const px = 420 / Math.sqrt(n);
  return `clamp(15px, ${px.toFixed(1)}px, 26px)`;
}

/**
 * Five nodes, and a join committed across them.
 *
 * The lobby is the longest stretch on a phone where nothing is happening and
 * nothing is being asked of the person holding it — they have joined, and now
 * they wait. It had a head count and a list of names, and the count moving
 * from 11 to 12 is not a thing anybody watches.
 *
 * So the count is drawn as what it actually is. A join is an entry appended
 * on the leader and replicated to the followers, and once a majority have it
 * the entry is committed — which is the product's own name, and the one piece
 * of distributed-systems theatre that is *true* rather than decorative.
 *
 * Deliberately not a real cluster. Quorum is one process; there are no five
 * nodes and no election, and pretending otherwise on a screen an engineer is
 * holding would be the kind of lie this repository avoids elsewhere. It is an
 * illustration of what the word means, shown at the moment it applies, and
 * the copy underneath says "joined" rather than claiming a replication
 * happened. Nothing here reads server state beyond the roster length the
 * lobby already had.
 */
/**
 * How long one commit takes, start to finish, over four equal stages: the
 * entry travels in, it replicates out, it is committed, and the committed
 * state is held.
 *
 * Was 1400ms, which was long enough to *see* and not long enough to read —
 * the name arrived and was gone before anybody had finished looking at it,
 * and the word "committed" showed for under half a second. The whole point
 * of the picture is the moment it names, so the moment gets half the budget.
 */
const COMMIT_MS = 2_800;

/**
 * How many of the five must have the entry before it is committed.
 *
 * Three of five. This is the whole reason the picture is worth drawing and
 * the product is called what it is, and the first version did not show it:
 * every follower flew for the same duration and landed on the same frame, so
 * the commit fired once *all five* agreed. That is precisely the thing Raft
 * exists not to do, and it is the one claim here an engineer in the room
 * would check. The followers now arrive spread out, the word lands when the
 * third node lights, and the last two catch up underneath it — which is what
 * a commit index advancing past a straggler actually looks like.
 */
const RAFT_MAJORITY = 3;

/**
 * Where each follower lands, as a fraction of one stage.
 *
 * Deliberately uneven and deliberately not sorted by position: a cluster
 * whose replicas answer in a neat top-to-bottom sweep reads as an animation,
 * and one where the near node is slow and the far node is quick reads as a
 * network.
 *
 * It used to say that and then be sorted ascending anyway, which meant the
 * sweep it was written to avoid, and — worse — that the commit's timing was
 * silently relying on the sort. Anybody realising the stated intent would
 * have moved the word to the wrong node. The order here is the drawing; the
 * majority is computed from a sorted copy, so the two cannot disagree again.
 */
const RAFT_LAG = [1.0, 0.55, 1.3, 0.75];

/** When the majority has it: the (MAJORITY - 1)th follower to answer. */
const RAFT_DECIDES =
  [...RAFT_LAG].sort((a, b) => a - b)[RAFT_MAJORITY - 2] ?? 1;

/**
 * Below this many pixels tall the drawing stops being a drawing.
 *
 * At 70px the name renders around four pixels and the LEADER tag is a smudge.
 * A short window would rather have the space back than have a thumbnail of a
 * diagram, so under this the cluster takes itself off the screen. Measured,
 * not guessed: the review that found this measured 86x54 at 375x667 with a
 * full room.
 */
const RAFT_MIN_PX = 110;

/**
 * The widest a name may draw, in viewBox units.
 *
 * The character cap alone does not bound this: thirteen W's measure 155
 * units against a 240-unit box and cross the top link, and twelve CJK
 * characters measure 138. Characters are not widths, so the width is what
 * gets checked, and anything over is squeezed to fit rather than clipped by
 * the viewBox edge.
 */
const RAFT_NAME_W = 92;

/**
 * @param onCommitted Called with a joiner's pid at the instant their entry is
 *   committed. The lobby holds their name out of the list until this fires,
 *   so the list is what the cluster has agreed on rather than a second,
 *   faster answer to the same question sitting beside it.
 *
 *   It is the cluster's job to call this for *every* pid it is handed, on
 *   every path — animated, queued, dropped from a full queue, or refused
 *   outright by a reduced-motion preference. A pid this never reports is a
 *   person who joined and never appeared, which is worse than any animation
 *   is good, so each early return below releases before it returns.
 */
function raftCluster(onCommitted: (pid: string) => void): {
  el: HTMLElement;
  commit: (who: string | null, pid: string | null) => void;
  flush: () => void;
  settle: () => void;
  fit: () => void;
  destroy: () => void;
} {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 240 150");
  svg.setAttribute("class", "raft");
  // Decorative: the head count beside it is the accessible fact, and a
  // screen reader announcing five circles every time somebody joins would be
  // noise in the one place the phone is meant to be quiet.
  svg.setAttribute("aria-hidden", "true");

  // Left to right: the entry arrives from off the left edge, lands on the
  // leader, and goes out to a column of followers on the right.
  //
  // The first arrangement put the leader on top with the followers fanned
  // beneath, which looked better and had nowhere to write LEADER — at any
  // baseline under that node the two inner links cross exactly where the word
  // wants to sit. Laid out this way the space directly below the leader is
  // empty, because every link leaves to the right.
  //
  // It also reads as the sentence the picture is making. Top-down said
  // "outward from the leader"; left-to-right says in, then across, which is
  // the order the thing actually happens in.
  const leader = { x: 48, y: 75 };
  const followers = [
    { x: 196, y: 24 },
    { x: 196, y: 58 },
    { x: 196, y: 92 },
    { x: 196, y: 126 },
  ];

  // Kept in an array, not just appended, because a link now lights with the
  // follower it feeds rather than all four lighting together. Which replicas
  // have the entry is the only fact this picture carries; drawing it as
  // all-or-nothing threw that fact away.
  const links: SVGLineElement[] = [];
  for (const f of followers) {
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", String(leader.x));
    line.setAttribute("y1", String(leader.y));
    line.setAttribute("x2", String(f.x));
    line.setAttribute("y2", String(f.y));
    line.setAttribute("class", "raft-link");
    svg.append(line);
    links.push(line);
  }

  const dots: SVGCircleElement[] = [];
  for (const [i, pos] of [leader, ...followers].entries()) {
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", String(pos.x));
    c.setAttribute("cy", String(pos.y));
    c.setAttribute("r", i === 0 ? "15" : "11");
    c.setAttribute("class", i === 0 ? "raft-node raft-leader" : "raft-node");
    svg.append(c);
    dots.push(c);
  }

  // Which node is the leader, said rather than implied by it being bigger.
  // Directly below it, which is clear background: every link leaves the
  // leader to the right, and the entry arrives from the left.
  const leaderTag = document.createElementNS(NS, "text");
  leaderTag.setAttribute("x", String(leader.x));
  leaderTag.setAttribute("y", String(leader.y + 34));
  leaderTag.setAttribute("text-anchor", "middle");
  leaderTag.setAttribute("class", "raft-tag");
  leaderTag.textContent = "LEADER";
  svg.append(leaderTag);

  // Two parts: the verb in the label register, the name in the person's own
  // casing. `.label` is uppercase mono, so a single node rendered "APPENDING
  // MCKENZIE" — the one thing on this screen that turns being welcomed into
  // being called out, and the only place a nickname was not shown the way it
  // was typed.
  const verb = h("span", { class: "raft-verb" });
  const who = h("span", { class: "raft-who" });
  const label = h("p", { class: "label raft-label" }, [verb, who]);
  const el = h("div", {
    class: "raft-wrap",
    // The whole wrapper, not just the drawing. The caption narrates a picture
    // a screen reader cannot see — "Replicating Sam" with no diagram is not
    // information, it is jargon — and it changes four times a join with no
    // live region, so it was in the tree and never announced, usually stale
    // by the time a virtual cursor reached it. The head count above says the
    // fact; this says how it is being drawn.
    attrs: { "aria-hidden": "true" },
  }, [svg, label]);

  /** One caption. Empty `name` leaves just the verb. */
  function say(text: string, name?: string | null): void {
    setText(verb, text);
    setText(who, name == null || name === "" ? "" : ` ${name}`);
  }

  let running = false;
  /** Entries waiting their turn, and who each of them was. */
  let queue: readonly RaftEntry[] = [];
  /** The pid of the entry on screen now, released when it commits. */
  let inFlight: string | null = null;

  function release(pid: string | null): void {
    if (pid !== null) onCommitted(pid);
  }

  /**
   * Is there any point animating this one?
   *
   * Three ways there is not, and they are the same answer: nobody can see it,
   * so there is no moment to wait for and holding the name costs a person
   * their place in the list for nothing.
   *
   * The third — the cluster being off the screen — was the one missing. A
   * window too short for the drawing hides it, and the commit went on running
   * its full two and a half seconds behind the `display: none`, holding the
   * name and the head count back for an animation that was not being drawn.
   */
  /**
   * Begin a new generation, without losing the entry the last one was holding.
   *
   * `gen` is what stops a superseded commit's timers from touching the
   * picture, and it was being bumped while `inFlight` still named somebody.
   * That orphaned them. The stage that releases a pid is scheduled from
   * inside the *first* stage's callback, and that callback returns early once
   * the generation has moved — so for an entry superseded inside its first
   * 700ms, the releasing stage was never scheduled at all and the name never
   * arrived. Reachable by turning reduced motion on mid-commit, which is a
   * preference this code explicitly supports changing mid-session.
   *
   * The orphan is released *last*, after the new generation is established,
   * because `release` calls the lobby back and the lobby can repaint and
   * re-enter this cluster. The generation is captured before that call, so a
   * re-entrant commit that bumps `gen` again leaves this caller's timers
   * correctly stale rather than two generations both believing they are
   * current.
   */
  function takeOver(next: string | null): number {
    const orphan = inFlight;
    gen += 1;
    const mine = gen;
    running = true;
    inFlight = next;
    if (orphan !== null && orphan !== next) release(orphan);
    return mine;
  }

  /**
   * Everything waiting, into the list now. See `flush` on the returned API.
   *
   * **Take the state before releasing any of it, not after.** `release` calls
   * the lobby back, the lobby repaints, the repaint calls `fit`, and `fit`
   * calls this again when it decides the cluster has no room — so this
   * function re-enters itself, and it does so *through the DOM* rather than
   * anywhere a reader of these six lines would look.
   *
   * Releasing first made that fatal. The re-entrant call still saw `inFlight`
   * set, because the outer call had not reached the line that clears it, so it
   * released the same pid again, and again: a short window plus a commit in
   * flight plus any repaint was `Maximum call stack size exceeded` thrown out
   * of the lobby's render. The queue had the identical shape — a second pass
   * walked the same array before `queue = []` ran.
   *
   * Clearing first makes the re-entrant call a no-op instead: it finds no
   * entry in flight and an empty queue, releases nothing, and unwinds.
   */
  function flushAll(): void {
    const pending = inFlight;
    const waiting = queue;
    inFlight = null;
    queue = [];
    release(pending);
    for (const e of waiting) release(e.pid);
  }

  function unseen(): boolean {
    // A hidden tab, or a window with no room for the drawing. Both mean the
    // same thing to a commit: it will not be watched.
    if (typeof document !== "undefined" && document.hidden) return true;
    return el.offsetParent === null;
  }

  /** Asked afresh every time, because a preference can change mid-session. */
  function stillPref(): boolean {
    return (
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  /** The three conditions the decisions turn on, read at this instant. */
  function mood(): RaftMood {
    return { unseen: unseen(), still: stillPref(), running };
  }

  /**
   * Do what {@link raftArrival} or {@link raftDrain} decided.
   *
   * The queue is written *before* anything is released, and that ordering is
   * load-bearing: a release repaints the lobby, a repaint calls `fit`, and a
   * `fit` that finds the drawing cramped flushes. Releasing first would let
   * that flush drain a queue this function then overwrote with the old one,
   * putting names back in a queue they had already left.
   */
  function apply(plan: RaftPlan): void {
    queue = plan.queue;
    for (const pid of plan.release) onCommitted(pid);
    if (plan.begin !== null) begin(plan.begin.who, plan.begin.pid);
  }
  /**
   * Which commit the timers belong to.
   *
   * Every stage of a commit is its own `setTimeout` mutating the same five
   * circles, so a timer from an earlier entry can fire after a later one has
   * tidied up — and it did: after two joins in quick succession, four
   * followers stayed lit for the rest of the session and the picture stopped
   * meaning anything. Each stage now carries the generation it was scheduled
   * for and does nothing if the cluster has moved on. Guarding the class of
   * bug rather than the instance, because the next stage added here would
   * reintroduce it.
   */
  let gen = 0;

  /**
   * Every pending stage, so teardown can cancel them.
   *
   * The scene is rebuilt whenever the host changes what is on screen, and a
   * retired cluster's timers used to keep firing against a detached SVG for
   * the rest of the commit. Harmless, but it is work nobody will see and a
   * reference nobody can collect.
   */
  const timers = new Set<number>();

  /**
   * The name currently drawn, so it can be re-measured if it becomes visible
   * part-way through its own commit.
   *
   * `getComputedTextLength` returns 0 inside a `display: none` subtree, so a
   * commit that starts while the cluster is hidden and finishes after the
   * window has grown would have drawn its name unsqueezed and let a wide one
   * run off the edge. Cheap to close: `fit()` re-asks whenever it decides the
   * cluster is visible.
   */
  let live: SVGTextElement | null = null;

  /**
   * Hold a name inside the box, by width rather than by character count.
   *
   * Characters are not widths. Thirteen capital W's measure 155 units in a
   * 240-unit viewBox and cross the top link; thirteen CJK characters measure
   * 150, and thirteen emoji 192. Measured in the document and squeezed if it
   * is over, so the name stays whole and stays inside.
   */
  function squeeze(tag: SVGTextElement): void {
    if (typeof tag.getComputedTextLength !== "function") return;
    try {
      tag.removeAttribute("textLength");
      tag.removeAttribute("lengthAdjust");
      // Zero means it is not being rendered, which is not the same as fitting.
      const w = tag.getComputedTextLength();
      if (w > RAFT_NAME_W) {
        tag.setAttribute("textLength", String(RAFT_NAME_W));
        tag.setAttribute("lengthAdjust", "spacingAndGlyphs");
      }
    } catch {
      // Measuring needs a laid-out document; without one the grapheme cap is
      // still in force and the worst case is a wide name clipped by the
      // viewBox, which is what it did before.
    }
  }
  function later(fn: () => void, ms: number): void {
    const id = window.setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
  }

  function cool(): void {
    live = null;
    svg.classList.remove("is-committed");
    for (const d of dots) d.classList.remove("is-hot");
    for (const l of links) l.classList.remove("is-hot");
    for (const stale of Array.from(svg.querySelectorAll(".raft-entry")))
      stale.remove();
  }

  /**
   * Whatever is next, decided now rather than when it was queued.
   *
   * The decision is {@link raftDrain}, which is pure and has a test; this is
   * the half of it that touches the document.
   */
  function nextUp(): void {
    running = false;
    const plan = raftDrain(queue, mood());
    apply(plan);
    // Nothing to draw, so nothing to narrate.
    if (plan.begin === null) say("");
  }

  /**
   * Start one commit, under the rules in force right now.
   *
   * Shared by the queue drain and by `commit`, which is the point: the drain
   * used to go straight to `play`, so a preference or a window that changed
   * during a burst was honoured for the arrival that changed it and ignored
   * for the three already waiting. Turning on reduced motion mid-rush still
   * animated them in full, the last one seven seconds later.
   */
  function begin(who: string | null, pid: string | null): void {
    if (unseen()) {
      release(pid);
      return;
    }
    if (stillPref()) {
      stillCommit(who, pid);
      return;
    }
    play(who, pid);
  }

  /**
   * Reduced motion: the state, with nothing travelling.
   *
   * The nodes still fill, because a fill is a state and not a movement —
   * which is what the stylesheet beside this has always claimed and what the
   * code did not do. This used to return with five grey circles that never
   * once did the thing they are for.
   */
  function stillCommit(who: string | null, pid: string | null): void {
    const mine = takeOver(null);
    release(pid);
    cool();
    for (const d of dots) d.classList.add("is-hot");
    for (const l of links) l.classList.add("is-hot");
    svg.classList.add("is-committed");
    say("Committed", who);
    later(() => {
      if (mine !== gen) return;
      cool();
      nextUp();
    }, COMMIT_MS / 2);
  }

  /** One entry: in to the leader, out to the followers, then committed. */
  function play(who: string | null, pid: string | null): void {
    const mine = takeOver(pid);
    // Start from cold, so a commit never inherits the last one's lit nodes.
    cool();
    say("Appending", who);

    // The entry is a group so the name travels with the dot rather than the
    // dot arriving anonymously. A count going up is the thing the roster
    // beside this already says; *whose* join it was is the thing this can
    // say and the list cannot, because the list has no moment.
    const START_X = -56;
    const entry = document.createElementNS(NS, "g");
    entry.setAttribute("class", "raft-entry");

    // Above the dot, not beside it: beside it the name would be under the
    // links on the way out, and at the leader it would sit on the circle.
    const tag = document.createElementNS(NS, "text");
    tag.setAttribute("x", String(START_X));
    tag.setAttribute("y", String(leader.y - 26));
    tag.setAttribute("text-anchor", "middle");
    tag.setAttribute("class", "raft-name");
    tag.textContent = who === null ? "" : clipName(who);

    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("r", "5");
    dot.setAttribute("cx", String(START_X));
    dot.setAttribute("cy", String(leader.y));
    dot.setAttribute("class", "raft-dot");

    entry.append(tag, dot);
    svg.append(entry);

    if (who !== null) {
      live = tag;
      squeeze(tag);
    }

    const step = COMMIT_MS / 4;
    // Starts off the left edge, which the viewBox clips, so the name slides
    // into the picture from outside the cluster — which is where it came
    // from.
    entry.animate(
      [
        { transform: "translateX(0)" },
        { transform: `translateX(${leader.x - START_X}px)` },
      ],
      { duration: step, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" },
    );

    later(() => {
      if (mine !== gen) return;
      // The dot is absorbed; the name stays on the leader for the rest of the
      // commit, so what is being replicated is legible while it replicates.
      dot.remove();
      dots[0]?.classList.add("is-hot");
      say("Replicating", who);
      followers.forEach((f, i) => {
        // Each replica answers in its own time. The spread is what makes the
        // commit a majority rather than a roll call.
        const flight = step * (RAFT_LAG[i] ?? 1);
        const r = document.createElementNS(NS, "circle");
        r.setAttribute("r", "4");
        r.setAttribute("cx", String(leader.x));
        r.setAttribute("cy", String(leader.y));
        r.setAttribute("class", "raft-entry raft-dot");
        svg.append(r);
        r.animate(
          [
            { transform: "translate(0,0)" },
            {
              transform: `translate(${f.x - leader.x}px, ${f.y - leader.y}px)`,
            },
          ],
          {
            duration: flight,
            easing: "cubic-bezier(.4,0,.2,1)",
            fill: "forwards",
          },
        );
        later(() => {
          r.remove();
          if (mine !== gen) return;
          dots[i + 1]?.classList.add("is-hot");
          links[i]?.classList.add("is-hot");
        }, flight);
      });

      // The majority moment, scheduled here rather than at the start.
      //
      // The followers' timers are set in this callback, and this one used to
      // be set a whole stage earlier alongside the travel. Two timers set at
      // different times are ordered by the clock and not by the queue, so a
      // busy main thread could put the word "Committed" on screen a frame
      // before the node that made it true. Set from the same instant as the
      // arrivals it is describing, the ordering is the timer queue's to keep.
      later(() => {
        // Released before the generation guard, on purpose. This is the only
        // place a pid becomes a name in the list, and a guard in front of it
        // is a guard in front of somebody appearing at all. Nothing can bump
        // `gen` between this being scheduled and it firing today — but the
        // next stage added here might, and a duplicate release is a no-op
        // while a missed one is a person who never arrived.
        inFlight = null;
        release(pid);
        if (mine !== gen) return;
        // A majority has it, so it is committed. That is the word, and it is
        // the only moment the picture is making a claim worth making. Two
        // followers are still in flight underneath it, which is not a glitch:
        // it is the commit index moving past a straggler.
        //
        // No number here. The head count above the names is the count, and it
        // says "committed" itself, so a total in the caption was the same
        // fact twice — and the two could disagree during a burst, because
        // the number was fixed when the entry was queued while the count
        // kept moving.
        say("Committed");
        svg.classList.add("is-committed");
      }, step * RAFT_DECIDES);
    }, step);

    later(() => {
      if (mine !== gen) return;
      cool();
      nextUp();
    }, COMMIT_MS);
  }

  return {
    el,
    commit(who: string | null, pid: string | null): void {
      // Straight through when nobody is watching, drawn now if nothing else
      // is, queued behind a cap otherwise — the whole of that is
      // {@link raftArrival}, which is pure and has a test. `flush` covers what
      // was already in the cluster when it went out of sight; the arrival
      // covers everything arriving while it stays out of sight, which is the
      // commoner ordering — a laptop is not hidden mid-commit, it is hidden
      // and then the room fills up.
      apply(raftArrival(queue, { who, pid }, mood()));
    },
    /**
     * Everything waiting, into the list now.
     *
     * The animation runs on `setTimeout`, and a backgrounded tab throttles
     * those to once a minute. Without this, locking a phone during the rush
     * and unlocking it a minute later would show a room of four. Nothing
     * here is worth a name not arriving.
     */
    flush(): void {
      flushAll();
    },
    /**
     * Back to resting: no caption, because nothing is happening.
     *
     * This used to write the room's total, which was the count that already
     * sits above the names saying the same word. It also could not be
     * trusted — entries let through a full queue, and everything a `flush`
     * releases, never reach the stage that writes the caption, so after a
     * burst it read "22 committed" beside a count of 24.
     *
     * Both problems go away by the caption never being a number. What is
     * left is making sure a stage caption does not outlive its commit when
     * one of those paths skipped the ending.
     */
    settle(): void {
      if (running || queue.length > 0) return;
      say("");
    },
    /**
     * Take the drawing off the screen when the space it was given is too
     * small to read it in.
     *
     * Flexbox has already decided how much room there is by the time this
     * runs, so this asks rather than predicts. It is deliberately not a
     * `ResizeObserver` on the wrapper: hiding the drawing changes the
     * wrapper's height, which would feed straight back in as another
     * observation and oscillate. The caller calls this when something that
     * could change the answer has happened — a repaint, or the window
     * resizing — and the measurement is taken with the drawing shown.
     */
    fit(): void {
      const was = el.classList.contains("is-cramped");
      if (was) el.classList.remove("is-cramped");
      const box = el.getBoundingClientRect();
      // Width, not height, decides whether there is a measurement to read at
      // all. A zero *height* is a real answer — it is flexbox saying there is
      // no room whatsoever — and reading it as "not laid out yet" left the
      // drawing nominally shown at nought pixels with its caption orphaned
      // underneath. A zero *width* is the lobby not being on screen: not
      // rendered yet, or a container query has taken it off.
      if (box.width === 0) {
        if (was) el.classList.add("is-cramped");
        return;
      }
      // Two ways to be too small, and the second is the one a threshold on
      // the drawing's own height cannot see.
      //
      // Too short to read: the drawing shrinks under `max-height` until the
      // name is four pixels tall.
      //
      // Too tall to fit: in the grid layout the cluster's row is `1fr` and
      // the drawing is `align-self: start`, so when the chips row has taken
      // the free space the drawing keeps its full height and simply hangs out
      // of the bottom of the lobby, where the stage clips it. Its own height
      // is a healthy 162px the whole time — the first version of this asked
      // only that, and so could not see the case where what was on screen was
      // the tops of three circles. Asking whether the box is *inside its
      // parent* catches both that and the short-window case that prompted it,
      // at every size, instead of at one guessed threshold.
      const room = el.parentElement?.getBoundingClientRect();
      const spills = room !== undefined && box.bottom > room.bottom + 1;
      if (spills || svg.getBoundingClientRect().height < RAFT_MIN_PX) {
        el.classList.add("is-cramped");
        // Anything mid-commit is now behind a `display: none`, so it is no
        // longer holding a name back for something somebody can watch. The
        // window shrinking must not cost a person their place in the list.
        flushAll();
      } else if (live !== null) squeeze(live);
    },
    /**
     * Cancel every pending stage. The scene is going away.
     *
     * Deliberately does not release what is still queued. A release exists to
     * put a name into the lobby's held set, and that set dies with the scene
     * — the next lobby holds nobody and admits the whole room on its first
     * render. Releasing into a detached list would be work with no reader.
     */
    destroy(): void {
      for (const id of timers) window.clearTimeout(id);
      timers.clear();
      gen += 1;
      running = false;
      queue = [];
    },
  };
}

/**
 * Sessions whose arrival has already been played on this page.
 *
 * `buildScene` makes a fresh lobby every time the host changes what is on
 * screen, so without this the welcome replays each time the room comes back
 * from a holding card — and the third time somebody watches themselves join
 * they are not being welcomed, they are watching a loop. Module level, keyed
 * on the session, so a genuine reload or a rejoin does play it again: you did
 * just arrive.
 */
const welcomed = new Set<string>();

function sceneLobby(): Scene {
  const nick = h("p", { class: "display lobby-nick" });
  const you = h("div", { class: "lobby-you" }, [
    h("p", { class: "label", text: "You're in" }),
    nick,
  ]);
  const title = h("h1", { class: "display lobby-title" });
  const subtitle = h("p", { class: "lobby-subtitle", attrs: { hidden: true } });
  const prize = h("p", { class: "lobby-prize" });
  const count = h("span", { class: "num lobby-count" });
  const chips = h("div", { class: "lobby-chips" });

  /**
   * Who the cluster has committed, and therefore who is drawn in the list.
   *
   * The roster says who the server has; this says who the picture has caught
   * up with. They differ for one commit — about a second and a half — and in
   * that gap the person's name is travelling into the leader instead of
   * sitting in the list.
   *
   * Including, on the first render, *your own*. The first version of this
   * held everyone except the viewer, because the viewer's own pid is already
   * in the very first frame the server sends them — so the one person whose
   * moment it was got a nameless "entry appended" and saw their name already
   * in the list, while everybody else's screen animated it. The events are
   * virtual; nobody is looking over a shoulder, so that meant the moment was
   * shown to everyone it did not belong to. "You're in" at the top of the
   * screen answers "did it work" on its own, which is what makes holding your
   * own name for a second and a half safe.
   */
  const held = new Set<string>();
  /** The last state drawn, so the list can be repainted when a commit lands. */
  let last: RenderState | null = null;
  /** This surface's own nickname, or null on the console's preview. */
  let mine: string | null = null;

  const cluster = raftCluster((pid) => {
    held.add(pid);
    if (last !== null) paintRoom(last);
  });

  /** Torn down with the scene; see `stop`. */
  const scrap = new AbortController();

  // The cluster sits *under* the names, not above them. It is a picture of
  // what the list of names means, so it reads as a caption to the list rather
  // than as something the list is a caption to — and on a phone it puts the
  // motion at the bottom of the screen instead of between the session title
  // and the room.
  const node = h("section", { class: "v v-lobby" }, [
    you,
    title,
    subtitle,
    prize,
    h("div", { class: "lobby-here" }, [
      count,
      // "committed", not "here". The count and the cluster are one statement
      // now: the number is what the cluster has agreed on, which is exactly
      // what the word underneath the nodes used to repeat.
      h("span", { class: "label", text: "committed" }),
    ]),
    // One box, not two. The cluster used to be its own grid row under the
    // chips' row, and a grid row's height comes from the tracks, not from the
    // content beside it — so with ten people the chips sat at the top of a
    // tall area and the cluster started 130 pixels below the last name, and
    // in a short window the chips' row took the free space and left the
    // cluster hanging out of the bottom of the stage. Stacked in one box the
    // cluster is always directly under the last chip, at every roster size,
    // because that is literally what it is now.
    h("div", { class: "lobby-room" }, [chips, cluster.el]),
    h("p", { class: "label lobby-wait", text: "Waiting for the host" }),
  ]);

  /**
   * Who was in the roster last draw, so a commit plays on a join and not on
   * every broadcast. The lobby is re-rendered whenever anything changes —
   * somebody going away, the host locking joins — and animating those would
   * make the picture mean "a frame arrived" rather than "somebody joined".
   *
   * Pids rather than a count, which is what this was. A count cannot say
   * *who* arrived, and now that the entry carries a name it has to; a count
   * also can't tell one person leaving as another joins from nothing
   * happening, which is the one case where it would have named the wrong
   * person on screen.
   *
   * Null until the first render: arriving into a room of eleven should not
   * replay eleven commits, it should say eleven are committed.
   */
  let seen: Set<string> | null = null;

  /**
   * The head count and the names, drawn from the committed set rather than
   * from the roster.
   *
   * Both, not just the names. A count that ran ahead of the list would be the
   * one thing on the screen contradicting it — "12 here" over eleven chips —
   * and somebody looking for their own name would be counting. The cluster's
   * own caption says the same number at the same time.
   */
  function paintRoom(state: RenderState, nickname?: string | null): void {
    if (nickname !== undefined) mine = nickname;
    // Who is drawn, and in what order, is {@link lobbyRoom} — pure, and tested.
    // Names, as text, clipped by the layout rather than by a slice: the
    // surface must not scroll, and "+7 earlier" is more honest than a cut.
    const room = lobbyRoom(state.roster, held, mine);
    setText(count, String(room.count));
    cluster.settle();
    replace(chips, []);
    if (room.over > 0) {
      append(chips, [
        h("span", {
          class: "chip chip-more label",
          text: `+${room.over} earlier`,
        }),
      ]);
    }
    if (room.you !== null) {
      append(chips, [h("span", { class: "chip is-you", text: room.you.nickname })]);
    }
    append(
      chips,
      room.shown.map((r) => h("span", { class: "chip", text: r.nickname })),
    );
    cluster.fit();
  }

  // A hidden tab throttles the timers the animation runs on, so anything
  // still in the cluster when it goes away is let straight through. Coming
  // back to a room of four because the rush happened behind a lock screen
  // would be the animation costing the thing it decorates.
  //
  // Both registered against `scrap`, so they go when the scene does. They
  // used to be added on every lobby mount and removed on none: the host
  // toggling a holding card on and off left a listener behind each time,
  // each holding a dead cluster and a dead roster.
  if (typeof document !== "undefined") {
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.hidden) cluster.flush();
      },
      { signal: scrap.signal },
    );
  }
  if (typeof window !== "undefined") {
    // The window changing size changes how much room the cluster was given,
    // and no broadcast follows it.
    window.addEventListener("resize", () => cluster.fit(), {
      signal: scrap.signal,
    });
  }

  return {
    node,
    update(state, nickname) {
      // The console renders this view with no nickname of its own; it is a
      // preview of the room, not of one person.
      you.hidden = nickname === null;
      if (nickname !== null) setText(nick, nickname);
      setText(title, state.title);
      setText(subtitle, state.subtitle ?? "");
      subtitle.hidden = (state.subtitle ?? "") === "";
      // Deliberately *not* `state.holding.line`, which is what this used to
      // read. `holding` is the last card the host set, not the card currently
      // on screen — the engine only clears it on a restart — so once any card
      // had been shown, its second line followed the room back into the lobby.
      // With one card, typed in the lobby before anything ran, the two were
      // the same thing and this worked. With named cards it meant the lobby
      // announced the facilitator's name under the session title.
      //
      // A card's second line belongs to that card. The prize line DESIGN.md
      // describes here needs a field of its own; until it has one, the lobby
      // says nothing rather than something that belongs to another screen.
      prize.hidden = true;
      // A different session in the same scene starts over. The view is only
      // rebuilt when the *kind* of view changes, so "use a different code"
      // lands in another session's lobby holding the previous room's pids:
      // everyone in the new room reads as a fresh arrival and the count sits
      // three behind for ten seconds while the cluster animates strangers.
      if (last !== null && last.sid !== state.sid) {
        seen = null;
        held.clear();
        cluster.flush();
      }
      last = state;
      // Who is held and who is animated is {@link lobbyAdmission} — pure, and
      // tested. Everyone already here on the first render is already committed;
      // the picture plays once for the room rather than once per person in it —
      // except for you, who are the reason it is playing at all.
      const admission = lobbyAdmission(
        state.roster,
        seen,
        nickname,
        welcomed.has(state.sid),
      );
      seen = new Set(state.roster.map((r) => r.pid));
      for (const pid of admission.hold) held.add(pid);
      if (admission.yours) welcomed.add(state.sid);
      for (const entry of admission.commit) cluster.commit(entry.who, entry.pid);
      // Anyone who has left stops being held, so a name cannot be waiting on
      // a commit for somebody who is no longer in the room.
      //
      // Unconditionally, where this was guarded on `held.size > here`. One
      // person leaving as another joins keeps the sizes equal and left the
      // departed pid behind — and pids survive a leave: a rejoin token brings
      // somebody back under the *same* pid, so they would then reappear in
      // the list instantly while the cluster was still animating them. That
      // is exactly the second, faster answer the hold exists to prevent.
      // Thirty pids in a Set costs nothing; the condition bought nothing.
      const present = seen;
      for (const pid of Array.from(held))
        if (!present.has(pid)) held.delete(pid);
      paintRoom(state, nickname);
    },
    stop() {
      scrap.abort();
      cluster.destroy();
    },
  };
}

function sceneHolding(): Scene {
  const title = h("h1", { class: "display xl" });
  const line = h("p", { class: "holding-line" });
  const node = h("section", { class: "v v-holding" }, [
    h("p", { class: "label holding-conn" }, [
      h("span", { class: "dot pulse", attrs: { "data-conn": "on" } }),
      " connected",
    ]),
    title,
    line,
  ]);
  return {
    node,
    update(state) {
      setText(title, state.holding?.title ?? state.title);
      setText(
        line,
        state.holding?.line ?? "The host is talking. Nothing to tap.",
      );
    },
  };
}

/**
 * Standings, and — with `final` — the reveal the room is watching.
 *
 * The final rows are held back. The wire carries the whole result the moment
 * the host reaches the final segment, and this phone could paint all five
 * rows in one frame; the Desktop takes twenty-three seconds to climb to the
 * winner. A phone that renders immediately reads the winner's name out to its
 * owner, and to whoever is sitting next to them, before the room's screen has
 * left fifth place — which is what happened in front of a room. So the phone
 * says where to look, counts out the Desktop's own pace from
 * {@link finalRevealMs}, and shows the rows when the winner lands there.
 *
 * Counted locally, from the moment the result arrives, because the protocol
 * has no message for "the Desktop is on step three". The two surfaces get the
 * state within a frame of each other, so counting the same arithmetic from
 * the same broadcast is as close as this can be without a new message — and
 * being a second late is harmless in a way that being twenty seconds early is
 * not. A phone that joins or reconnects mid-reveal waits out a fresh count,
 * which is late rather than early, and therefore the right way to be wrong.
 */
function sceneStandings(final: boolean): Scene {
  const heading = h("p", {
    class: "label",
    text: final ? "Final standings" : "Standings · top five",
  });
  const list = h("ol", { class: "rows" });
  const empty = h("p", {
    class: "v-note",
    text: final ? "No scores were recorded." : "No scores yet.",
  });
  // DESIGN.md's last announcer line. The arcade has no "end the arcade"
  // command — the host simply moves the room on — so the only honest signal
  // for *the games have concluded* is the room standing outside the arcade
  // with a round behind it. Standings is where that lands in the run of show,
  // and it is the screen the host talks over while the line is up.
  const house = houseSlot("a-standings-house");
  house.node.hidden = true;
  const hold = h("div", { class: "v-hold", attrs: { hidden: true } }, [
    // Not "look up": half the room is watching the share in another window.
    h("h1", { class: "display xl", text: "On the shared screen" }),
    h("p", {
      class: "v-note",
      text: "The final standings are being revealed there. They appear here when the winner does.",
    }),
  ]);
  const node = h("section", { class: "v v-standings" }, [
    heading,
    house.node,
    hold,
    list,
    empty,
  ]);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let signature = "";
  let holding = false;
  let latest: RenderState | null = null;

  const paint = (): void => {
    const state = latest;
    if (state === null) return;
    const concluded =
      !final && state.arcade !== undefined && state.arcade.round !== null;
    house.node.hidden = !concluded;
    if (concluded) house.set(HOUSE.arcadeEnd);
    hold.hidden = !holding;
    const rows = holding ? [] : state.standings;
    // Nothing to say about an empty result while the card is up saying it.
    empty.hidden = holding || state.standings.length > 0;
    replace(
      list,
      rows.map((row, i) =>
        h(
          "li",
          { class: final && i === 0 ? "row row-winner" : "row" },
          [
            h("span", { class: "num rank", text: String(row.rank) }),
            h("span", { class: "display name", text: row.nickname }),
            h("span", { class: "num total", text: String(row.total) }),
          ],
        ),
      ),
    );
  };

  /**
   * Start the wait, once per result.
   *
   * Keyed on the result itself and not on the broadcast: state arrives many
   * times a minute, and a wait that restarted on each one would never end. A
   * result that genuinely changes — a spot award after the final segment is
   * reached — restarts it, which is what the Desktop does with its own climb.
   */
  const arm = (state: RenderState): void => {
    const sig = state.standings
      .map((r) => `${r.rank}:${r.nickname}:${r.total}`)
      .join("|");
    if (sig === signature) return;
    signature = sig;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const wait = finalRevealMs(state.standings);
    holding = wait > 0;
    if (!holding) return;
    timer = setTimeout(() => {
      timer = null;
      holding = false;
      paint();
    }, wait);
  };

  return {
    node,
    update(state) {
      latest = state;
      if (final) arm(state);
      paint();
    },
    stop() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

function sceneSealed(): Scene {
  // `SEALED_LINE`, and deliberately not `state.holding.line`, which is what
  // this read until a sealed phone showed, under "Scores are hidden", the
  // facilitator named on the last holding card — at a real event. The lobby
  // had the same bug, in the same place, for the same reason. See
  // `SEALED_LINE`.
  const node = h("section", { class: "v v-sealed" }, [
    lockGlyph("sealed-lock"),
    h("h1", { class: "display xl", text: "Scores are hidden" }),
    h("p", { class: "v-note", text: SEALED_LINE }),
  ]);
  return { node, update() {} };
}

/* ------------------------------------------------------------------ */
/* Trivia                                                              */
/* ------------------------------------------------------------------ */

/**
 * The phone during trivia. Four states, and the transitions between them are
 * the whole product:
 *
 * - **waiting** — the host has not opened the question, so the phone has not
 *   been sent it. There is nothing here to read ahead.
 * - **open** — question, timer, and the answers as 2 × 2 shape-and-colour
 *   tiles filling the bottom of the screen, where a thumb is.
 * - **locked** — the chosen tile outlined, the others dimmed, "Locked in."
 *   and *nothing else*. No tick, no colour, no hint. SPEC: "a phone that
 *   turns green is visible to the person next to you." The wire does not
 *   carry the answer at this point, so there is nothing here that could leak
 *   even by mistake; this state is what the wire's silence looks like.
 * - **revealed** — the correct tile fills, a wrong choice outlines in
 *   `--miss`, the points and the streak, the note, then the trivia top five.
 */
function sceneTrivia(ctx: SceneCtx): Scene {
  const kicker = h("p", { class: "label t-kicker" });
  const roundCard = h("p", { class: "t-round label", attrs: { hidden: true } });
  const question = h("h1", { class: "t-question" });

  const timerNum = h("span", { class: "mono t-timer-num" });
  const timerFill = h("div", { class: "t-timer-fill" });
  const timer = h("div", { class: "t-timer" }, [
    h("div", { class: "t-timer-track" }, [timerFill]),
    timerNum,
  ]);

  const grid = h("div", { class: "t-grid" });
  const keys = keyHint(KEY_HINT.trivia);
  // "Locked in." and, once the server has sent the count, the room's progress
  // beside it. One paragraph rather than two: the laptop grid places `status`
  // by name, so a second element would need an area of its own and the
  // two-column layout would have to be re-cut for a line of text.
  const statusText = h("span", { class: "t-status-text" });
  // The wait after the tap is seventeen seconds of a phone that does not move.
  // The count is what the console and the Desktop have always had — and on a
  // video call the Desktop is a tile nobody can read — so the phone gets it
  // too. The server sends it only once this phone has locked in, so there is
  // no "has it answered" check here: what arrived is what may be drawn.
  const count = h("span", { class: "t-count mono", attrs: { hidden: true } });
  const status = h("p", { class: "t-status label" }, [statusText, count]);
  // Under the timer and above the tiles, which is where the eye already is
  // while somebody is deciding. In the head, so the laptop grid — which
  // places `head`, `status`, `keys` and `reveal` by name — needs no new area
  // and the two-column layout is untouched.
  const rule = playRule(PLAY_RULE.trivia);

  const verdict = h("p", { class: "display t-verdict" });
  const points = h("p", { class: "mono t-points" });
  const streak = h("p", { class: "label t-streak" });
  const note = h("p", { class: "t-note" });
  const podium = h("ol", { class: "rows t-podium" });
  const reveal = h("div", { class: "t-reveal", attrs: { hidden: true } }, [
    verdict,
    points,
    streak,
    note,
    podium,
  ]);

  const node = h("section", { class: "v v-trivia" }, [
    h("div", { class: "t-head" }, [kicker, roundCard, question, timer, rule]),
    grid,
    keys,
    status,
    reveal,
  ]);

  /** Which question's tiles are currently built, so they are not rebuilt. */
  let builtFor = "";
  let tiles: HTMLButtonElement[] = [];
  /** The last points value animated, so a repaint does not replay the count. */
  let countedFrom: number | null = null;

  const buildTiles = (trivia: TriviaView): void => {
    const signature = `${trivia.index}:${trivia.answers.join("\u0000")}`;
    if (signature === builtFor) return;
    builtFor = signature;
    tiles = answerTiles(trivia.answers).map((tile) => {
      const button = h("button", {
        class: "t-tile",
        type: "button",
        attrs: {
          style: `--tile:${tile.hue};--tile-ink:${tile.ink}`,
          "data-choice": String(tile.index),
          // The shape is decoration to a reader; the text is the answer, and
          // the number key is said out loud because a keyboard user has no
          // other way to learn it.
          "aria-label": `${tile.text}. Key ${tile.index + 1}.`,
        },
      }, [
        h("span", { class: "t-shape", attrs: { "aria-hidden": "true" }, text: tile.shape }),
        h("span", { class: "t-answer", text: tile.text }),
        h("span", {
          class: "t-key mono",
          attrs: { "aria-hidden": "true" },
          text: String(tile.index + 1),
        }),
      ]);
      button.addEventListener("click", () => ctx.tap(trivia.index, tile.index));
      return button;
    });
    replace(grid, tiles);
    grid.dataset["count"] = String(tiles.length);
  };

  const paintTimer = (trivia: TriviaView): void => {
    // Sudden death has no timer at all, so it shows none rather than a bar
    // that sits at full and looks broken.
    if (trivia.suddenDeath || trivia.phase !== "open") {
      timer.hidden = true;
      return;
    }
    const left = remainingMs(trivia.closesAt, ctx.now());
    if (left === null) {
      timer.hidden = true;
      return;
    }
    timer.hidden = false;
    setText(timerNum, formatCountdown(left));
    const fraction = timerFraction(trivia, ctx.now()) ?? 0;
    timerFill.style.width = `${fraction * 100}%`;
    setClass(timer, "urgent", left <= 5_000);
  };

  const paint = (state: RenderState): void => {
    const trivia = state.trivia;
    if (trivia === undefined || trivia.phase === "idle" || trivia.text === "") {
      // Either nothing is loaded or the host has not opened it. Same screen:
      // there is nothing to read ahead, and saying so beats a blank page.
      setText(kicker, "Trivia");
      roundCard.hidden = trivia?.round?.startsHere !== true;
      if (trivia?.round) setText(roundCard, trivia.round.name);
      setText(question, "Get ready.");
      timer.hidden = true;
      replace(grid, []);
      tiles = [];
      keys.hidden = true;
      rule.hidden = false;
      builtFor = "";
      setText(statusText, "The host is about to open the question.");
      count.hidden = true;
      reveal.hidden = true;
      return;
    }

    setText(kicker, questionLabel(trivia));
    roundCard.hidden = trivia.round === null;
    if (trivia.round) setText(roundCard, trivia.round.name);
    setText(question, trivia.text);
    buildTiles(trivia);
    paintTimer(trivia);

    const mine: TriviaMine | undefined = state.triviaMine;
    const pending = ctx.pending();
    const chosen =
      mine?.state === "locked"
        ? mine.choice
        : mine?.state === "revealed"
          ? mine.choice
          : pending !== null && pending.index === trivia.index
            ? pending.choice
            : null;
    const revealed = trivia.phase === "revealed" && mine?.state === "revealed";
    const correct = revealed ? (trivia.correct ?? []) : [];

    tiles.forEach((tile, i) => {
      const isChosen = chosen === i;
      const isCorrect = correct.includes(i);
      setClass(tile, "chosen", isChosen);
      setClass(tile, "hit", revealed && isCorrect);
      setClass(tile, "miss", revealed && isChosen && !isCorrect);
      // Dimmed once a choice is locked, and after the reveal for anything
      // that is neither the answer nor what they picked.
      setClass(tile, "dim", chosen !== null && !isChosen && !(revealed && isCorrect));
      tile.disabled = chosen !== null || trivia.phase !== "open";
      setAttr(tile, "aria-pressed", isChosen ? "true" : "false");
    });

    if (revealed) {
      timer.hidden = true;
      keys.hidden = true;
      // The question is answered and the tiles are not a control any more.
      // Hidden on the phase, which every screen in the room can already see,
      // and never on anything about this person's answer.
      rule.hidden = true;
      setText(statusText, "");
      // The count belongs to the wait, and the wait is over: what the room did
      // is the distribution on the big screen from here on.
      count.hidden = true;
      status.hidden = true;
      reveal.hidden = false;
      const won =
        trivia.suddenDeath && trivia.suddenDeathWinner !== null
          ? `${trivia.suddenDeathWinner} took it`
          : null;
      setText(
        verdict,
        won ?? (mine.correct ? "Correct" : mine.choice === null ? "No answer" : "Not this time"),
      );
      setAttr(verdict, "data-verdict", mine.correct ? "hit" : "miss");
      // Sudden death changes no points, so it shows none rather than a zero
      // that reads as a penalty.
      const total = mine.points + mine.streakBonus;
      points.hidden = trivia.suddenDeath;
      if (!trivia.suddenDeath) {
        countUp(points, countedFrom === total ? total : 0, total);
        countedFrom = total;
      }
      streak.hidden = mine.streak < 2 || trivia.suddenDeath;
      setText(streak, `${mine.streak} in a row · +${mine.streakBonus}`);
      const text = trivia.note ?? "";
      note.hidden = text === "";
      setText(note, text);
      const rows = trivia.podium ?? [];
      podium.hidden = rows.length === 0;
      replace(
        podium,
        rows.map((row) =>
          h("li", { class: "row" }, [
            h("span", { class: "num rank", text: String(row.rank) }),
            h("span", { class: "display name", text: row.nickname }),
            h("span", { class: "num total", text: String(row.points) }),
          ]),
        ),
      );
      return;
    }

    reveal.hidden = true;
    rule.hidden = false;
    countedFrom = null;
    status.hidden = false;
    keys.hidden = chosen !== null || trivia.phase !== "open";
    setText(
      statusText,
      chosen !== null
        ? "Locked in."
        : trivia.phase === "open"
          ? trivia.suddenDeath
            ? "Sudden death. First correct answer wins."
            : "Pick one. It is final."
          : "Time's up.",
    );
    const answered = trivia.answered;
    const eligible = trivia.eligible;
    count.hidden = answered === undefined || eligible === undefined;
    if (answered !== undefined && eligible !== undefined) {
      setText(count, ` · ${answered} of ${eligible} answered`);
    }
  };

  /**
   * `1`–`4` answer, from anywhere on the page.
   *
   * On the tile itself, so the tile's own handler and its guards stay the one
   * place a choice is made — a keyboard path with its own copy of "one tap and
   * it is final" is a second rule to keep in step. Focus moves first so the
   * choice is visible where the ring is, which is the whole reason a keyboard
   * user can follow what just happened.
   */
  const onKey = (ev: KeyboardEvent): void => {
    if (!ctx.live || isTypingTarget(ev.target)) return;
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const i = answerKeyIndex(ev.key, tiles.length);
    if (i === null) return;
    const tile = tiles[i];
    if (tile === undefined || tile.disabled) return;
    ev.preventDefault();
    tile.focus();
    tile.click();
  };
  if (ctx.live) window.addEventListener("keydown", onKey);

  return {
    node,
    update(state) {
      paint(state);
    },
    tick(state) {
      if (state.trivia) paintTimer(state.trivia);
    },
    stop() {
      window.removeEventListener("keydown", onKey);
    },
  };
}

/**
 * Count a number up, because DESIGN asks the points to arrive rather than
 * appear. Honours `prefers-reduced-motion` by not moving.
 */
function countUp(el: HTMLElement, from: number, to: number): void {
  const reduced =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || from === to) {
    setText(el, String(to));
    return;
  }
  const started = Date.now();
  const DURATION = 700;
  const step = (): void => {
    const t = Math.min(1, (Date.now() - started) / DURATION);
    setText(el, String(Math.round(from + (to - from) * t)));
    if (t < 1) requestAnimationFrame(step);
  };
  step();
}


/* ------------------------------------------------------------------ */
/* Hashi Arcade                                                        */
/* ------------------------------------------------------------------ */

/**
 * A short, guarded buzz. DESIGN.md wants the turn to be felt as well as seen.
 *
 * `navigator.vibrate` does not exist on iOS Safari at all, and where it does
 * exist it can throw outside a user gesture or when the tab is hidden. Both
 * are silent no-ops here: a haptic is a bonus channel, never the only one
 * carrying the state, and a phone that cannot buzz still shows the word, the
 * glyph and a button it cannot press.
 */
function buzz(pattern: number | readonly number[]): void {
  try {
    const nav = navigator as Navigator & {
      vibrate?: (p: number | number[]) => boolean;
    };
    if (typeof nav.vibrate !== "function") return;
    nav.vibrate(typeof pattern === "number" ? pattern : [...pattern]);
  } catch {
    /* no haptics here, and nothing about the game depends on them */
  }
}

/** The Front-End Man, on the phone: mono, purple, with a `>` prompt. */
function houseLine(text: string): HTMLElement {
  return h("p", { class: "mono a-house" }, [
    h("span", { class: "a-prompt", attrs: { "aria-hidden": "true" } }, [">"]),
    h("span", { text }),
  ]);
}

/**
 * The same line, built once and rewritten in place.
 *
 * The announcer's lines that arrive *during* play — the welcome, a banked
 * checkpoint — cannot be rebuilt on every frame: Plan / Apply repaints on
 * every tap in the room, and replacing a node under a cursor is how a click
 * lands on nothing.
 */
interface HouseSlot {
  readonly node: HTMLElement;
  set(text: string): void;
}

function houseSlot(className: string): HouseSlot {
  const body = h("span");
  const node = h("p", { class: `mono a-house ${className}` }, [
    h("span", { class: "a-prompt", attrs: { "aria-hidden": "true" } }, [">"]),
    body,
  ]);
  return {
    node,
    set: (text) => setText(body, text),
  };
}

/**
 * The keyboard hint, which is on screen because nobody guesses "press space".
 *
 * Hidden by CSS where the primary pointer is coarse — see `.a-keys` in
 * participant.css. A phone has no keys to press and the line would be noise;
 * the behaviour it describes is still there if a keyboard is attached.
 */
function keyHint(text: string): HTMLElement {
  return h("p", { class: "a-keys label", text });
}

/**
 * The round's rule, in one plain line, on the screen the whole time it is
 * being played. See `PLAY_RULE` for why it exists and what it may not say.
 *
 * Built once per scene and never rewritten: the text is a constant, so there
 * is nothing here for a repaint to change and nothing that could come to
 * depend on the state. A round with no line yet renders an empty, hidden
 * paragraph rather than a gap, so wiring one up later is a string.
 */
function playRule(text: string | undefined): HTMLElement {
  const node = h("p", { class: "p-rule", text: text ?? "" });
  node.hidden = text === undefined;
  return node;
}

/**
 * The backed runner's progress, as the two nodes that go under their chip.
 *
 * A bar and a mono line, and an empty array where there is nothing to say —
 * which is what lets both callers spread it into a chip they were building
 * anyway rather than branch around a hidden element. The bar is small and
 * carries no ticks: this is somebody else's round, and the checkpoint marks
 * belong on the bar of the person who is banking at them.
 *
 * The line is mono and 14 px against the card's own type, which is the phone's
 * scale for a tabular count and not the Desktop's — DESIGN.md's 32 px floor is
 * a rule about a 1080p tile seen through video compression, and applying it to
 * a phone held at arm's length would push the Lounge's chips off the screen.
 */
function backedLine(arcade: ArcadeView, mine: ArcadeMine): HTMLElement[] {
  const progress = backedProgress(arcade, mine);
  if (progress === null) return [];
  const out: HTMLElement[] = [];
  if (progress.fraction !== null) {
    const fill = h("div", { class: "a-backed-fill" });
    fill.style.width = `${(progress.fraction * 100).toFixed(1)}%`;
    out.push(
      h("div", { class: "a-backed-bar", attrs: { "aria-hidden": "true" } }, [fill]),
    );
  }
  out.push(h("p", { class: "mono a-backed-line", text: progress.line }));
  return out;
}

/**
 * Whether a keystroke belongs to something the person is typing into.
 *
 * The page-level key handlers are what make the keyboard work without first
 * tabbing to the right control, and the price of that reach is that they must
 * keep their hands off Recruitment's text field.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el === null || typeof el.tagName !== "string") return false;
  if (el.isContentEditable) return true;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

/**
 * The phone during the arcade.
 *
 * One interaction per round and the phone shows only that, which is
 * DESIGN.md's rule for every arcade screen. What it does show at all times is
 * the player number, top left, because it is the name the announcer uses.
 *
 * The drain is the one sequence with a shape of its own, and it is the
 * emotional core of the round: 400 ms of pink, then the rest of the round in
 * gold. Nobody's phone stays on the error.
 */
function sceneArcade(ctx: SceneCtx): Scene {
  const badgeNum = h("span", { class: "mono a-badge-num" });
  const badge = h("div", { class: "a-badge" }, [
    h("span", { class: "a-badge-label label", text: "Player" }),
    badgeNum,
  ]);
  const body = h("div", { class: "a-body" });
  const announce = h("p", {
    class: "sr-only",
    attrs: { role: "status", "aria-live": "assertive" },
  });
  /**
   * DESIGN.md's *entering the arcade* line: the first thing this phone is
   * told, and the only place the player number is spelled out in words.
   *
   * It lives outside `body` because `body` is replaced every time the
   * sub-screen changes, and the welcome has to survive the round card
   * arriving underneath it.
   */
  const welcome = houseSlot("a-welcome");
  welcome.node.hidden = true;
  const node = h("section", { class: "v v-arcade" }, [
    badge,
    welcome.node,
    body,
    announce,
  ]);

  /** Which sub-screen is built, so typing into the field is not eaten. */
  let built = "";
  /** The last light seen, so the haptic fires on the turn and not on repaint. */
  let lastLightAt: number | null = null;
  let lastStanding: "floor" | "drained" | null = null;
  /** Local resource count, so the button responds to the thumb, not the link. */
  let optimistic = 0;
  /** The last checkpoint announced, so the line is said once per crossing. */
  let lastCheckpoint: number | null = null;
  /** Latches the crossing line so a later frame does not re-announce it. */
  let lastPlace: number | null = null;
  /** True once a round has actually started: the welcome has been read. */
  let welcomed = false;
  /** Set for one paint when the live region holds something a mount must not eat. */
  let keepAnnounce = false;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  /** The Lounge list as last drawn, so a burst of frames does not rebuild it. */
  let loungeSignature = "";
  /** The bridge as last drawn, for the same reason. */
  let bridgeSignature = "";
  /** The step this phone has already committed to. One pane per step. */
  let stepSent: number | null = null;
  /** Which step the panes are currently showing, so a new one resets them. */
  let stepIndex = -1;
  /** The last step the focus ring was moved to. Once per step, never per frame. */
  let focusedStep = -1;
  /** Whether the two panes are a live control right now. */
  let glassOpen = false;
  /** How this phone left the bridge, latched at the transition — see paint(). */
  let glassExit: string | null = null;
  /** The waiting wave's chips as last drawn, so a frame does not rebuild them. */
  let glassBackSignature = "";
  /**
   * The last frame this scene drew.
   *
   * The rope reads it on an animation frame, between renders: the pulse is
   * drawn from `pullStartedAt` and `beatMs`, which arrive on a frame and then
   * sit still for a whole pull while the beat goes on ticking.
   */
  let seen: RenderState | null = null;

  /* ---- Recruitment ---- */
  const cue = h("p", { class: "a-cue", attrs: { "aria-hidden": "true" } });
  const cueRead = h("p", { class: "sr-only" });
  const field = h("input", {
    class: "field a-field",
    type: "text",
    attrs: {
      autocomplete: "off",
      autocorrect: "off",
      autocapitalize: "off",
      spellcheck: "false",
      enterkeyhint: "send",
      maxlength: "40",
      "aria-label": "The product these two emoji mean",
    },
  }) as HTMLInputElement;
  const submit = h("button", {
    class: "a-submit",
    type: "button",
    text: "Submit",
  }) as HTMLButtonElement;
  const recruitTimer = h("p", { class: "mono a-item-timer" });
  const recruitStatus = h("div", { class: "a-recruit-status" });
  const recruitNode = h("div", { class: "a-recruit" }, [
    recruitTimer,
    playRule(PLAY_RULE.recruitment),
    cue,
    cueRead,
    h("div", { class: "a-recruit-row" }, [field, submit]),
    keyHint(KEY_HINT.recruit),
    recruitStatus,
  ]);

  /**
   * The item clock, counted to the instant the server named.
   *
   * SPEC.md gives Recruitment six items at twenty seconds each and the board
   * ships seven, and this slot used to draw `arcade.endsAt` — the whole round
   * — so it read 00:17, 00:15,
   * 00:12 straight through an item change and told nobody how long they had
   * to type. Always an absolute epoch against the corrected clock, never a
   * duration: a phone that got the frame late still stops at the same instant.
   */
  const paintItemTimer = (arcade: ArcadeView): void => {
    const left = remainingMs(itemEndsAt(arcade.recruitment), ctx.now());
    setText(recruitTimer, left === null ? "" : formatCountdown(left));
    setClass(recruitTimer, "urgent", left !== null && left <= 5_000);
  };

  const sendAnswer = (item: number): void => {
    const typed = field.value.trim();
    if (typed === "" || field.disabled) return;
    field.disabled = true;
    submit.disabled = true;
    ctx.arcadeAnswer(item, typed);
  };
  submit.addEventListener("click", () => {
    const item = Number(submit.dataset["item"] ?? "-1");
    if (item >= 0) sendAnswer(item);
  });
  field.addEventListener("keydown", (ev) => {
    if ((ev as KeyboardEvent).key !== "Enter") return;
    const item = Number(submit.dataset["item"] ?? "-1");
    if (item >= 0) sendAnswer(item);
  });

  /* ---- Plan / Apply ---- */
  const barFill = h("div", { class: "a-bar-fill" });
  const barTicks = h("div", { class: "a-bar-ticks", attrs: { "aria-hidden": "true" } });
  const bar = h("div", { class: "a-bar" }, [
    h("div", { class: "a-bar-track" }, [barFill, barTicks]),
  ]);
  const bigWord = h("span", { class: "display a-big-word" });
  const bigGlyph = h("span", { class: "a-big-glyph", attrs: { "aria-hidden": "true" } });
  const bigCount = h("span", { class: "mono a-big-count" });
  const bigButton = h("button", {
    class: "a-big",
    type: "button",
  }, [bigGlyph, bigWord, bigCount]) as HTMLButtonElement;
  const planHouse = houseSlot("a-plan-house");
  planHouse.node.hidden = true;
  /** A new round has a fresh bridge: last round's commitment must not stick. */
  const resetBridge = (): void => {
    stepSent = null;
    stepIndex = -1;
    focusedStep = -1;
    glassOpen = false;
    bridgeSignature = "";
    glassExit = null;
    glassBackSignature = "";
  };

  /** A new round banks nothing yet, so last round's line must not linger. */
  const resetCheckpointLine = (): void => {
    lastCheckpoint = null;
    lastPlace = null;
    planHouse.node.hidden = true;
  };

  /** A new round is a new tin, and last round's shape must not stick. */
  const resetUnseal = (): void => {
    shapeSent = null;
    tileSignature = "";
    unsealOpen = false;
    unsealExit = null;
    unsealSaid = UNSEAL_NOTHING_SAID;
    unsealHouse.node.hidden = true;
    unsealPicker.dataset["sig"] = "";
    unsealSolved.dataset["sig"] = "";
  };

  /** …and a new rope, a new heartbeat and a count that starts at zero. */
  const resetTug = (): void => {
    tugPull = -1;
    tugOptimistic = 0;
    tugLocalBeat = -1;
    tugElectionSaid = 0;
    tugElectionLine.node.hidden = true;
    tugWins = [0, 0];
    tugPullLine.node.hidden = true;
  };
  const planNode = h("div", { class: "a-plan" }, [
    bar,
    // Above the button, not under it: the button fills the rest of the screen
    // and the rule has to be readable before the first light, not after it.
    playRule(PLAY_RULE.plan_apply),
    planHouse.node,
    bigButton,
    keyHint(KEY_HINT.tap),
  ]);

  /**
   * One tap. The single place a resource is added, whatever pressed it.
   *
   * Deliberately no check on the light: during APPLY this must fire and drain
   * you, exactly as a click does. A keyboard that could not lose the game
   * would be a keyboard that was not playing it.
   */
  const tapOnce = (): void => {
    if (bigButton.disabled) return;
    const round = Number(bigButton.dataset["round"] ?? "-1");
    if (round < 0) return;
    optimistic += 1;
    setText(bigCount, String(optimistic));
    ctx.arcadeTap(round);
  };

  /**
   * Set while a key is doing the work, so a click the browser synthesises from
   * that same keystroke is not counted twice.
   *
   * `preventDefault` on the keydown should stop the synthetic click on its
   * own, and in Chrome, Safari and Firefox it does — this is the belt to that
   * pair of braces, because a double-counted tap is silent, and under a race
   * to 120 nobody would ever notice it. Cleared by a real pointer, which is
   * what an actual click always begins with.
   */
  let swallowClick = false;
  bigButton.addEventListener("pointerdown", () => {
    swallowClick = false;
  });
  bigButton.addEventListener("click", () => {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    tapOnce();
  });

  /**
   * Space and Enter, from anywhere on the page while Plan / Apply is up.
   *
   * On the window rather than the button because nobody tabs to a control
   * before a race starts, and a key that works only after a click would be an
   * affordance that arrives too late to be one. It is attached only when this
   * view is live: the host console renders the same module as a 180 px
   * preview, and the console's own space bar drives the run of show.
   *
   * See `isTapKey` for why an OS key repeat is not a tap.
   */
  const onTapKey = (ev: KeyboardEvent): void => {
    if (built !== "plan" || isTypingTarget(ev.target)) return;
    const { handled, taps } = isTapKey(ev);
    if (!handled) return;
    // Always: the space bar must not scroll the page, and the browser must
    // not activate the focused button a second time.
    ev.preventDefault();
    if (!taps) return;
    swallowClick = true;
    tapOnce();
  };
  if (ctx.live) window.addEventListener("keydown", onTapKey);

  /* ---- The Glass Bridge ---- */

  /**
   * The bridge on the phone.
   *
   * Four things, in the order SPEC.md asks for them: whose turn it is, the
   * step's own clock, where everybody is standing, and — only while it is
   * your turn — the two panes. A wave that is waiting gets the first three
   * and no button, because SPEC.md is explicit that the asymmetry is the
   * point and that waiting for your wave has to be worth doing: what you are
   * doing is watching the bridge fill in and reading which panes break.
   */
  const glassWave = h("p", { class: "mono a-glass-wave" });
  const glassTimer = h("p", { class: "mono a-step-timer" });
  const glassBarFill = h("div", { class: "a-step-bar-fill" });
  const glassBar = h("div", { class: "a-step-bar", attrs: { "aria-hidden": "true" } }, [
    glassBarFill,
  ]);
  const bridge = h("div", { class: "a-bridge", role: "list" });
  const glassProduct = h("p", { class: "a-glass-product" });
  const glassPanes = h("div", { class: "a-panes" });
  const glassKeys = keyHint(KEY_HINT.glass);
  const glassStatus = h("p", { class: "a-glass-status" });
  /**
   * The waiting wave's bet.
   *
   * SPEC.md's design constraint is "nobody sits out", and this bridge was the
   * round that broke it: with three waves, two thirds of the room are on the
   * Floor with nothing to press for up to two minutes. So a wave that is
   * waiting backs a runner in the wave in front of them — the one they are
   * already watching — for half the Lounge's award. It is drawn above the
   * banked line because for those two minutes it is the only control on the
   * screen.
   */
  const glassBackHeld = h("div", { class: "a-lounge-backed", attrs: { hidden: true } });
  const glassBackList = h("div", { class: "a-lounge-list" });
  const glassBackPrompt = h("p", { class: "label a-lounge-prompt" });
  const glassBackNode = h(
    "div",
    { class: "a-glass-backing", attrs: { hidden: true } },
    [glassBackPrompt, glassBackHeld, glassBackList],
  );
  const glassBanked = h("p", { class: "mono a-glass-banked" });
  const glassNode = h("div", { class: "a-glass" }, [
    glassWave,
    glassTimer,
    glassBar,
    // Above the bridge, so it is on the screen of a wave that is still
    // waiting — which is the wave with the most time to read it and the one
    // that has not yet learned what the round is by losing it.
    playRule(PLAY_RULE.glass_bridge),
    bridge,
    glassProduct,
    glassPanes,
    glassKeys,
    glassStatus,
    glassBackNode,
    glassBanked,
  ]);

  /** The two pane buttons, built once: a list rebuilt under a cursor is a
   * click that lands on nothing, and this one is rebuilt on every frame the
   * room produces. */
  const paneButtons: HTMLButtonElement[] = [0, 1].map((side) => {
    const label = h("span", { class: "a-pane-label" });
    const mark = h("span", {
      class: "a-pane-key mono",
      attrs: { "aria-hidden": "true" },
      text: side === 0 ? "←" : "→",
    });
    const button = h(
      "button",
      {
        class: "a-pane",
        type: "button",
        attrs: { "data-side": side === 0 ? "left" : "right" },
      },
      side === 0 ? [mark, label] : [label, mark],
    ) as HTMLButtonElement;
    button.addEventListener("click", () => stepOn(side as 0 | 1));
    return button;
  });
  replace(glassPanes, paneButtons);

  /**
   * One step onto a pane. The single place a commitment is made, whatever
   * pressed it.
   *
   * Guarded by the button's own disabled state and by `stepSent`, which is
   * this phone's memory of having already committed: the server refuses a
   * second frame with `already_stepped`, but a person who pressed twice under
   * a six-second clock should see the first press take, not a refusal.
   */
  const stepOn = (choice: 0 | 1): void => {
    const round = Number(glassNode.dataset["round"] ?? "-1");
    const step = Number(glassNode.dataset["step"] ?? "-1");
    if (round < 0 || step < 0) return;
    if (stepSent === step || !glassOpen) return;
    stepSent = step;
    for (const b of paneButtons) b.disabled = true;
    setText(glassStatus, "You are on the pane.");
    setText(announce, "You are on the pane.");
    ctx.arcadeStep(round, step, choice);
  };

  /**
   * The two keys, from anywhere on the page while the bridge is up.
   *
   * On the window rather than the buttons because nobody tabs to a control
   * before a six-second clock starts, and a key that works only after a click
   * is an affordance that arrives too late to be one. Attached only when this
   * view is live: the console renders the same module as a 180 px preview,
   * and the console's own arrow keys walk the run of show.
   */
  const onPaneKey = (ev: KeyboardEvent): void => {
    if (built !== "glass" || !glassOpen || isTypingTarget(ev.target)) return;
    const side = paneKeyIndex(ev);
    if (side === null) return;
    // The page must not scroll sideways under an arrow key, and the browser
    // must not also activate whichever pane happens to have focus.
    ev.preventDefault();
    stepOn(side);
  };
  if (ctx.live) window.addEventListener("keydown", onPaneKey);

  const paintStepTimer = (arcade: ArcadeView): void => {
    const g = arcade.glass;
    const left = remainingMs(g?.stepEndsAt ?? null, ctx.now());
    setText(glassTimer, left === null ? "" : formatCountdown(left));
    // Wave 3 gets six seconds, so "urgent" is a third of the step rather than
    // trivia's flat five seconds — at six seconds a five-second warning is
    // the whole step.
    const span = (g?.stepEndsAt ?? 0) - (g?.stepStartedAt ?? 0);
    setClass(
      glassTimer,
      "urgent",
      left !== null && span > 0 && left <= Math.max(2_000, span / 3),
    );
    const f = stepFraction(g ?? {}, ctx.now());
    glassBarFill.style.width = `${(f ?? 0) * 100}%`;
  };

  /**
   * The bridge itself: one cell per step, two pane marks in each, and the
   * player numbers standing on them.
   *
   * A pane mark goes dark when the server says that pane broke — which it
   * only ever says for a step everybody who could use it has walked past, so
   * this row is the information wave 2 and wave 3 are promised and never the
   * answer to the step anybody is standing on.
   *
   * Rebuilt only when it changed: the room produces a frame per commitment
   * and a row rebuilt under a cursor is a click that lands on nothing.
   */
  const paintBridge = (state: RenderState, arcade: ArcadeView, mine: ArcadeMine): void => {
    const g = arcade.glass;
    if (!g) return;
    const { steps, across } = bridgeSteps(arcade, state.roster, g);
    const signature = [
      g.step,
      g.wave,
      mine.playerNumber,
      g.broken.join(""),
      steps.map((s) => s.standing.map((e) => e.tag).join("-")).join("/"),
      across.map((e) => e.tag).join("-"),
    ].join("|");
    if (signature === bridgeSignature) return;
    bridgeSignature = signature;

    const cell = (
      className: string,
      label: string,
      marks: readonly Node[],
      here: readonly BridgeEntry[],
      attrs: Record<string, string>,
    ): HTMLElement =>
      h("div", { class: className, role: "listitem", attrs }, [
        h("span", { class: "mono a-bridge-num", text: label }),
        ...marks,
        h(
          "span",
          { class: "a-bridge-who mono" },
          here.map((e) =>
            h("span", {
              class: "a-bridge-tag",
              text: e.tag,
              attrs: { "data-you": e.playerNumber === mine.playerNumber ? "yes" : "no" },
            }),
          ),
        ),
      ]);

    replace(bridge, [
      ...steps.map((s) =>
        cell(
          "a-bridge-step",
          String(s.index + 1),
          [
            h(
              "span",
              { class: "a-bridge-panes", attrs: { "aria-hidden": "true" } },
              [0, 1].map((side) =>
                h("span", {
                  class: "a-bridge-pane",
                  attrs: { "data-broken": s.broken === side ? "yes" : "no" },
                }),
              ),
            ),
          ],
          s.standing,
          {
            "data-open": s.open ? "yes" : "no",
            "aria-label": `Step ${s.index + 1}${
              s.broken === null
                ? ", nobody has fallen here"
                : `, the ${s.broken === 0 ? "left" : "right"} pane broke here`
            }${
              s.standing.length === 0
                ? ""
                : `, ${s.standing.map((e) => playerName(e.playerNumber)).join(", ")} standing`
            }`,
          },
        ),
      ),
      cell(
        "a-bridge-far",
        "▣",
        [],
        across,
        { "aria-label": `The far side, ${across.length} across` },
      ),
    ]);
  };

  const paintGlass = (state: RenderState, arcade: ArcadeView, mine: ArcadeMine): void => {
    const g = arcade.glass;
    if (!g) return;
    const fresh = built !== "glass";
    mount("glass", [glassNode]);
    const me = mine.glass;
    const wave = me?.wave ?? 3;
    const yourTurn = me?.onTheBridge === true && !me.committed;
    glassNode.dataset["round"] = String(arcade.roundIndex);
    glassNode.dataset["step"] = String(g.step ?? 0);
    // A new step is a fresh commitment: forget the last one.
    if (stepIndex !== g.step) {
      stepIndex = g.step ?? 0;
      stepSent = null;
    }
    glassOpen = yourTurn && ctx.live && stepSent !== g.step;

    setText(
      glassWave,
      [
        `WAVE ${wave} OF 3`,
        `${g.waveSeconds[wave - 1] ?? 0}s A STEP`,
        yourTurn
          ? "YOUR TURN"
          : me?.onTheBridge
            ? "COMMITTED"
            : me?.across
              ? "ACROSS"
              : `WAVE ${g.wave} IS CROSSING`,
      ].join(" · "),
    );
    setAttr(glassNode, "data-turn", yourTurn ? "yes" : "no");
    paintStepTimer(arcade);
    paintBridge(state, arcade, mine);

    const step = g.board?.[g.step ?? 0];
    setText(glassProduct, step?.product ?? "");
    glassProduct.hidden = step === undefined;
    const labels = step?.labels ?? ["", ""];
    paneButtons.forEach((button, side) => {
      const label = button.querySelector(".a-pane-label");
      if (label instanceof HTMLElement) setText(label, labels[side] ?? "");
      button.disabled = !glassOpen;
      setAttr(
        button,
        "aria-label",
        `${side === 0 ? "Left" : "Right"} pane: ${labels[side] ?? ""}`,
      );
    });
    // The panes are only a control while it is your turn. A waiting wave sees
    // the bridge and the clock; a committed player sees the pane they are
    // standing on and cannot take it back.
    glassPanes.hidden = !(me?.onTheBridge ?? false);
    glassKeys.hidden = !glassOpen;

    // The keys work from anywhere, but the focus ring is the only thing that
    // says *these two* are what you press. There is nothing else on this
    // screen to take focus from, and it is taken once per step rather than on
    // every frame the room produces.
    if (ctx.live && glassOpen && (fresh || focusedStep !== stepIndex)) {
      focusedStep = stepIndex;
      paneButtons[0]?.focus();
    }

    setText(
      glassStatus,
      me?.across
        ? HOUSE.glassCrossed(mine.playerNumber)
        : me?.onTheBridge
          ? me.committed
            ? "You are on the pane."
            : "Two panes. One is a real feature. Step on it."
          : `Wave ${g.wave} is on the bridge. Watch which panes break.`,
    );
    setText(
      glassBanked,
      `Step ${Math.min((me?.step ?? 0) + (me?.across ? 0 : 1), g.of)} of ${g.of} · banked ${mine.banked}`,
    );
    paintGlassBacking(state, arcade, mine, g);
  };

  /**
   * The bet a wave places while it waits, and the record of it afterwards.
   *
   * Two states and they are the same two the Lounge has: chips while the bet
   * can still be placed, and a line naming the runner once it cannot. The
   * window closes the moment anybody in the crossing wave stands on a pane,
   * because that is the moment the wave being bet on stops having learned
   * nothing: a fall is published as it happens, so one runner down is already
   * half the answer and the bet would be a reading of it. It is the same lock
   * the drained side has, read from the other end, and it is the engine's —
   * `onPanes` is carried on the wire so this draws no chip that backPlayer
   * would refuse.
   */
  const paintGlassBacking = (
    state: RenderState,
    arcade: ArcadeView,
    mine: ArcadeMine,
    g: NonNullable<ArcadeView["glass"]>,
  ): void => {
    const me = mine.glass;
    // Drained players are in the Lounge, which is a screen of its own. This
    // is for the ones still on the Floor who cannot act: a wave that has not
    // walked on yet, and a wave that is already across.
    const waiting =
      arcade.phase === "running" &&
      mine.standing === "floor" &&
      me !== undefined &&
      me.wave !== g.wave;
    glassBackNode.hidden = !waiting;
    if (!waiting) {
      glassBackSignature = "";
      return;
    }
    const backing = mine.backing ?? null;
    const runners = glassCrossing(arcade, state.roster, g);
    const untouched = (g.step ?? 0) === 0 && (g.onPanes ?? 0) === 0;
    const open = backing === null && untouched && ctx.live;
    const held = gridEntries(arcade, state.roster).find((e) => e.pid === backing);
    setText(
      glassBackPrompt,
      backing !== null
        ? "Your bet"
        : untouched
          ? `Back a runner in wave ${g.wave}`
          : `Wave ${g.wave} has stepped. Bets are closed.`,
    );
    // `position[backing]` is in the signature because the bet's own line is
    // drawn from it: a waiting wave's runner advancing is the one thing on this
    // panel that moves, and without it the panel would hold a stale pane
    // number until the crossing wave's step index happened to change.
    const signature = `${open}:${backing ?? ""}:${g.wave}:${g.step ?? 0}:${g.onPanes ?? 0}:${
      backing === null ? "" : (g.position?.[backing] ?? 0)
    }:${runners.map((e) => `${e.pid}/${e.standing}/${e.backers}/${e.away}`).join(",")}`;
    if (signature === glassBackSignature) return;
    glassBackSignature = signature;
    glassBackHeld.hidden = held === undefined;
    if (held) {
      replace(glassBackHeld, [
        h("span", { class: "mono a-chip-num", text: held.tag }),
        h("span", { class: "a-chip-name", text: held.nickname }),
        h("span", { class: "a-chip-backers", text: "the bet stands" }),
        ...backedLine(arcade, mine),
      ]);
    }
    replace(
      glassBackList,
      backing !== null
        ? []
        : runners.map((e) => {
            const chip = h(
              "button",
              { class: "a-chip", type: "button", disabled: !open },
              [
                h("span", { class: "mono a-chip-num", text: e.tag }),
                h("span", { class: "a-chip-name", text: e.nickname }),
                e.backers > 0
                  ? h("span", { class: "mono a-chip-backers", text: `×${e.backers}` })
                  : null,
              ],
            );
            chip.addEventListener("click", () => ctx.arcadeBack(e.pid));
            return chip;
          }),
    );
  };

  /* ---- Unseal ---- */

  /**
   * The tin, on the phone.
   *
   * Two screens in one, and which one is up is decided by whether this player
   * is holding a tin: the picker, and then the letters. DESIGN.md asks for
   * "shape picker (four large tiles), then a grid of scrambled letters as
   * ≥ 56 px tiles, the solved letters filling in a row above", and that is
   * what this is.
   *
   * The picker shows the four glyphs and what each one **pays**, and nothing
   * about how long the word is. That is not a detail: SPEC.md's whole conceit
   * is "pick your shape before you know the word", the shapes *are* the word
   * lengths, and learning which is which is exactly what the pick buys. The
   * score is the other half of the same sentence — it is the bet, stated in
   * advance, so the choice is informed about the stake and blind about the
   * risk, which is the only arrangement that makes it a choice at all.
   */
  const unsealTimer = h("p", { class: "mono a-item-timer" });
  const unsealPicker = h("div", { class: "a-shapes", role: "radiogroup" });
  const unsealSolved = h("div", { class: "a-solved mono", role: "group" });
  const unsealTileRow = h("div", { class: "a-tiles" });
  const unsealKeys = keyHint(KEY_HINT.unseal);
  const unsealStatus = h("p", { class: "a-unseal-status" });
  /**
   * The briefing, on the picker.
   *
   * Unseal is the one round whose card the phone does not show — the picker
   * takes its place, because the card's instruction *is* a control and
   * twenty seconds of "choose a shape" with nothing to choose with would be
   * the worst version of this round. But the briefing is the half of the card
   * that matters most to somebody who joined late, so it comes with it. It
   * comes off the moment the tin opens: by then the round has started and
   * the three lines are in the way of the letters.
   */
  const unsealHow = h(
    "div",
    { class: "a-how a-unseal-how" },
    HOW_TO_PLAY.unseal.map((line) => h("p", { class: "a-how-line", text: line })),
  );
  const unsealHouse = houseSlot("a-unseal-house");
  unsealHouse.node.hidden = true;
  /**
   * **Read the docs.**
   *
   * DESIGN.md asks for "a small mono link, deliberately un-button-like, at
   * the bottom", and SPEC.md calls it the funniest button in the product. The
   * two are the same instruction read from different ends and they agree on
   * the thing that matters: it must not look like the way to play. It looks
   * like a link in a docs site because that is the joke — and the price is
   * printed on it, in the same size as the label, because a decision whose
   * cost is somewhere else is not a decision, it is a trap.
   *
   * Pressing it again is free: the halving is a boolean and the second letter
   * costs nothing, which is the show's own point about the honeycomb. So the
   * label changes once it has been pressed and says so, rather than quietly
   * charging nothing and letting the player wonder.
   */
  const docsLabel = h("span", { class: "a-docs-label" });
  const docsPrice = h("span", { class: "a-docs-price mono" });
  const docsButton = h("button", { class: "a-docs", type: "button" }, [
    docsLabel,
    docsPrice,
  ]) as HTMLButtonElement;
  const unsealNode = h("div", { class: "a-unseal" }, [
    unsealTimer,
    playRule(PLAY_RULE.unseal),
    unsealHouse.node,
    unsealPicker,
    unsealHow,
    unsealSolved,
    unsealTileRow,
    unsealKeys,
    unsealStatus,
    docsButton,
  ]);

  /** The shape this phone has asked for, held until the server agrees. */
  let shapeSent: UnsealShape | null = null;
  /** The cue the tiles are drawn from, so a burst of frames does not rebuild them. */
  let tileSignature = "";
  /** Set while a key is doing the work, so the synthetic click is not a second tap. */
  let swallowLetterClick = false;
  /** Whether the letters are a live control right now. */
  let unsealOpen = false;
  /** Latched when the tin shatters, for the Lounge underneath. See paint(). */
  let unsealExit: string | null = null;
  /**
   * Which of the tin's three beats this round has already said.
   *
   * Each is said once per round rather than on every repaint, and the later of
   * any two that land together wins the slot. That ordering is
   * {@link unsealSlot}, which is pure and has a test; this is only the latch it
   * reads and writes.
   */
  let unsealSaid: UnsealSaid = UNSEAL_NOTHING_SAID;

  const unsealRound = (): number =>
    Number(unsealNode.dataset["round"] ?? "-1");

  const pickShape = (shape: UnsealShape): void => {
    const round = unsealRound();
    if (round < 0 || !ctx.live) return;
    shapeSent = shape;
    ctx.arcadeShape(round, shape);
    if (seen !== null) paint(seen);
  };

  const tapLetter = (letter: string): void => {
    const round = unsealRound();
    if (round < 0 || !unsealOpen) return;
    ctx.arcadeLetter(round, letter);
  };

  docsButton.addEventListener("click", () => {
    const round = unsealRound();
    if (round < 0 || docsButton.disabled) return;
    ctx.arcadeDocs(round);
  });

  /**
   * Type a letter to tap it.
   *
   * On the window rather than on the tiles, for the reason the bridge's
   * arrows are: nobody tabs through fourteen scrambled letters under a
   * sixty-second clock, and a key that works only after a click is an
   * affordance that arrives too late to be one. A held key is not a stream —
   * see `unsealLetterKey` — which matters more here than anywhere, because in
   * this round the second tap of a repeat is always the wrong letter.
   */
  const onLetterKey = (ev: KeyboardEvent): void => {
    if (built !== "unseal" || !unsealOpen || isTypingTarget(ev.target)) return;
    const letter = unsealLetterKey(ev);
    if (letter === null) return;
    ev.preventDefault();
    swallowLetterClick = true;
    tapLetter(letter);
  };
  if (ctx.live) window.addEventListener("keydown", onLetterKey);

  const paintUnsealTimer = (arcade: ArcadeView): void => {
    const left = remainingMs(arcade.endsAt, ctx.now());
    setText(unsealTimer, left === null ? "" : formatCountdown(left));
    setClass(unsealTimer, "urgent", left !== null && left <= 10_000);
  };

  const paintUnseal = (arcade: ArcadeView, mine: ArcadeMine): void => {
    const u = arcade.unseal;
    if (!u) return;
    mount("unseal", [unsealNode]);
    unsealNode.dataset["round"] = String(arcade.roundIndex);
    const me = mine.unseal;
    const shape = me?.shape ?? shapeSent;
    const open = arcade.phase === "running";
    paintUnsealTimer(arcade);

    // The picker. It is up while nobody is holding a tin, and while the round
    // card is up it stays up even after a pick, because a shape chosen
    // against the card may still be changed — that is the engine's rule and
    // the screen has to agree with it or the button lies.
    const picking = me?.cue === null || me?.cue === undefined;
    unsealPicker.hidden = !picking;
    unsealHow.hidden = !picking;
    if (picking) {
      const signature = `${shape ?? ""}:${open}:${u.shapes
        .map((sh) => `${sh.shape}${sh.available ? 1 : 0}${sh.picked}`)
        .join(",")}`;
      if (unsealPicker.dataset["sig"] !== signature) {
        unsealPicker.dataset["sig"] = signature;
        replace(
          unsealPicker,
          u.shapes.map((sh) => {
            const face = UNSEAL_FACE[sh.shape];
            const on = shape === sh.shape;
            const tile = h(
              "button",
              {
                class: on ? "a-shape on" : "a-shape",
                type: "button",
                disabled: !ctx.live || !sh.available,
                attrs: {
                  role: "radio",
                  "aria-checked": on ? "true" : "false",
                  // The glyph is decoration to a screen reader; this is the
                  // sentence it reads instead.
                  "aria-label": `${face.name}, worth ${sh.score}`,
                },
              },
              [
                h("span", {
                  class: "a-shape-glyph",
                  attrs: { "aria-hidden": "true" },
                  text: face.glyph,
                }),
                h("span", { class: "a-shape-name", text: face.name }),
                h("span", { class: "mono a-shape-score", text: String(sh.score) }),
              ],
            ) as HTMLButtonElement;
            tile.addEventListener("click", () => pickShape(sh.shape));
            return tile;
          }),
        );
      } else {
        // Only the selection moved. Repainting the row under a thumb that is
        // choosing is how a tap lands on nothing.
        for (const tile of Array.from(unsealPicker.children)) {
          const name = tile.querySelector(".a-shape-name")?.textContent ?? "";
          const on = shape !== null && UNSEAL_FACE[shape].name === name;
          tile.classList.toggle("on", on);
          setAttr(tile as HTMLElement, "aria-checked", on ? "true" : "false");
        }
      }
    }

    // The letters. `cue` is null until the Floor opens — the tin is handed
    // over at the pick and opened when the round starts — so this whole half
    // is simply absent until there is something in it.
    const cue = me?.cue ?? null;
    const solved = me?.solved ?? "";
    const length = me?.length ?? 0;
    const unsealed = me?.unsealed === true;
    unsealOpen = cue !== null && !unsealed && open && ctx.live;

    unsealSolved.hidden = cue === null;
    unsealTileRow.hidden = cue === null;
    unsealKeys.hidden = !unsealOpen;
    docsButton.hidden = cue === null || unsealed;

    if (cue !== null) {
      // The solved row: what they have tapped, and a blank for every letter
      // still to come. The blanks are how long the word is, which they were
      // told the moment they picked — the shape *was* the length.
      const solvedSig = `${solved}/${length}`;
      if (unsealSolved.dataset["sig"] !== solvedSig) {
        unsealSolved.dataset["sig"] = solvedSig;
        replace(
          unsealSolved,
          Array.from({ length }, (_, i) =>
            h("span", {
              class: "a-slot",
              text: solved[i] ?? "",
              attrs: { "data-filled": i < solved.length ? "yes" : "no" },
            }),
          ),
        );
        setAttr(
          unsealSolved,
          "aria-label",
          `${solved.length} of ${length} letters: ${[...solved].join(" ")}`,
        );
      }

      const tiles = unsealTiles(cue, solved);
      const signature = `${cue}|${solved}|${unsealOpen}`;
      if (signature !== tileSignature) {
        tileSignature = signature;
        replace(
          unsealTileRow,
          tiles.map((tile) => {
            const button = h(
              "button",
              {
                class: "a-tile",
                type: "button",
                disabled: !unsealOpen || tile.used,
                attrs: {
                  "data-used": tile.used ? "yes" : "no",
                  "aria-label": tile.used
                    ? `${tile.letter}, already used`
                    : tile.letter,
                },
              },
              [h("span", { class: "a-tile-letter", text: tile.letter })],
            ) as HTMLButtonElement;
            button.addEventListener("click", () => {
              if (swallowLetterClick) {
                swallowLetterClick = false;
                return;
              }
              tapLetter(tile.letter);
            });
            button.addEventListener("pointerdown", () => {
              swallowLetterClick = false;
            });
            return button;
          }),
        );
      }
    }

    // The docs button: its price, and what it says once it has been pressed.
    //
    // A cracked tin is already halved by the same rule the button is priced
    // with — one halving, however the tin came to be damaged — so the price
    // drops for a player who cracked without ever pressing this. The label is
    // still "Read the docs", because they have not read them; what has changed
    // is what the next press costs, and that is what the price says.
    const read = me?.docs === true;
    const halved = read || me?.cracked === true;
    setText(docsLabel, read ? "Read the docs again" : "Read the docs");
    setText(
      docsPrice,
      halved ? "already halved — this one is free" : "reveals the next letter · halves your score",
    );
    docsButton.disabled = !unsealOpen;
    setAttr(docsButton, "data-read", read ? "yes" : "no");
    // The tin's three beats, all of which land in one House slot: reading the
    // docs, the crack, and the word coming out.
    //
    // *Reading the docs. Score halved. Nobody will know.* — the price, said
    // once, because the halving is a number only this phone and the console
    // ever see.
    //
    // *The tin has cracked. Score halved. One more wrong letter shatters it.*
    // — the beat the round is two strikes for.
    //
    // *Sealed: false.* — the other end of the same tin, which the round used
    // not to narrate at all: losing a tin put a line on this screen and on the
    // big one, and getting a word out said nothing, which is a House that only
    // speaks when somebody loses.
    //
    // Each said once, and the last of them to happen wins the slot. Both of
    // those are {@link unsealSlot}, because they are the decision here and the
    // letters are still live underneath the first two — a repaint that re-set
    // the slot would re-announce a warning to a screen reader on every frame.
    const slot = unsealSlot(
      { docs: read, cracked: me?.cracked === true, opened: unsealed },
      unsealSaid,
    );
    unsealSaid = slot.said;
    if (slot.line !== null) {
      unsealHouse.node.hidden = false;
      unsealHouse.set(slot.line);
      setText(announce, slot.line);
    }

    setText(
      unsealStatus,
      cue === null
        ? shape === null
          ? "Pick a shape. You will not see the word until you do."
          : open
            ? "Your tin is on its way."
            : `${UNSEAL_FACE[shape].name}. You may change your mind until the round starts.`
        : unsealed
          ? `The tin is open. Banked ${mine.banked}.`
          : me?.cracked === true
            ? `${length} letters, and one more wrong one shatters the tin.`
            : `${length} letters. Tap them in order.`,
    );
  };

  /* ---- Tug of Raft ---- */

  /**
   * The rope, on the phone.
   *
   * DESIGN.md: "a pulsing ring at 100 bpm, the whole lower half is the tap
   * target, a strip showing your side's colour and the rope position". This
   * is that, with one addition DESIGN could not have known it needed: a
   * **key**. The participant surface is a laptop, and a rhythm game played by
   * travelling a trackpad and clicking is a different and worse game — the
   * click travel is a real fraction of a 600 ms beat, and three missed beats
   * is a timeout rather than a lost point.
   *
   * Everything that moves here is drawn from `pullStartedAt` and `beatMs`
   * against the corrected server clock. This surface starts **no clock of its
   * own**: the animation frame asks "where is the server's beat now" and
   * draws that. A local `setInterval(600)` would be a second clock, would
   * begin wherever the frame happened to land, and would drift a little
   * further from the grid the taps are judged against with every beat of the
   * pull — inviting taps at instants the server is not counting, in the one
   * round whose entire purpose is that everybody is capped at the same rate.
   */
  const tugHead = h("p", { class: "mono a-tug-head" });
  const tugRopeFill = h("div", { class: "a-tug-rope-fill" });
  const tugRopeKnot = h("div", { class: "a-tug-knot", attrs: { "aria-hidden": "true" } });
  const tugRopeBar = h("div", { class: "a-tug-rope", role: "img" }, [
    tugRopeFill,
    tugRopeKnot,
  ]);
  const tugRing = h("div", { class: "a-tug-ring", attrs: { "aria-hidden": "true" } });
  const tugWord = h("span", { class: "display a-tug-word", text: "PULL" });
  const tugCount = h("span", { class: "mono a-tug-count" });
  const tugButton = h("button", { class: "a-tug-tap", type: "button" }, [
    tugRing,
    tugWord,
    tugCount,
  ]) as HTMLButtonElement;
  const tugStatus = h("p", { class: "a-tug-status" });
  const tugElectionLine = houseSlot("a-tug-election");
  tugElectionLine.node.hidden = true;
  /**
   * The pull that just closed, which the round had no line for at all.
   *
   * Its own slot rather than the election's, because the two are about
   * different things and both can be true at once: a node can be sitting out
   * an election it called on the beat the rope came down. The election line is
   * driven from the animation frame and is hidden the instant the election
   * ends; a result stays up until there is another one.
   */
  const tugPullLine = houseSlot("a-tug-pull");
  tugPullLine.node.hidden = true;
  const tugNode = h("div", { class: "a-tug" }, [
    tugHead,
    playRule(PLAY_RULE.tug_of_raft),
    tugRopeBar,
    tugPullLine.node,
    tugElectionLine.node,
    tugButton,
    keyHint(KEY_HINT.tug),
    tugStatus,
  ]);

  /** The animation frame that draws the pulse. Null when the rope is not up. */
  let tugFrame: number | null = null;
  /** The last beat this phone credited itself, so one beat is one pull. */
  let tugLocalBeat = -1;
  /** Local count, so the button answers the finger rather than the link. */
  let tugOptimistic = 0;
  /** Which pull the local count belongs to; a new pull starts from zero. */
  let tugPull = -1;
  /** Whether the election line has been said for the election in force. */
  let tugElectionSaid = 0;
  /** Pulls won per side as of the last frame, so a change is a result. */
  let tugWins: readonly [number, number] = [0, 0];
  let swallowTugClick = false;

  const pullOnce = (): void => {
    const round = Number(tugNode.dataset["round"] ?? "-1");
    if (round < 0 || !ctx.live) return;
    const a = seen?.arcade;
    const t = a?.tug;
    if (!t || a?.phase !== "running") return;
    // Judged locally as well, and only so the button can answer immediately:
    // the server's verdict is the one that counts and arrives on the next
    // frame. Judging it here off the *same grid* is why the two agree — this
    // is the server's `beatMs` and the server's tolerance, not a guess.
    const beat = tugBeatAt(t, ctx.now());
    const election = tugElectionAt(t, seen?.arcadeMine?.tug?.lastBeat ?? -1, ctx.now());
    if (beat !== null && beat.onBeat && !election.inElection && beat.beat > tugLocalBeat) {
      tugLocalBeat = beat.beat;
      tugOptimistic += 1;
      setAttr(tugButton, "data-hit", "yes");
    } else {
      setAttr(tugButton, "data-hit", "no");
    }
    ctx.arcadeBeat(round);
  };

  tugButton.addEventListener("pointerdown", () => {
    swallowTugClick = false;
  });
  tugButton.addEventListener("click", () => {
    if (swallowTugClick) {
      swallowTugClick = false;
      return;
    }
    pullOnce();
  });

  /**
   * Space and Enter, from anywhere on the page while the rope is up.
   *
   * The same control as the button, not a second one — `isTapKey` is what
   * Plan / Apply uses and it rejects the OS key repeat, which here would be
   * thirty taps a second against a beat you can only hit once. On the window
   * because nobody tabs to a control before a heartbeat starts.
   */
  const onPullKey = (ev: KeyboardEvent): void => {
    if (built !== "tug" || isTypingTarget(ev.target)) return;
    const { handled, taps } = isTapKey(ev);
    if (!handled) return;
    ev.preventDefault();
    if (!taps) return;
    swallowTugClick = true;
    pullOnce();
  };
  if (ctx.live) window.addEventListener("keydown", onPullKey);

  const stopTugFrame = (): void => {
    if (tugFrame !== null) cancelAnimationFrame(tugFrame);
    tugFrame = null;
  };

  /**
   * The pulse, every animation frame, off the server's grid and nothing else.
   *
   * `--pulse` runs 1 at the beat down to 0 just before the next one, which is
   * a ring that snaps open and closes: the snap is the beat, and a sine or a
   * fade would put the loudest moment of the animation somewhere that is not
   * the instant a tap counts. `--window` is the real tolerance from the
   * server, so the band the ring shows is the band the engine judges by.
   */
  const paintTugPulse = (): void => {
    const a = seen?.arcade;
    const t = a?.tug;
    if (!t || a?.phase !== "running") return;
    const now = ctx.now();
    const beat = tugBeatAt(t, now);
    if (beat === null) return;
    tugButton.style.setProperty("--pulse", (1 - beat.phase).toFixed(3));
    tugButton.style.setProperty("--window", (t.toleranceMs / t.beatMs).toFixed(3));
    setAttr(tugButton, "data-beat", beat.onBeat ? "on" : "off");
    const election = tugElectionAt(t, seen?.arcadeMine?.tug?.lastBeat ?? -1, now);
    setAttr(tugNode, "data-election", election.inElection ? "yes" : "no");
    tugElectionLine.node.hidden = !election.inElection;
    if (election.inElection && tugElectionSaid !== election.endsAt) {
      tugElectionSaid = election.endsAt;
      const line = HOUSE.tugElection(seen?.arcadeMine?.playerNumber ?? 0);
      tugElectionLine.set(line);
      setText(announce, line);
    }
    tugFrame = requestAnimationFrame(paintTugPulse);
  };

  const paintTug = (state: RenderState, arcade: ArcadeView, mine: ArcadeMine): void => {
    const t = arcade.tug;
    if (!t) return;
    mount("tug", [tugNode]);
    tugNode.dataset["round"] = String(arcade.roundIndex);
    const me = mine.tug;
    const side = me?.side ?? 0;
    // A new pull is a new rope, a new heartbeat and a leader who has to earn
    // it again — so the local count starts from nothing too.
    if (tugPull !== t.pull) {
      tugPull = t.pull;
      tugOptimistic = 0;
      tugLocalBeat = -1;
      tugElectionSaid = 0;
    }
    // *Side A has the rope. The entry is committed.*
    //
    // A diff against the last frame's `wins`, which is {@link tugPullWinner} —
    // pure, and tested, because what it does *not* say is the part that matters:
    // a level pull, a frame with no change, and a `wins` that has gone back to
    // zero for a new round are all silence.
    const won = tugPullWinner(tugWins, t.wins);
    if (won !== null) {
      const line = HOUSE.tugPullWon(won);
      tugPullLine.node.hidden = false;
      tugPullLine.set(line);
      setText(announce, line);
    }
    tugWins = t.wins;
    const left = remainingMs(t.pullEndsAt ?? null, ctx.now());
    setText(
      tugHead,
      [
        `PULL ${t.pull + 1} OF ${t.pulls}`,
        `SIDE ${side === 0 ? "A" : "B"}`,
        `WON ${t.wins[0]}–${t.wins[1]}`,
        left === null ? null : formatCountdown(left),
      ]
        .filter((x) => x !== null)
        .join(" · "),
    );
    setAttr(tugNode, "data-side", side === 0 ? "a" : "b");

    // The rope. `tugRope` is the *share* of the on-beat taps rather than the
    // difference, so it needs no scale and cannot pin against the stop in the
    // first five seconds because one side started faster. 0 is side A's end.
    const at = tugRope(t.totals);
    tugRopeFill.style.width = `${at * 100}%`;
    tugRopeKnot.style.left = `${at * 100}%`;
    setAttr(
      tugRopeBar,
      "aria-label",
      t.totals[0] === t.totals[1]
        ? `The rope is level, ${t.totals[0]} pulls each`
        : `Side ${t.totals[0] > t.totals[1] ? "A" : "B"} is ahead, ${t.totals[0]} to ${t.totals[1]}`,
    );

    const server = me?.onBeats ?? 0;
    if (server > tugOptimistic) tugOptimistic = server;
    setText(tugCount, String(Math.max(server, tugOptimistic)));
    tugButton.disabled = !ctx.live || arcade.phase !== "running";
    setAttr(tugButton, "aria-label", "Pull on the beat");
    setText(
      tugStatus,
      arcade.phase === "running"
        ? `You are on side ${side === 0 ? "A" : "B"}. Banked ${mine.banked}.`
        : "The heartbeat starts when the round does.",
    );

    // The pulse runs on its own frame loop while the rope is up, and only
    // then: this is the one surface in the product with an animation that has
    // to be exact, and the one place a stray loop would keep running behind
    // another round.
    stopTugFrame();
    if (arcade.phase === "running") tugFrame = requestAnimationFrame(paintTugPulse);
    void state;
  };

  /* ---- the drain, and the Lounge ---- */
  const drainNode = h("div", { class: "a-drain" }, [
    h("p", { class: "mono a-drain-error", text: STATE_LOCK_ERROR }),
    h("p", { class: "mono a-drain-who" }),
  ]);
  const loungeList = h("div", { class: "a-lounge-list" });
  const loungeBacked = h("div", { class: "a-lounge-backed", attrs: { hidden: true } });
  const loungeMirror = h("div", { class: "a-mirror", attrs: { "aria-hidden": "true" } });
  const loungeNode = h("div", { class: "a-lounge" }, [
    h("p", { class: "a-lounge-kicker" }, [
      h("span", { class: "a-lounge-mark", attrs: { "aria-hidden": "true" }, text: "▣" }),
      h("span", { class: "label", text: "VIP Lounge" }),
    ]),
    h("p", { class: "a-lounge-line", text: "Your allocations have been rescheduled." }),
    loungeBacked,
    h("p", { class: "label a-lounge-prompt", text: "Back a player" }),
    loungeList,
    // The grid has a name — DESIGN.md calls it the dormitory — and on a
    // laptop it sits in a column beside the chips rather than underneath
    // them, where an unlabelled block of player numbers is a puzzle.
    h("p", { class: "label a-mirror-label", text: "Dormitory" }),
    loungeMirror,
  ]);

  const mount = (key: string, children: readonly Node[]): void => {
    if (built === key) return;
    // The rope's animation frame belongs to the rope. Leaving it running
    // behind the Lounge, the reveal or the next round would be a loop nobody
    // can see that never stops — and it reads the state on every frame.
    if (built === "tug" && key !== "tug") stopTugFrame();
    built = key;
    // A live region's message belongs to the screen that produced it. Without
    // this, "State locked. Do not tap." was still sitting in the status when
    // the round ended and the reveal came up — a screen reader reading out a
    // warning about a light that is no longer on.
    if (!keepAnnounce) setText(announce, "");
    replace(body, children);
  };

  /* ---- the sub-screens ---- */

  const paintCard = (arcade: ArcadeView): void => {
    const round = arcade.round;
    const lines = round ? ARCADE_ROUND_CARD[round] : ARCADE_ROUND_CARD.recruitment;
    mount(`card:${round ?? "none"}`, [
      h("div", { class: "a-card" }, [
        // The stairwell is DESIGN.md's one indulgence and it is behind the
        // round card only — never behind gameplay, never on the phone during
        // play, because it would eat contrast.
        h("div", { class: "a-stair", attrs: { "aria-hidden": "true" } }),
        h("div", { class: "a-card-shapes", attrs: { "aria-hidden": "true" } }, [
          h("span", { text: "○" }),
          h("span", { text: "△" }),
          h("span", { text: "□" }),
        ]),
        ...lines.map((line) => houseLine(line)),
        // How to play, under the announcer's lines and in a plainer voice.
        // The room has not played this before, and the twenty seconds the card
        // is up is the only moment everybody is looking at the same thing and
        // nobody is under a timer.
        ...(round
          ? [
              h(
                "div",
                { class: "a-how" },
                HOW_TO_PLAY[round].map((line) => h("p", { class: "a-how-line", text: line })),
              ),
            ]
          : []),
        // The card that explains the masks appears once, before Game 1.
        ...(round === "plan_apply"
          ? [
              h(
                "p",
                { class: "mono a-staff" },
                STAFF_CARD.map((l) => h("span", { class: "a-staff-line", text: l })),
              ),
            ]
          : []),
      ]),
    ]);
  };

  const paintRecruitment = (state: RenderState, arcade: ArcadeView, mine: ArcadeMine): void => {
    const r = arcade.recruitment;
    if (!r) return;
    mount("recruit", [recruitNode]);
    if (submit.dataset["item"] !== String(r.at)) {
      // A new item: a fresh field, and the keyboard stays up.
      submit.dataset["item"] = String(r.at);
      field.value = "";
      field.disabled = !ctx.live;
      submit.disabled = !ctx.live;
      if (ctx.live) field.focus();
    }
    setText(cue, r.cue ?? "···");
    // The emoji are `aria-hidden`; this is the same question in words, because
    // two pictographs read aloud are not a question.
    setText(cueRead, `Item ${r.at + 1} of ${r.of}. Which product do these two emoji mean?`);
    paintItemTimer(arcade);

    const locked = mine.recruitment?.state === "locked";
    if (locked) {
      field.disabled = true;
      submit.disabled = true;
    }
    const correct = mine.recruitment?.state === "locked" && mine.recruitment.correct;
    replace(recruitStatus, [
      locked
        ? correct
          ? houseLine(HOUSE.recruited)
          : h("p", { class: "label a-locked", text: "Locked in." })
        : h("p", { class: "label a-locked", text: "Type it. One answer." }),
    ]);
    setText(announce, locked ? (correct ? HOUSE.recruited : "Locked in.") : "");
    void state;
  };

  const paintPlan = (arcade: ArcadeView, mine: ArcadeMine): void => {
    const pa = arcade.planApply;
    if (!pa) return;
    const fresh = built !== "plan";
    mount("plan", [planNode]);
    bigButton.dataset["round"] = String(arcade.roundIndex);
    // The keys work from anywhere, but the focus ring is the only thing that
    // says *this* is what they press. There is nothing else on this screen to
    // take focus from.
    if (fresh && ctx.live) bigButton.focus();

    const face = LIGHT_FACE[pa.light];
    const server = mine.planApply?.resources ?? 0;
    if (server > optimistic) optimistic = server;
    const shown = Math.max(server, optimistic);

    setText(bigWord, face.button);
    setText(bigGlyph, face.glyph);
    setText(bigCount, String(shown));
    bigButton.style.setProperty("--light", face.fill);
    bigButton.style.setProperty("--light-ink", face.on);
    setAttr(bigButton, "data-light", pa.light);
    // The button stays LIVE during APPLY, and that is the whole round.
    //
    // DESIGN says "pink with LOCKED and nothing to tap", and disabling it is
    // the literal reading — but it takes the game away. Red Light, Green Light
    // is a test of self-control: you must be *able* to tap when you should
    // not, or there is no light to obey. With the button disabled the only
    // people ever drained are those whose tap left a phone still showing green
    // and arrived more than the 250 ms grace after the lock — that is, people
    // on bad connections, which inverts the fairness the grace exists for.
    // SPEC is unambiguous — "During APPLY, any tap is Error: state lock held
    // by another process and you are drained" — and SPEC wins.
    //
    // `aria-disabled` rather than `disabled`, so assistive tech is told this
    // is not something to press while the element stays operable. The other
    // three signals — word, glyph, hatched fill — already carry the state
    // without relying on colour.
    bigButton.disabled = !ctx.live;
    setAttr(bigButton, "aria-disabled", pa.light === "apply" ? "true" : "false");
    setAttr(bigButton, "aria-label", face.announce);

    const { fraction, ticks } = resourceBar(pa, shown);
    barFill.style.width = `${fraction * 100}%`;
    if (barTicks.childElementCount !== ticks.length) {
      replace(
        barTicks,
        ticks.map((t) =>
          h("span", { class: "a-tick", attrs: { style: `left:${t * 100}%` } }),
        ),
      );
    }
    setAttr(bar, "aria-label", `${shown} of ${pa.target} resources`);

    // The checkpoint, in the announcer's voice. DESIGN.md's register asks for
    // it and nothing said it: you banked five points three times in a round
    // and the phone never mentioned it.
    //
    // Counted off `server` and never off `optimistic`. Banking is a fact about
    // the server's count, and a line fired on a tap that was later refused
    // would be the phone telling you that you have points you do not have.
    const banked = latestCheckpoint(pa.checkpoints, server);
    if (banked !== lastCheckpoint) {
      lastCheckpoint = banked;
      planHouse.node.hidden = banked === null;
      if (banked !== null) {
        planHouse.set(HOUSE.checkpoint(banked));
        setText(announce, HOUSE.checkpoint(banked));
      }
    }

    // Crossing the line, which is the biggest thing that happens to anyone in
    // this round and went unmentioned: you tap a hundred and twenty times and
    // the phone said nothing at all. `place` only appears once the server has
    // you across, so this cannot fire on an optimistic count.
    const place = mine.planApply?.place ?? null;
    if (place !== null && place !== lastPlace) {
      lastPlace = place;
      planHouse.node.hidden = false;
      planHouse.set(HOUSE.crossed(pa.target));
      setText(announce, HOUSE.crossed(pa.target));
    }

    // The turn, felt as well as seen. Two patterns, so the lock and the
    // release are distinguishable without looking — which is a third
    // non-visual channel, not a flourish.
    if (lastLightAt !== null && lastLightAt !== pa.lightChangedAt) {
      buzz(pa.light === "apply" ? [70] : [20, 60, 20]);
      setText(announce, face.announce);
    }
    lastLightAt = pa.lightChangedAt;
  };

  const paintLounge = (state: RenderState, arcade: ArcadeView, mine: ArcadeMine): void => {
    mount("lounge", [drainNode, loungeNode]);
    // `glassExit` is latched at the transition, because the frame that
    // carries a fall is the only one that can tell a fall from a timeout —
    // see paint(). Null outside the bridge, and cleared by the next round.
    setText(
      drainNode.querySelector(".a-drain-error") as HTMLElement,
      glassExit ?? unsealExit ?? STATE_LOCK_ERROR,
    );
    setText(
      drainNode.querySelector(".a-drain-who") as HTMLElement,
      HOUSE.drained(mine.playerNumber),
    );

    const backing = mine.backing ?? null;
    const g = arcade.glass;
    // SPEC.md narrows the Lounge on this bridge: "Drained players back
    // someone in a **later** wave." The engine refuses anything else, and a
    // chip that is refused when pressed is a chip that should not have been
    // drawn — so the list is narrowed where it is made as well.
    const floor = g
      ? glassBackable(arcade, state.roster, g)
      : floorEntries(arcade, state.roster);
    // …and once your runner walks onto the bridge the bet stands, which is
    // the other half of the same sentence. The chips become a record.
    const locked =
      g !== undefined &&
      backing !== null &&
      !floor.some((e) => e.pid === backing);
    const backed = (
      g ? gridEntries(arcade, state.roster) : floor
    ).find((e) => e.pid === backing);
    loungeBacked.hidden = backed === undefined;
    if (backed) {
      replace(loungeBacked, [
        h("span", { class: "label", text: "Backing" }),
        h("span", { class: "mono a-chip-num", text: backed.tag }),
        h("span", { class: "a-chip-name", text: backed.nickname }),
        // Deliberately drawn before the signature check below, so it moves on
        // every frame the round sends rather than only when the chips change:
        // the chips change on a drain, and the runner's count changes on the
        // light. See backedProgress().
        ...backedLine(arcade, mine),
      ]);
    }
    // Changeable until the Floor locks, which is the moment the round stops
    // running. After that the chips are a record, not a control.
    const open = arcade.phase === "running" && ctx.live && !locked;
    // Rebuilt only when it actually changed. During Plan / Apply the state
    // moves on every tap in the room, and a list rebuilt under a thumb is a
    // tap that lands on nothing. The signature covers the mirror below as
    // well, which is why it is taken over the whole grid and not the Floor.
    const all = gridEntries(arcade, state.roster);
    const signature = `${open}:${backing ?? ""}:${g?.wave ?? ""}:${all
      .map((e) => `${e.pid}/${e.standing}/${e.backers}/${e.away}/${e.struck}`)
      .join(",")}`;
    if (signature === loungeSignature) return;
    loungeSignature = signature;
    replace(
      loungeList,
      floor.map((e) => {
        const chip = h(
          "button",
          {
            class: e.pid === backing ? "a-chip is-backed" : "a-chip",
            type: "button",
            disabled: !open,
            attrs: { "aria-pressed": e.pid === backing ? "true" : "false" },
          },
          [
            h("span", { class: "mono a-chip-num", text: e.tag }),
            h("span", { class: "a-chip-name", text: e.nickname }),
            e.backers > 0
              ? h("span", { class: "mono a-chip-backers", text: `×${e.backers}` })
              : null,
          ],
        );
        chip.addEventListener("click", () => ctx.arcadeBack(e.pid));
        return chip;
      }),
    );
    if (floor.length === 0) {
      replace(loungeList, [
        h("p", {
          class: "a-lounge-empty",
          text: locked
            ? "Your runner is on the bridge. The bet stands."
            : g
              ? "Every later wave has already crossed."
              : "Nobody is left on the Floor.",
        }),
      ]);
    }
    // The big screen's grid, mirrored small, so the Lounge can watch without
    // looking up. DESIGN.md asks for this and it is why the Lounge screen is
    // the one designed with the most care.
    replace(
      loungeMirror,
      all.map((e) =>
        h("span", {
          class: "a-mirror-cell",
          text: e.tag,
          attrs: {
            "data-standing": e.standing,
            "data-away": e.away ? "yes" : "no",
            "data-struck": e.struck ? "yes" : "no",
          },
        }),
      ),
    );
  };

  const paintReveal = (
    state: RenderState,
    arcade: ArcadeView,
    mine: ArcadeMine,
  ): void => {
    const recap = arcade.recruitment?.recap ?? [];
    // The Lounge's own result. SPEC.md pays a backer whose runner crossed and
    // pays them again if the runner won; DESIGN.md gives that its line, and
    // until now the Lounge watched the grid all round and was told nothing at
    // the end of it. "Survived" is the standing on the final grid: still on
    // the Floor when the Floor locked.
    const backing = mine.backing ?? null;
    const survived =
      backing !== null &&
      gridEntries(arcade, state.roster).some(
        (e) => e.pid === backing && e.standing === "floor",
      );
    // The bridge's answer, which is the only round whose reveal is a lesson:
    // SPEC.md asks the note on each pane to read out why the fake was fake,
    // and both notes are shown because the real one's is the thing somebody
    // learns. This is the first frame on which any of it has existed.
    const glassRecap = arcade.glass?.recap ?? [];
    // Unseal's answers, which is the first frame on which any of them has
    // existed. Every tin, not only the one this player held: SPEC.md asks the
    // reveal to read the note out, and the note — *Reusable Terraform. The
    // thing everyone means to write and never does* — is the thing a room of
    // solutions architects actually takes away from the round.
    const unsealRecap = arcade.unseal?.recap ?? [];
    /**
     * Tug of Raft's own result, which is otherwise nothing at all.
     *
     * Nobody drains in this round and there is no answer to read out, so the
     * reveal had one number on it — the points — for a round the player has
     * just spent seventy-five seconds tapping through. This says what
     * happened to the rope, which is the thing they were watching.
     *
     * Public facts only: the pulls each side won, and their own end of the
     * rope. Not the leader, which is a per-player number and lives on the
     * console and the Desktop.
     */
    const tug = arcade.tug;
    const tugLine =
      tug === undefined
        ? null
        : `${
            tug.wins[0] === tug.wins[1]
              ? `The rope finished level, ${tug.wins[0]} pulls each`
              : `Side ${tug.wins[0] > tug.wins[1] ? "A" : "B"} took it, ${Math.max(
                  tug.wins[0],
                  tug.wins[1],
                )} pulls to ${Math.min(tug.wins[0], tug.wins[1])}`
          } · you pulled for side ${(mine.tug?.side ?? 0) === 0 ? "A" : "B"}.`;
    // Keyed on what it draws, so a later frame in the same reveal redraws it.
    mount(
      `reveal:${mine.banked}:${mine.total}:${survived}:${glassRecap.length}:${unsealRecap.length}:${tugLine ?? ""}`,
      [
      h("div", { class: "a-reveal" }, [
        h("p", { class: "label", text: "Banked this round" }),
        h("p", { class: "mono a-banked", text: String(mine.banked) }),
        h("p", { class: "label a-total" }, [`Arcade total ${mine.total}`]),
        ...glassRecap.map((step, i) =>
          h("div", { class: "a-glass-recap" }, [
            h("p", { class: "mono a-glass-recap-head" }, [
              h("span", { class: "a-glass-recap-num", text: String(i + 1) }),
              h("span", { text: step.product }),
            ]),
            ...[0, 1].map((side) =>
              h("div", {
                class: "a-glass-recap-pane",
                attrs: { "data-real": step.real === side ? "yes" : "no" },
              }, [
                h("span", {
                  class: "a-glass-recap-mark mono",
                  attrs: { "aria-hidden": "true" },
                  text: step.real === side ? "○" : "□",
                }),
                h("span", { class: "a-glass-recap-label", text: step.labels[side] ?? "" }),
                h("span", { class: "a-glass-recap-note", text: step.notes[side] ?? "" }),
              ]),
            ),
          ]),
        ),
        ...unsealRecap.map((tin) =>
          h("div", { class: "a-recap" }, [
            // The shape and the cue share the first column, so this row has
            // the same three-cell shape as Recruitment's and the grid does
            // not have to know which round it is drawing.
            h("span", { class: "a-recap-tin" }, [
              h("span", {
                class: "a-recap-shape",
                attrs: { "aria-hidden": "true" },
                text: UNSEAL_FACE[tin.shape].glyph,
              }),
              h("span", { class: "mono a-recap-scramble", text: tin.cue }),
            ]),
            h("span", { class: "a-recap-answer", text: tin.answer }),
            h("span", { class: "a-recap-note", text: tin.note }),
          ]),
        ),
        ...recap.map((item) =>
          h("div", { class: "a-recap" }, [
            h("span", { class: "a-recap-cue", attrs: { "aria-hidden": "true" }, text: item.cue }),
            h("span", { class: "a-recap-answer", text: item.answer }),
            h("span", { class: "a-recap-note", text: item.note }),
          ]),
        ),
        tugLine === null
          ? null
          : h("p", { class: "a-tug-result", text: tugLine }),
        survived ? houseLine(HOUSE.backedSurvived) : null,
        houseLine(HOUSE.roundEnd),
        ]),
      ],
    );
  };

  const paint = (state: RenderState): void => {
    keepAnnounce = false;
    seen = state;
    const arcade = state.arcade;
    // The console's preview is a picture of the room, and the room has no
    // single `arcadeMine`. A neutral one lets the preview show the round card,
    // the light and the cue — everything that is *not* one person's — rather
    // than a permanent "coming up" that tells the host nothing.
    const mine: ArcadeMine | undefined =
      state.arcadeMine ??
      (arcade === undefined
        ? undefined
        : {
            playerNumber: 0,
            standing: "floor",
            banked: 0,
            total: 0,
            // A neutral bridge line for the same reason: without one, the
            // preview shows the console a round with no panes in it, which
            // is not what anybody in the room is looking at. `ctx.live` is
            // false on the preview, so the panes are a picture either way.
            ...(arcade.glass
              ? {
                  glass: {
                    wave: arcade.glass.wave,
                    onTheBridge: true,
                    step: 0,
                    committed: false,
                    across: false,
                  } as const,
                }
              : {}),
          });
    if (arcade === undefined || mine === undefined) {
      badge.hidden = true;
      welcome.node.hidden = true;
      mount("waiting", [
        h("div", { class: "a-card" }, [
          h("p", { class: "label", text: "Hashi Arcade" }),
          houseLine("The next game will begin shortly."),
        ]),
      ]);
      return;
    }

    badge.hidden = state.arcadeMine === undefined;
    setText(badgeNum, playerTag(mine.playerNumber));
    setAttr(badge, "data-standing", mine.standing);

    // "Welcome. You have been recruited. You are Player 017." — DESIGN.md's
    // line for entering the arcade, which is exactly what this is: the number
    // has just been handed out and no game has started yet. It holds until
    // the first round is actually being played, then never comes back, so
    // somebody joining mid-arcade is not welcomed over the top of a round.
    if (arcade.phase === "running") welcomed = true;
    const greet = !welcomed && state.arcadeMine !== undefined;
    welcome.node.hidden = !greet;
    if (greet) welcome.set(HOUSE.welcome(mine.playerNumber));

    // The drain: 400 ms of desaturation and pink, then the gold card. It is
    // played once, on the transition, and never on a repaint — a phone that
    // replayed the error every time a frame arrived would be a phone stuck on
    // the error, which is the one thing DESIGN.md says must not happen.
    if (lastStanding === "floor" && mine.standing === "drained") {
      // The bridge has its own error, and it has two of them.
      //
      // DESIGN.md gives the fall — *Pane 4 was not tempered* — and the step
      // it names is the one they were facing, which is their own `position`
      // and never the bridge's open step: by the time a timeout drain
      // reaches a phone, `nextStep` has already moved the bridge on.
      //
      // `committed` tells the two apart, and it is only readable on this
      // frame: a fall arrives with the phone still in `stepped`, and a
      // timeout arrives after the close cleared it. Which is why the line is
      // latched here and not recomputed in the Lounge.
      const g = mine.glass;
      const pane = (g?.step ?? 0) + 1;
      glassExit =
        arcade.round !== "glass_bridge"
          ? null
          : g?.committed
            ? HOUSE.glassPane(pane)
            : HOUSE.glassPaneMissed(pane);
      // Unseal has its own error and DESIGN.md writes it: *The tin has
      // cracked.* This is the second wrong letter, so it is the shatter — the
      // crack said its own line in the House slot a moment ago and the round
      // carried on. The Lounge underneath draws whichever of the three applies,
      // and the state-lock error is Plan / Apply's and only Plan / Apply's.
      unsealExit = arcade.round === "unseal" ? HOUSE.unsealShattered : null;
      node.classList.add("is-draining");
      buzz([120, 60, 120]);
      setText(
        announce,
        `${glassExit ?? unsealExit ?? STATE_LOCK_ERROR}. ${HOUSE.drained(mine.playerNumber)}`,
      );
      // The Lounge is about to mount underneath this, and a mount clears the
      // live region. This one message outlives its screen on purpose.
      keepAnnounce = true;
      if (drainTimer !== null) clearTimeout(drainTimer);
      drainTimer = setTimeout(() => {
        node.classList.remove("is-draining");
        node.classList.add("is-lounged");
        drainTimer = null;
      }, 400);
    }
    if (mine.standing === "floor") {
      node.classList.remove("is-draining", "is-lounged");
    }
    lastStanding = mine.standing;

    if (arcade.phase === "reveal") return paintReveal(state, arcade, mine);
    // Unseal is the one round whose card is a control. "Choose a shape. You
    // will be given a sealed tin" is what the card *says*, and the engine
    // accepts a pick against it — so the phone shows the picker rather than
    // the card, and the card's own lines are on the Desktop where the room is
    // already reading them. A card with the instruction and no way to obey it
    // would spend the twenty seconds the pick is meant to happen in.
    if (arcade.phase === "card" && arcade.round === "unseal") {
      optimistic = 0;
      lastLightAt = null;
      resetCheckpointLine();
      resetBridge();
      resetTug();
      return paintUnseal(arcade, mine);
    }
    if (arcade.phase === "card") {
      optimistic = 0;
      lastLightAt = null;
      resetCheckpointLine();
      resetBridge();
      resetUnseal();
      resetTug();
      return paintCard(arcade);
    }
    if (arcade.phase === "idle") {
      // Between rounds: the round that just ended is not revealed yet and the
      // next one has no card. One line, and it is the announcer's.
      optimistic = 0;
      lastLightAt = null;
      resetCheckpointLine();
      resetBridge();
      resetUnseal();
      resetTug();
      mount("between", [
        h("div", { class: "a-card" }, [houseLine(HOUSE.roundEnd)]),
      ]);
      return;
    }
    if (mine.standing === "drained") return paintLounge(state, arcade, mine);
    if (arcade.round === "recruitment") return paintRecruitment(state, arcade, mine);
    if (arcade.round === "plan_apply") return paintPlan(arcade, mine);
    if (arcade.round === "unseal") return paintUnseal(arcade, mine);
    if (arcade.round === "tug_of_raft") return paintTug(state, arcade, mine);
    if (arcade.round === "glass_bridge") return paintGlass(state, arcade, mine);
    // A round that is designed but not built: say so rather than show a
    // button that does nothing.
    mount("unbuilt", [
      h("div", { class: "a-card" }, [
        h("p", {
          class: "label",
          text: arcade.round ? ARCADE_ROUND_LABEL[arcade.round] : "Hashi Arcade",
        }),
        houseLine("The next game will begin shortly."),
      ]),
    ]);
  };

  return {
    node,
    update(state) {
      paint(state);
    },
    tick(state) {
      // Only the two countdowns move without a frame arriving. A full repaint
      // on a heartbeat would rebuild the Lounge's chips five times a second
      // under the thumb that is trying to tap one, and the bridge under the
      // cursor that is trying to step.
      const a = state.arcade;
      if (a?.phase !== "running") return;
      if (a.round === "recruitment") paintItemTimer(a);
      else if (a.round === "unseal" && built === "unseal") paintUnsealTimer(a);
      else if (a.round === "glass_bridge" && built === "glass") paintStepTimer(a);
      // Tug of Raft is deliberately not here. Its clock is the heartbeat and
      // it is drawn on an animation frame, five times faster than this tick:
      // a 200 ms heartbeat sampler against a 600 ms beat would show the ring
      // in three positions and none of them at the beat.
    },
    clearStep() {
      // The server refused the commitment — the step closed under the frame,
      // or the round moved on. Whatever this phone drew optimistically is
      // now a lie, so it comes off and the next paint decides afresh.
      stepSent = null;
      glassOpen = false;
    },
    stop() {
      window.removeEventListener("keydown", onTapKey);
      window.removeEventListener("keydown", onPaneKey);
      window.removeEventListener("keydown", onLetterKey);
      window.removeEventListener("keydown", onPullKey);
      stopTugFrame();
      if (drainTimer !== null) clearTimeout(drainTimer);
      drainTimer = null;
    },
  };
}

function scenePending(name: string, note: string): Scene {
  const node = h("section", { class: "v v-pending" }, [
    h("p", { class: "label", text: name }),
    h("h1", { class: "display xl", text: "Coming up" }),
    h("p", { class: "v-note", text: note }),
  ]);
  return { node, update() {} };
}

/* ------------------------------------------------------------------ */

/** A drawn padlock, not an emoji: emoji render differently on every phone. */
export function lockGlyph(className: string): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  const shackle = document.createElementNS(ns, "path");
  shackle.setAttribute("d", "M7.5 10V7a4.5 4.5 0 0 1 9 0v3");
  shackle.setAttribute("stroke", "currentColor");
  shackle.setAttribute("stroke-width", "2");
  const body = document.createElementNS(ns, "rect");
  body.setAttribute("x", "4.5");
  body.setAttribute("y", "10");
  body.setAttribute("width", "15");
  body.setAttribute("height", "10");
  body.setAttribute("rx", "1.5");
  body.setAttribute("fill", "currentColor");
  svg.appendChild(shackle);
  svg.appendChild(body);
  return svg;
}
