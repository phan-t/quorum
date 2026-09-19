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

import type { RenderState, TriviaMine, TriviaView } from "../../protocol.ts";
import { append, h, replace, setAttr, setClass, setText } from "../shared/dom.ts";
import {
  answerTiles,
  formatCountdown,
  pointsStripCells,
  pointsStripText,
  questionLabel,
  remainingMs,
  resolveView,
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

  const ctx: TriviaCtx = {
    now,
    pending: () => pending,
    tap: (index, choice) => {
      if (opts.onAnswer === undefined) return;
      // One tap and it is final, so the guard is here as well as on the
      // server: a double-tap on a laggy phone must not produce two frames.
      if (pending !== null) return;
      pending = { index, choice };
      opts.onAnswer(index, choice);
      if (last !== null) scene?.update(last, null);
    },
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

interface TriviaCtx {
  now(): number;
  pending(): Pending | null;
  tap(index: number, choice: number): void;
}

function buildScene(kind: ViewKind, ctx: TriviaCtx): Scene {
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
      return scenePending("Hashi Arcade", "The host is setting up.");
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
function sceneTrivia(ctx: TriviaCtx): Scene {
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
