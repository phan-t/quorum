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
import { append, h, replace, setAttr, setClass, setText } from "../shared/dom.ts";
import {
  ARCADE_ROUND_CARD,
  HOW_TO_PLAY,
  ARCADE_ROUND_LABEL,
  HOUSE,
  KEY_HINT,
  LIGHT_FACE,
  PLAY_RULE,
  STAFF_CARD,
  STATE_LOCK_ERROR,
  answerKeyIndex,
  answerTiles,
  bridgeSteps,
  floorEntries,
  formatCountdown,
  glassBackable,
  gridEntries,
  isTapKey,
  itemEndsAt,
  latestCheckpoint,
  paneKeyIndex,
  playerName,
  playerTag,
  pointsStripCells,
  pointsStripText,
  questionLabel,
  remainingMs,
  resolveView,
  resourceBar,
  stepFraction,
  timerFraction,
  type BridgeEntry,
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
  const message = h("p", { class: "so-message" });
  const from = h("p", { class: "so-from" });
  const note = h("p", { class: "v-note so-note" });
  const node = h("section", { class: "v v-sendoff" }, [who, note, message, from]);
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
      setText(who, so.subtitle === null ? so.name : `${so.name} · ${so.subtitle}`);
      node.dataset["phase"] = so.phase;

      const k = so.kudo;
      if (k !== null) {
        setText(message, k.message);
        setText(from, k.from);
        message.hidden = false;
        from.hidden = false;
        message.style.setProperty("--so-size", kudoSize(k.message));
        // Which one of how many, so a phone that lost the share still knows
        // where the room is. Quiet: it is not the content.
        setText(note, `${so.index} of ${so.total}`);
        note.hidden = false;
        return;
      }

      from.hidden = true;
      const line = so.phase === "closing" || so.phase === "done" ? so.line : null;
      setText(message, line ?? "");
      message.hidden = line === null || line === "";
      message.style.removeProperty("--so-size");
      // The montage has no words of its own on this screen, so it says what
      // is happening rather than showing an empty panel for forty seconds.
      setText(
        note,
        so.phase === "opening"
          ? "Photos, on the shared screen."
          : so.phase === "closing"
            ? "Photos, on the shared screen."
            : "",
      );
      note.hidden = note.textContent === "";
    },
  };
}

/**
 * The size for one message: constant *area*, not constant type.
 *
 * The same fit the Desktop uses, in a range this screen can hold — a browser
 * window beside a video call, or a phone in a pocket at the back of a room.
 */
function kudoSize(text: string): string {
  const n = Math.max(1, text.length);
  const px = 420 / Math.sqrt(n);
  return `clamp(17px, ${px.toFixed(1)}px, 26px)`;
}

