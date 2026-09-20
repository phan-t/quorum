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
  ARCADE_ROUND_LABEL,
  HOUSE,
  LIGHT_FACE,
  STAFF_CARD,
  STATE_LOCK_ERROR,
  answerTiles,
  floorEntries,
  formatCountdown,
  gridEntries,
  playerName,
  playerTag,
  pointsStripCells,
  pointsStripText,
  questionLabel,
  remainingMs,
  resolveView,
  resourceBar,
  timerFraction,
  type ViewKind,
} from "../shared/view.ts";

export interface ParticipantView {
  readonly root: HTMLElement;
  update(state: RenderState | null, nickname: string | null): void;
  setBanner(text: string | null): void;
  /** The tap was refused. Drop the optimistic "locked in" and let them retry. */
  clearPendingAnswer(): void;
}

export interface ParticipantViewOptions {
  compact?: boolean;
  /** Corrected server time. Every countdown on this page is drawn off it. */
  now?: () => number;
  /** Absent on the console's preview, which is a picture and not a phone. */
  onAnswer?: (index: number, choice: number) => void;
  onArcadeTap?: (round: number) => void;
  onArcadeAnswer?: (item: number, answer: string) => void;
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
  const stage = h("main", { class: "p-stage" });
  // A group, so the `aria-label` below is honoured: the visual is a row of
  // swatches and numbers, and the label is the sentence they add up to.
  const strip = h("div", { class: "p-strip mono", role: "group" });
  const root = h("div", { class: opts.compact ? "p-root compact" : "p-root" }, [
    banner,
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
        ? h("span", { class: "strip-sealed label", text: "points sealed" })
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

    update(state, nickname) {
      if (state === null) return;
      last = state;
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
  arcadeBack(pid: string): void;
}

function buildScene(kind: ViewKind, ctx: SceneCtx): Scene {
  switch (kind) {
    case "waiting":
      return sceneWaiting();
    case "lobby":
      return sceneLobby();
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
      const line = state.holding?.line ?? "";
      setText(prize, line);
      prize.hidden = line === "";
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
  const node = h("section", { class: "v v-standings" }, [heading, list, empty]);
  return {
    node,
    update(state) {
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
    h("h1", { class: "display xl", text: "Standings are sealed" }),
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
  const status = h("p", { class: "t-status label" });

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
    h("div", { class: "t-head" }, [kicker, roundCard, question, timer]),
    grid,
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
          // The shape is decoration to a reader; the text is the answer.
          "aria-label": tile.text,
        },
      }, [
        h("span", { class: "t-shape", attrs: { "aria-hidden": "true" }, text: tile.shape }),
        h("span", { class: "t-answer", text: tile.text }),
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
    countedFrom = null;
    status.hidden = false;
    setText(
      status,
      chosen !== null
        ? "Locked in."
        : trivia.phase === "open"
          ? trivia.suddenDeath
            ? "Sudden death. First correct answer wins."
            : "Tap one. It is final."
          : "Time's up.",
    );
  };

  return {
    node,
    update(state) {
      paint(state);
    },
    tick(state) {
      if (state.trivia) paintTimer(state.trivia);
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
  const node = h("section", { class: "v v-arcade" }, [badge, body, announce]);

  /** Which sub-screen is built, so typing into the field is not eaten. */
  let built = "";
  /** The last light seen, so the haptic fires on the turn and not on repaint. */
  let lastLightAt: number | null = null;
  let lastStanding: "floor" | "drained" | null = null;
  /** Local resource count, so the button responds to the thumb, not the link. */
  let optimistic = 0;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  /** The Lounge list as last drawn, so a burst of frames does not rebuild it. */
  let loungeSignature = "";

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
    cue,
    cueRead,
    h("div", { class: "a-recruit-row" }, [field, submit]),
    recruitStatus,
  ]);

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
  const planNode = h("div", { class: "a-plan" }, [bar, bigButton]);

  bigButton.addEventListener("click", () => {
    if (bigButton.disabled) return;
    const round = Number(bigButton.dataset["round"] ?? "-1");
    if (round < 0) return;
    optimistic += 1;
    setText(bigCount, String(optimistic));
    ctx.arcadeTap(round);
  });

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
    loungeMirror,
  ]);

  const mount = (key: string, children: readonly Node[]): void => {
    if (built === key) return;
    built = key;
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
    const left = remainingMs(arcade.endsAt, ctx.now());
    setText(recruitTimer, left === null ? "" : formatCountdown(left));

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
    mount("plan", [planNode]);
    bigButton.dataset["round"] = String(arcade.roundIndex);

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
    setText(
      drainNode.querySelector(".a-drain-who") as HTMLElement,
      HOUSE.drained(mine.playerNumber),
    );

    const backing = mine.backing ?? null;
    const floor = floorEntries(arcade, state.roster);
    const backed = floor.find((e) => e.pid === backing);
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
    const open = arcade.phase === "running" && ctx.live;
    // Rebuilt only when it actually changed. During Plan / Apply the state
    // moves on every tap in the room, and a list rebuilt under a thumb is a
    // tap that lands on nothing. The signature covers the mirror below as
    // well, which is why it is taken over the whole grid and not the Floor.
    const all = gridEntries(arcade, state.roster);
    const signature = `${open}:${backing ?? ""}:${all
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
        h("p", { class: "a-lounge-empty", text: "Nobody is left on the Floor." }),
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

  const paintReveal = (arcade: ArcadeView, mine: ArcadeMine): void => {
    const recap = arcade.recruitment?.recap ?? [];
    mount("reveal", [
      h("div", { class: "a-reveal" }, [
        h("p", { class: "label", text: "Banked this round" }),
        h("p", { class: "mono a-banked", text: String(mine.banked) }),
        h("p", { class: "label a-total" }, [`Arcade total ${mine.total}`]),
        ...recap.map((item) =>
          h("div", { class: "a-recap" }, [
            h("span", { class: "a-recap-cue", attrs: { "aria-hidden": "true" }, text: item.cue }),
            h("span", { class: "a-recap-answer", text: item.answer }),
            h("span", { class: "a-recap-note", text: item.note }),
          ]),
        ),
        houseLine(HOUSE.roundEnd),
      ]),
    ]);
  };

  const paint = (state: RenderState): void => {
    const arcade = state.arcade;
    // The console's preview is a picture of the room, and the room has no
    // single `arcadeMine`. A neutral one lets the preview show the round card,
    // the light and the cue — everything that is *not* one person's — rather
    // than a permanent "coming up" that tells the host nothing.
    const mine: ArcadeMine | undefined =
      state.arcadeMine ??
      (arcade === undefined
        ? undefined
        : { playerNumber: 0, standing: "floor", banked: 0, total: 0 });
    if (arcade === undefined || mine === undefined) {
      badge.hidden = true;
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

    // The drain: 400 ms of desaturation and pink, then the gold card. It is
    // played once, on the transition, and never on a repaint — a phone that
    // replayed the error every time a frame arrived would be a phone stuck on
    // the error, which is the one thing DESIGN.md says must not happen.
    if (lastStanding === "floor" && mine.standing === "drained") {
      node.classList.add("is-draining");
      buzz([120, 60, 120]);
      setText(announce, `${STATE_LOCK_ERROR}. ${HOUSE.drained(mine.playerNumber)}`);
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

    if (arcade.phase === "reveal") return paintReveal(arcade, mine);
    if (arcade.phase === "card") {
      optimistic = 0;
      lastLightAt = null;
      return paintCard(arcade);
    }
    if (arcade.phase === "idle") {
      // Between rounds: the round that just ended is not revealed yet and the
      // next one has no card. One line, and it is the announcer's.
      optimistic = 0;
      lastLightAt = null;
      mount("between", [
        h("div", { class: "a-card" }, [houseLine(HOUSE.roundEnd)]),
      ]);
      return;
    }
    if (mine.standing === "drained") return paintLounge(state, arcade, mine);
    if (arcade.round === "recruitment") return paintRecruitment(state, arcade, mine);
    if (arcade.round === "plan_apply") return paintPlan(arcade, mine);
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
      // Only the item countdown moves without a frame arriving. A full
      // repaint on a heartbeat would rebuild the Lounge's chips five times a
      // second under the thumb that is trying to tap one.
      const a = state.arcade;
      if (a?.phase !== "running" || a.round !== "recruitment") return;
      const left = remainingMs(a.endsAt, ctx.now());
      setText(recruitTimer, left === null ? "" : formatCountdown(left));
    },
    stop() {
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