function sceneLobby(): Scene {
  const nick = h("p", { class: "display lobby-nick" });
  const you = h("div", { class: "lobby-you" }, [
    h("p", { class: "label", text: "You're in" }),
    nick,
  ]);
  const title = h("h1", { class: "display lobby-title" });
  const prize = h("p", { class: "lobby-prize" });
  const count = h("span", { class: "num lobby-count" });
  const chips = h("div", { class: "lobby-chips" });

  const node = h("section", { class: "v v-lobby" }, [
    you,
    title,
    prize,
    h("div", { class: "lobby-here" }, [
      count,
      h("span", { class: "label", text: "here" }),
    ]),
    chips,
    h("p", { class: "label lobby-wait", text: "Waiting for the host" }),
  ]);

  return {
    node,
    update(state, nickname) {
      // The console renders this view with no nickname of its own; it is a
      // preview of the room, not of one person.
      you.hidden = nickname === null;
      if (nickname !== null) setText(nick, nickname);
      setText(title, state.title);
      // Deliberately *not* `state.holding.line`, which is what this used to
      // read. `holding` is the last card the host set, not the card currently
      // on screen — the engine only clears it on a restart — so once any card
      // had been shown, its second line followed the room back into the lobby.
      // With one card, typed in the lobby before anything ran, the two were
      // the same thing and this worked. With named cards it meant the lobby
      // announced "By Abhijeet Lokhande" under the session title.
      //
      // A card's second line belongs to that card. The prize line DESIGN.md
      // describes here needs a field of its own; until it has one, the lobby
      // says nothing rather than something that belongs to another screen.
      prize.hidden = true;
      setText(count, String(state.roster.length));
      // Names, as text, clipped by the layout rather than by a slice: the
      // phone must not scroll, and "+7 more" is more honest than a cut.
      const shown = state.roster.slice(0, 24);
      replace(
        chips,
        shown.map((r) => h("span", { class: "chip", text: r.nickname })),
      );
      if (state.roster.length > shown.length) {
        append(chips, [
          h("span", {
            class: "chip chip-more label",
            text: `+${state.roster.length - shown.length} more`,
          }),
        ]);
      }
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
  const node = h("section", { class: "v v-standings" }, [
    heading,
    house.node,
    list,
    empty,
  ]);
  return {
    node,
    update(state) {
      const concluded =
        !final && state.arcade !== undefined && state.arcade.round !== null;
      house.node.hidden = !concluded;
      if (concluded) house.set(HOUSE.arcadeEnd);
      const rows = state.standings;
      empty.hidden = rows.length > 0;
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
    },
  };
}

function sceneSealed(): Scene {
  const line = h("p", { class: "v-note" });
  const node = h("section", { class: "v v-sealed" }, [
    lockGlyph("sealed-lock"),
    h("h1", { class: "display xl", text: "Scores are hidden" }),
    line,
  ]);
  return {
    node,
    update(state) {
      setText(line, state.holding?.line ?? "Revealed at the end.");
    },
  };
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
  const status = h("p", { class: "t-status label" });
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
      setText(status, "The host is about to open the question.");
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
      setText(status, "");
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
      status,
      chosen !== null
        ? "Locked in."
        : trivia.phase === "open"
          ? trivia.suddenDeath
            ? "Sudden death. First correct answer wins."
            : "Pick one. It is final."
          : "Time's up.",
    );
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
   * SPEC.md gives Recruitment six items at twenty seconds each, and this slot
   * used to draw `arcade.endsAt` — the whole round — so it read 00:17, 00:15,
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
  };

  /** A new round banks nothing yet, so last round's line must not linger. */
  const resetCheckpointLine = (): void => {
    lastCheckpoint = null;
    lastPlace = null;
    planHouse.node.hidden = true;
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
      glassExit ?? STATE_LOCK_ERROR,
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
    // Keyed on what it draws, so a later frame in the same reveal redraws it.
    mount(`reveal:${mine.banked}:${mine.total}:${survived}:${glassRecap.length}`, [
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
        ...recap.map((item) =>
          h("div", { class: "a-recap" }, [
            h("span", { class: "a-recap-cue", attrs: { "aria-hidden": "true" }, text: item.cue }),
            h("span", { class: "a-recap-answer", text: item.answer }),
            h("span", { class: "a-recap-note", text: item.note }),
          ]),
        ),
        survived ? houseLine(HOUSE.backedSurvived) : null,
        houseLine(HOUSE.roundEnd),
      ]),
    ]);
  };

  const paint = (state: RenderState): void => {
    keepAnnounce = false;
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
      node.classList.add("is-draining");
      buzz([120, 60, 120]);
      setText(
        announce,
        `${glassExit ?? STATE_LOCK_ERROR}. ${HOUSE.drained(mine.playerNumber)}`,
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
    if (arcade.phase === "card") {
      optimistic = 0;
      lastLightAt = null;
      resetCheckpointLine();
      resetBridge();
      return paintCard(arcade);
    }
    if (arcade.phase === "idle") {
      // Between rounds: the round that just ended is not revealed yet and the
      // next one has no card. One line, and it is the announcer's.
      optimistic = 0;
      lastLightAt = null;
      resetCheckpointLine();
      resetBridge();
      mount("between", [
        h("div", { class: "a-card" }, [houseLine(HOUSE.roundEnd)]),
      ]);
      return;
    }
    if (mine.standing === "drained") return paintLounge(state, arcade, mine);
    if (arcade.round === "recruitment") return paintRecruitment(state, arcade, mine);
    if (arcade.round === "plan_apply") return paintPlan(arcade, mine);
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
      else if (a.round === "glass_bridge" && built === "glass") paintStepTimer(a);
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
