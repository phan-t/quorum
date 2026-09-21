/**
 * The big screen. Served at `/screen`, token in the fragment.
 *
 * A 1920 × 1080 tab, shared into a video call, seen as maybe an 800px tile
 * after two rounds of compression. The whole design is about surviving that:
 * light type on dark (codecs subsample chroma, so colour edges blur and
 * luminance edges survive), colour only as fills, a 5% safe margin, few words,
 * and nothing that glides — video compression turns a smooth slide into a
 * smear, so things appear, hold, and cut.
 *
 * Read-only. Nothing here takes input; the host drives it from the console.
 */

import type {
  ActivitySummary,
  ArcadeView,
  RenderState,
  StandingRow,
  TriviaView,
} from "../../protocol.ts";
import { h, qs, replace, setAttr, setClass, setText } from "../shared/dom.ts";
import { QuorumClient } from "../shared/net.ts";
import { mockBadge, mockTransport, readMockConfig } from "../shared/mock.ts";
import {
  ARCADE_ROUND_CARD,
  ARCADE_ROUND_LABEL,
  HOUSE,
  LIGHT_FACE,
  STAFF_CARD,
  STATE_LOCK_ERROR,
  activityHue,
  answerTiles,
  bridgeSteps,
  formatCountdown,
  gridEntries,
  playerName,
  questionLabel,
  remainingMs,
  resolveView,
  stackedBar,
  timerFraction,
  waveRosters,
  wipeFraction,
  type ViewKind,
} from "../shared/view.ts";
import { drawQr, encodeQr } from "../shared/qr.ts";
import { lockGlyph } from "../participant/view.ts";

document.title = "Quorum";

const mock = readMockConfig();
const app = qs<HTMLElement>("#app");

function readToken(): string {
  const raw = location.hash.replace(/^#/, "");
  if (raw === "") return "";
  if (raw.includes("=")) return new URLSearchParams(raw).get("token") ?? "";
  return raw;
}

const screenToken = readToken() || (mock ? "mock-screen-token" : "");

/**
 * The join URL, from the join code the server sends this screen in
 * `RenderState`. `?join=` still wins, so a screen can be pointed at a short
 * vanity link or a projector-friendly host name.
 *
 * There is deliberately no format check on the code: it used to be tested
 * against `[A-Z]{2,8}`, which stopped matching the day join codes became
 * Vault-shaped `hvs.` tokens and silently left the QR off the wall.
 */
function joinUrl(joinCode: string | undefined): string | null {
  const explicit = new URLSearchParams(location.search).get("join");
  if (explicit) return explicit;
  const code = (joinCode ?? "").trim();
  if (code === "") return null;
  return `${location.origin}/j/${encodeURIComponent(code)}`;
}

if (screenToken === "") {
  replace(app, [
    h("section", { class: "s-stage s-gate" }, [
      h("p", { class: "s-kicker label", text: "Quorum" }),
      h("h1", { class: "display s-title", text: "This screen needs its token" }),
      h("p", { class: "s-line", text: "Open it as /screen#<screen token>." }),
    ]),
  ]);
  throw new Error("no screen token");
}

/* ------------------------------------------------------------------ */

const banner = h("div", {
  class: "s-banner",
  attrs: { hidden: true, role: "status" },
});
const stage = h("div", { class: "s-root" });
const toastBar = h("div", { class: "s-toast", attrs: { hidden: true } });
replace(app, [banner, stage, toastBar]);
if (mock) document.body.appendChild(mockBadge());

interface Scene {
  node: HTMLElement;
  update(state: RenderState): void;
  stop?(): void;
}

let kind: ViewKind | null = null;
let scene: Scene | null = null;
let client: QuorumClient | null = null;

/** Corrected server time. Every countdown on this surface is drawn off it. */
const serverNow = (): number => client?.now() ?? Date.now();

function render(state: RenderState): void {
  const next = resolveView(state);
  if (next !== kind) {
    scene?.stop?.();
    kind = next;
    scene = build(next);
    replace(stage, [scene.node]);
    stage.dataset["view"] = next;
  }
  scene?.update(state);
}

function build(k: ViewKind): Scene {
  switch (k) {
    case "lobby":
      return sceneLobby();
    case "holding":
      return sceneHolding();
    case "standings":
      return sceneStandings();
    case "sealed":
      return sceneSealed();
    case "final":
      return sceneFinal();
    case "waiting":
      return sceneCard("Quorum", "Not open yet.");
    case "trivia":
      return sceneTrivia();
    case "arcade":
      return sceneArcade();
  }
}

/* ------------------------------------------------------------------ */
/* Scenes                                                              */
/* ------------------------------------------------------------------ */

function sceneCard(kicker: string, line: string): Scene {
  const title = h("h1", { class: "display s-title" });
  const node = h("section", { class: "s-stage s-card" }, [
    h("p", { class: "s-kicker label", text: kicker }),
    title,
    h("p", { class: "s-line", text: line }),
  ]);
  return {
    node,
    update(state) {
      setText(title, state.title);
    },
  };
}

function sceneLobby(): Scene {
  const title = h("h1", { class: "display s-title" });
  const url = h("p", { class: "mono s-join-url" });
  const canvas = h("canvas", { class: "s-qr" });
  const qrWrap = h("div", { class: "s-qr-wrap" }, [canvas]);
  const count = h("span", { class: "mono s-count" });
  const names = h("div", { class: "s-names" });

  // The code arrives with the first state, so the link is drawn in update()
  // rather than here. `drawn` keeps the canvas from being re-encoded on every
  // roster change — the QR only changes if the code does.
  let drawn: string | null = null;
  setText(url, "Ask the host for the join link");
  qrWrap.hidden = true;

  function showJoin(link: string | null): void {
    setText(url, link ?? "Ask the host for the join link");
    if (link === drawn) return;
    drawn = link;
    if (link === null) {
      qrWrap.hidden = true;
      return;
    }
    const code = encodeQr(link);
    // A QR survives compression surprisingly well if it is large enough, and
    // not at all if it is not. 360px is the floor.
    if (code) {
      drawQr(canvas, code, { targetPx: 420 });
      qrWrap.hidden = false;
    } else {
      qrWrap.hidden = true;
    }
  }

  const node = h("section", { class: "s-stage s-lobby" }, [
    h("div", { class: "s-lobby-left" }, [
      h("p", { class: "s-kicker label", text: "Join" }),
      title,
      url,
      h("p", { class: "s-lobby-count" }, [
        count,
        h("span", { class: "label", text: "joined" }),
      ]),
      names,
    ]),
    qrWrap,
  ]);

  return {
    node,
    update(state) {
      showJoin(joinUrl(state.joinCode));
      setText(title, state.title);
      setText(count, String(state.roster.length));
      // Nicknames as they arrive. Text, never markup.
      replace(
        names,
        state.roster
          .slice(-40)
          .map((r) => h("span", { class: "s-name", text: r.nickname })),
      );
    },
  };
}

function sceneHolding(): Scene {
  const title = h("h1", { class: "display s-title s-title-huge" });
  const line = h("p", { class: "s-line s-line-big" });
  const node = h("section", { class: "s-stage s-holding" }, [
    h("p", { class: "s-kicker label" }, [
      h("span", { class: "dot", attrs: { "data-conn": "on" } }),
      " live",
    ]),
    title,
    line,
  ]);
  return {
    node,
    update(state) {
      setText(title, state.holding?.title ?? state.title);
      setText(line, state.holding?.line ?? "");
    },
  };
}

/* ------------------------------------------------------------------ */
/* Trivia                                                              */
/* ------------------------------------------------------------------ */

const TRIVIA_TICK_MS = 200;

/**
 * The question, large, with the answer count climbing — then the reveal.
 *
 * The two halves of the segment share the tiles: while the question is open
 * they are four shape-and-colour tiles, and at the reveal each one grows a
 * bar behind it in its own hue with the count at the end. DESIGN.md wants
 * "bars, not numbers, for distributions" and "the correct tile stays lit,
 * others dim", and keeping the same four rows means the correct answer is in
 * the place the room was already looking.
 *
 * Nothing here glides. The bar widths are set on a state change and the timer
 * ticks; video compression turns a smooth slide into a smear.
 */
function sceneTrivia(): Scene {
  const kicker = h("p", { class: "s-kicker label" });
  const round = h("p", { class: "s-trivia-round label", attrs: { hidden: true } });
  const question = h("h1", { class: "display s-question" });
  const rows = h("div", { class: "s-answers" });

  const timerNum = h("span", { class: "mono s-timer-num" });
  const timerFill = h("div", { class: "s-timer-fill" });
  const timer = h("div", { class: "s-timer" }, [
    h("div", { class: "s-timer-track" }, [timerFill]),
    timerNum,
  ]);

  const countFill = h("div", { class: "s-count-fill" });
  const countText = h("span", { class: "mono s-count-text" });
  const count = h("div", { class: "s-answered" }, [
    h("div", { class: "s-count-track" }, [countFill]),
    countText,
  ]);

  const note = h("p", { class: "s-note", attrs: { hidden: true } });
  const podium = h("ol", { class: "s-rows s-trivia-podium", attrs: { hidden: true } });

  const node = h("section", { class: "s-stage s-trivia" }, [
    h("div", { class: "s-trivia-head" }, [kicker, round]),
    question,
    rows,
    timer,
    count,
    note,
    podium,
  ]);

  interface Row {
    el: HTMLElement;
    bar: HTMLElement;
    tally: HTMLElement;
  }
  let built = "";
  let built_rows: Row[] = [];
  let ticker: ReturnType<typeof setInterval> | null = null;

  const buildRows = (trivia: TriviaView): void => {
    const signature = `${trivia.index}:${trivia.answers.join("\u0000")}`;
    if (signature === built) return;
    built = signature;
    built_rows = answerTiles(trivia.answers).map((tile) => {
      const bar = h("div", { class: "s-answer-bar" });
      const tally = h("span", { class: "mono s-answer-tally" });
      const el = h(
        "div",
        {
          class: "s-answer",
          attrs: { style: `--tile:${tile.hue};--tile-ink:${tile.ink}` },
        },
        [
          bar,
          h("span", { class: "s-answer-shape", attrs: { "aria-hidden": "true" }, text: tile.shape }),
          h("span", { class: "s-answer-text", text: tile.text }),
          tally,
        ],
      );
      return { el, bar, tally };
    });
    replace(rows, built_rows.map((r) => r.el));
    rows.dataset["count"] = String(built_rows.length);
  };

  const paintTimer = (trivia: TriviaView): void => {
    if (trivia.suddenDeath || trivia.phase !== "open") {
      timer.hidden = true;
      return;
    }
    const left = remainingMs(trivia.closesAt, serverNow());
    if (left === null) {
      timer.hidden = true;
      return;
    }
    timer.hidden = false;
    setText(timerNum, formatCountdown(left));
    timerFill.style.width = `${(timerFraction(trivia, serverNow()) ?? 0) * 100}%`;
    setClass(timer, "urgent", left <= 5_000);
  };

  let lastState: RenderState | null = null;

  const paint = (state: RenderState): void => {
    const trivia = state.trivia;
    if (trivia === undefined || trivia.phase === "idle" || trivia.text === "") {
      setText(kicker, "Trivia");
      round.hidden = trivia?.round === null || trivia?.round === undefined;
      if (trivia?.round) setText(round, trivia.round.name);
      setText(question, trivia?.round?.startsHere === true ? trivia.round.name : "Coming up");
      replace(rows, []);
      built = "";
      timer.hidden = true;
      count.hidden = true;
      note.hidden = true;
      podium.hidden = true;
      return;
    }

    setText(kicker, questionLabel(trivia));
    round.hidden = trivia.round === null;
    if (trivia.round) setText(round, trivia.round.name);
    setText(question, trivia.text);
    buildRows(trivia);
    paintTimer(trivia);

    const answered = trivia.answered ?? 0;
    const eligible = trivia.eligible ?? 0;
    const revealed = trivia.phase === "revealed";
    count.hidden = revealed;
    if (!revealed) {
      setText(countText, `${answered} of ${eligible}`);
      countFill.style.width = eligible > 0 ? `${(answered / eligible) * 100}%` : "0%";
    }

    const distribution = trivia.distribution ?? [];
    const correct = revealed ? (trivia.correct ?? []) : [];
    // The widest bar is the full width, so the shape of the room's answer
    // reads at a glance rather than against an invisible axis.
    const top = Math.max(1, ...distribution);
    built_rows.forEach((row, i) => {
      const n = distribution[i] ?? 0;
      const isCorrect = correct.includes(i);
      setClass(row.el, "hit", revealed && isCorrect);
      setClass(row.el, "dim", revealed && !isCorrect);
      setAttr(row.el, "data-revealed", revealed ? "yes" : "no");
      row.bar.style.width = revealed ? `${(n / top) * 100}%` : "0%";
      setText(row.tally, revealed ? String(n) : "");
    });

    const text = trivia.note ?? "";
    note.hidden = !revealed || text === "";
    setText(note, text);

    const rowsOut = revealed ? (trivia.podium ?? []) : [];
    podium.hidden = rowsOut.length === 0;
    replace(
      podium,
      rowsOut.map((r) =>
        h("li", { class: "s-row s-trivia-row" }, [
          h("span", { class: "mono s-rank", text: String(r.rank) }),
          h("span", { class: "display s-name-big", text: r.nickname }),
          h("span", { class: "mono s-total", text: String(r.points) }),
        ]),
      ),
    );

    if (trivia.suddenDeath && trivia.suddenDeathWinner !== null) {
      // SPEC: sudden death shows the winner's name on the big screen, and
      // nothing about points, because none moved.
      setText(question, trivia.suddenDeathWinner);
      setText(kicker, "Sudden death");
    }
  };

  ticker = setInterval(() => {
    if (lastState?.trivia) paintTimer(lastState.trivia);
  }, TRIVIA_TICK_MS);

  return {
    node,
    update(state) {
      lastState = state;
      paint(state);
    },
    stop() {
      if (ticker !== null) clearInterval(ticker);
      ticker = null;
    },
  };
}


/* ------------------------------------------------------------------ */
/* Hashi Arcade                                                        */
/* ------------------------------------------------------------------ */

const ARCADE_TICK_MS = 60;

/**
 * The doll: a twelve-foot Terraform logo.
 *
 * The mark, drawn rather than fetched, so it survives with no network and no
 * font. DESIGN.md rules out figures, silhouettes and anything else from the
 * show; a product logo on a stand is the joke, and it is the only version of
 * the doll that is funny rather than grim.
 *
 * Its "head" turning is a rotation about the vertical axis, which reads as a
 * turn at any size. The wipe across the screen is the real warning; this is
 * the thing the room watches while the wipe happens.
 */
function doll(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 128 148");
  svg.setAttribute("class", "s-doll");
  svg.setAttribute("aria-hidden", "true");
  // The Terraform mark: four parallelograms, two stacked and two beside them.
  const bars: [number, number, number][] = [
    [8, 26, 1],
    [48, 26, 1],
    [48, 74, 1],
    [88, 50, 1],
  ];
  for (const [x, y] of bars) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute(
      "d",
      `M${x} ${y} l32 18 v40 l-32 -18 z`,
    );
    path.setAttribute("fill", "currentColor");
    svg.appendChild(path);
  }
  return svg;
}

/**
 * The arcade on the big screen.
 *
 * The grid is the centrepiece: sixty three-digit numbers, green on the Floor,
 * gold in the Lounge, grey away, with a thin pink strike on anyone drained
 * this round. DESIGN.md calls it the dormitory, and it is the arcade's
 * scoreboard, roster and mood in one.
 *
 * Plan / Apply takes the screen over entirely, because in that round the
 * screen *is* the light.
 */
function sceneArcade(): Scene {
  const kicker = h("p", { class: "s-kicker label" });
  const title = h("h1", { class: "display s-title" });
  const cardLines = h("div", { class: "s-arc-card" });
  const stair = h("div", { class: "s-stair", attrs: { "aria-hidden": "true" } });

  /* the grid */
  const grid = h("div", { class: "s-grid", role: "list" });
  const counts = h("p", { class: "mono s-grid-counts" });

  /* recruitment */
  const cue = h("p", { class: "s-arc-cue", attrs: { "aria-hidden": "true" } });
  const recruitCount = h("p", { class: "mono s-arc-count" });
  const recap = h("ol", { class: "s-recap", attrs: { hidden: true } });

  /* plan / apply */
  const sign = h("h2", { class: "display s-sign" });
  const signGlyph = h("span", { class: "s-sign-glyph", attrs: { "aria-hidden": "true" } });
  const dollWrap = h("div", { class: "s-doll-wrap" }, [doll()]);
  const wipe = h("div", { class: "s-wipe", attrs: { "aria-hidden": "true" } });
  const crossed = h("p", { class: "mono s-crossed" });
  const light = h("section", { class: "s-light", attrs: { hidden: true } }, [
    wipe,
    dollWrap,
    h("div", { class: "s-sign-row" }, [signGlyph, sign]),
    crossed,
  ]);

  /* the Glass Bridge */
  const bridgeClock = h("p", { class: "mono s-bridge-clock" });
  const bridgeRow = h("div", { class: "s-bridge-row", role: "list" });
  const bridgeWaves = h("div", { class: "s-waves" });
  const bridgeRecap = h("ol", { class: "s-bridge-recap", attrs: { hidden: true } });
  /**
   * The bridge sits in the ordinary document flow and the dormitory grid
   * steps aside for it, rather than the bridge being laid over the top.
   *
   * Plan / Apply's `.s-light` is `position: absolute; inset: 0` because in
   * that round the screen *is* the light — that is the round's whole design.
   * Nothing else on this surface may do it: a full-bleed panel over the grid
   * is how the big screen ends up showing an empty room, and it is a bug no
   * test can see. The bridge is the round's picture, so it takes the space
   * the grid was using and gives it back at the reveal.
   */
  const bridge = h("section", { class: "s-bridge", attrs: { hidden: true } }, [
    bridgeClock,
    bridgeRow,
    bridgeRecap,
    bridgeWaves,
  ]);

  /* the drain, verbatim */
  const drainLog = h("div", { class: "s-drain-log", attrs: { hidden: true } });

  const main = h("div", { class: "s-arc-main" }, [
    cue,
    recruitCount,
    cardLines,
    recap,
  ]);

  const node = h("section", { class: "s-stage s-arcade" }, [
    stair,
    h("div", { class: "s-arc-head" }, [kicker, title]),
    main,
    bridge,
    grid,
    counts,
    light,
    // After the light, deliberately: in Plan / Apply the screen *is* the
    // light and covers everything, and a drain during that round is exactly
    // when the error has to be readable. So it sits on top of it.
    drainLog,
  ]);

  let ticker: ReturnType<typeof setInterval> | null = null;
  let lastState: RenderState | null = null;
  let struck = new Set<string>();
  let drainTimer: ReturnType<typeof setTimeout> | null = null;

  const paintGrid = (state: RenderState, arcade: ArcadeView): void => {
    const entries = gridEntries(arcade, state.roster);
    replace(
      grid,
      entries.map((e) =>
        h(
          "div",
          {
            class: "s-cell",
            role: "listitem",
            attrs: {
              "data-standing": e.standing,
              "data-away": e.away ? "yes" : "no",
              "data-struck": e.struck ? "yes" : "no",
              // The number is the label. DESIGN.md: the nickname is on the
              // phone only, where the person it belongs to is the only reader.
              "aria-label": `${playerName(e.playerNumber)}${
                e.standing === "drained" ? ", in the Lounge" : ", on the Floor"
              }${e.backers > 0 ? `, backed by ${e.backers}` : ""}`,
            },
          },
          [
            h("span", { class: "mono s-cell-num", text: e.tag }),
            e.backers > 0
              ? h("span", { class: "mono s-cell-backers", text: `×${e.backers}` })
              : null,
          ],
        ),
      ),
    );
    setText(counts, `${arcade.onFloor} on the Floor · ${arcade.inLounge} in the Lounge`);
  };

  /**
   * A drain, verbatim, mono, red — the way it looks in a real terminal.
   *
   * SPEC.md asks for exactly that, and DESIGN.md bounds it: red is the show's
   * blood and ours is `--miss` coral, used only in the error beat. So this is
   * a short-lived line over the grid, not a state the screen sits in.
   */
  const paintDrains = (arcade: ArcadeView): void => {
    const now = new Set(
      arcade.grid.filter((c) => c.struck).map((c) => String(c.playerNumber)),
    );
    const fresh = [...now].filter((n) => !struck.has(n));
    struck = now;
    if (fresh.length === 0) return;
    const g = arcade.glass;
    /**
     * The bridge's own error, which DESIGN.md writes per player: *Pane 4 was
     * not tempered. Player 017 drained.*
     *
     * The pane it names is that player's own `position` — the step they were
     * facing — and never the bridge's open step: a drain for not stepping
     * arrives on the frame that has already moved the bridge on, so the open
     * step is one too far by the time this runs.
     *
     * Two ways off the bridge and two lines, told apart by whether the step
     * they were facing is still the open one. Falling is a pane that was not
     * tempered; running the clock out is a pane that was not chosen, and
     * telling somebody they stood on a pane they never touched would be the
     * screen making something up.
     *
     * *Which* of the two panes it was is not said, and is not known here —
     * see `ArcadeGlassView`. The room still has two waves in it who have not
     * crossed.
     */
    const glassLine = (n: number): string => {
      const cell = arcade.grid.find((c) => c.playerNumber === n);
      const at = (cell ? (g?.position?.[cell.pid] ?? 0) : 0) + 1;
      return g?.step === at - 1 ? HOUSE.glassFall(at, n) : HOUSE.glassTimeout(at, n);
    };
    // On the bridge the log goes *in the flow*, under the bridge, rather than
    // over the top of it. A panel laid over this surface is how the big
    // screen ends up showing the room an empty rectangle, and here it would
    // cover the one thing waves 2 and 3 are told to read — the pane labels,
    // and which of them broke. The bridge shrinks for four seconds instead.
    //
    // Three lines at most, because a step that closes can drain half a wave
    // and the room reads two lines of a terminal, not nine.
    setClass(drainLog, "inline", g !== undefined);
    replace(drainLog, [
      g ? null : h("p", { class: "mono s-drain-error", text: STATE_LOCK_ERROR }),
      ...fresh
        .map(Number)
        .sort((a, b) => a - b)
        .slice(0, g ? 3 : 6)
        .map((n) =>
          h("p", {
            class: "mono s-drain-who",
            text: g ? glassLine(n) : HOUSE.drained(n),
          }),
        ),
    ]);
    drainLog.hidden = false;
    if (drainTimer !== null) clearTimeout(drainTimer);
    // Four seconds: DESIGN.md's dwell floor, because video latency means a
    // thing that shows for two seconds was never seen.
    drainTimer = setTimeout(() => {
      drainLog.hidden = true;
      drainTimer = null;
    }, 4_000);
  };

  /**
   * The bridge: the room's shared picture, and the thing waves 2 and 3 are
   * legitimately reading.
   *
   * Six steps across, both pane labels in each, the pane that broke struck
   * through, and the player numbers standing on each step. Numbers and never
   * nicknames — DESIGN.md: "the nickname is on the phone only, where the
   * person it belongs to is the only reader."
   *
   * What is on this screen is what the whole room knows, which is why the
   * server treats it as the *only* public view of the round: this surface is
   * three metres from people who have not stepped yet. The pane that broke is
   * here only because the server does not send it until the step has closed.
   */
  const paintBridge = (state: RenderState, arcade: ArcadeView): void => {
    const g = arcade.glass;
    if (!g) {
      bridge.hidden = true;
      return;
    }
    bridge.hidden = false;
    const revealed = arcade.phase === "reveal";
    const { steps, across } = bridgeSteps(arcade, state.roster, g);

    // At the reveal the bridge has done its job and the room is reading the
    // answers, so the bridge row and the three waves step aside and the recap
    // takes the stage. Six steps, two notes each, squeezed under a bridge is
    // four steps nobody can read — which is the whole lesson of the round
    // going past at 1080p.
    bridgeRow.hidden = revealed;
    bridgeWaves.hidden = revealed;

    const left = remainingMs(g.stepEndsAt ?? null, serverNow());
    setText(
      bridgeClock,
      revealed
        ? "EIGHTEEN PANES. NINE ARE TEMPERED."
        : [
            `WAVE ${g.wave} OF 3`,
            `STEP ${(g.step ?? 0) + 1} OF ${g.of}`,
            `${g.waveSeconds[g.wave - 1] ?? 0}s A STEP`,
            left === null ? null : formatCountdown(left),
          ]
            .filter((x) => x !== null)
            .join(" · "),
    );

    replace(
      bridgeRow,
      [
        ...steps.map((step) =>
          h(
            "div",
            {
              class: "s-bridge-step",
              role: "listitem",
              attrs: {
                "data-open": step.open && !revealed ? "yes" : "no",
                "aria-label": `Step ${step.index + 1}${
                  step.broken === null
                    ? ""
                    : `, the ${step.broken === 0 ? "left" : "right"} pane broke`
                }${
                  step.standing.length === 0
                    ? ""
                    : `, ${step.standing.map((e) => playerName(e.playerNumber)).join(", ")} at this step`
                }`,
              },
            },
            [
              h("p", { class: "mono s-bridge-num", text: String(step.index + 1) }),
              h("p", { class: "s-bridge-product", text: step.product }),
              h(
                "div",
                { class: "s-bridge-panes" },
                [0, 1].map((side) =>
                  h("div", {
                    class: "s-bridge-pane",
                    attrs: { "data-broken": step.broken === side ? "yes" : "no" },
                  }, [
                    h("span", { class: "s-bridge-label", text: step.labels[side] ?? "" }),
                  ]),
                ),
              ),
              h(
                "div",
                { class: "mono s-bridge-who" },
                step.standing.map((e) =>
                  h("span", { class: "s-bridge-tag", text: e.tag }),
                ),
              ),
            ],
          ),
        ),
        h("div", { class: "s-bridge-far", role: "listitem" }, [
          h("p", { class: "s-bridge-far-mark", attrs: { "aria-hidden": "true" }, text: "▣" }),
          h("p", { class: "s-bridge-product", text: "THE FAR SIDE" }),
          h(
            "div",
            { class: "mono s-bridge-who" },
            across.map((e) => h("span", { class: "s-bridge-tag", text: e.tag })),
          ),
        ]),
      ],
    );

    // The three waves, which is how SPEC.md asks the room to read itself:
    // "by player number", with two cuts anybody can check against their own
    // badge. Wave 1 is labelled blind because that is what it is paid for.
    replace(
      bridgeWaves,
      waveRosters(arcade, state.roster, g).map((w) =>
        h(
          "div",
          {
            class: "s-wave",
            attrs: { "data-on": w.wave === g.wave && !revealed ? "yes" : "no" },
          },
          [
            h("p", { class: "mono s-wave-head" }, [
              h("span", { text: `WAVE ${w.wave}` }),
              h("span", { class: "s-wave-secs", text: `${w.seconds}s` }),
              w.wave === 1
                ? h("span", { class: "s-wave-blind", text: "BLIND" })
                : null,
            ]),
            h(
              "div",
              { class: "mono s-wave-tags" },
              w.members.map((e) =>
                h("span", {
                  class: "s-wave-tag",
                  text: e.tag,
                  attrs: {
                    "data-standing": e.standing,
                    "data-across": e.across ? "yes" : "no",
                    "data-away": e.away ? "yes" : "no",
                  },
                }),
              ),
            ),
          ],
        ),
      ),
    );

    // The reveal, which is the round's lesson and the only frame on which any
    // of this has existed. Both notes: the fake's is the joke and the real
    // one's is the thing somebody learns.
    const glassRecap = g.recap ?? [];
    bridgeRecap.hidden = glassRecap.length === 0;
    if (glassRecap.length > 0) {
      replace(
        bridgeRecap,
        glassRecap.map((step, i) =>
          h("li", { class: "s-bridge-recap-row" }, [
            h("span", { class: "mono s-bridge-recap-num", text: String(i + 1) }),
            h(
              "div",
              { class: "s-bridge-recap-panes" },
              [0, 1].map((side) =>
                h("div", {
                  class: "s-bridge-recap-pane",
                  attrs: { "data-real": step.real === side ? "yes" : "no" },
                }, [
                  h("span", {
                    class: "mono s-bridge-recap-mark",
                    attrs: { "aria-hidden": "true" },
                    text: step.real === side ? "○" : "□",
                  }),
                  h("span", { class: "s-bridge-recap-label", text: step.labels[side] ?? "" }),
                  h("span", { class: "s-bridge-recap-note", text: step.notes[side] ?? "" }),
                ]),
              ),
            ),
          ]),
        ),
      );
    }
  };

  const paintLight = (arcade: ArcadeView): void => {
    const pa = arcade.planApply;
    if (!pa || arcade.phase !== "running") {
      light.hidden = true;
      return;
    }
    light.hidden = false;
    const face = LIGHT_FACE[pa.light];
    setText(sign, face.sign);
    setText(signGlyph, face.glyph);
    setAttr(light, "data-light", pa.light);
    light.style.setProperty("--light", face.fill);
    light.style.setProperty("--light-ink", face.on);
    setText(crossed, `${pa.crossed ?? 0} of ${arcade.onFloor + arcade.inLounge} across`);

    // The wipe. Driven off the absolute epochs the server sent, never off a
    // duration measured from whenever this frame arrived — a screen that
    // received the frame 300 ms late must still finish the wipe at the
    // instant the lock actually lands.
    const f = wipeFraction(pa, serverNow());
    const turning = f !== null && f < 1;
    wipe.style.width = f === null ? "0%" : `${f * 100}%`;
    setClass(light, "is-turning", turning);
    // The head starts to turn with the wipe, which is the 400 ms of warning
    // the whole round depends on.
    dollWrap.style.setProperty("--turn", `${(f ?? (pa.light === "apply" ? 1 : 0)) * 180}deg`);
  };

  const paint = (state: RenderState): void => {
    const arcade = state.arcade;
    if (arcade === undefined) {
      setText(kicker, "Hashi Arcade");
      setText(title, "The next game will begin shortly.");
      replace(cardLines, []);
      replace(grid, []);
      bridge.hidden = true;
      setText(counts, "");
      light.hidden = true;
      recap.hidden = true;
      bridge.hidden = true;
      grid.hidden = false;
      counts.hidden = false;
      stair.hidden = false;
      return;
    }

    const roundLabel = arcade.round ? ARCADE_ROUND_LABEL[arcade.round] : "Hashi Arcade";
    setText(kicker, roundLabel.toUpperCase());
    // The bridge is the round's own picture and it takes the space the
    // dormitory grid was using — it is never laid over the top of it. Between
    // rounds the grid comes straight back, which is where the host leaves it.
    const onBridge =
      arcade.round === "glass_bridge" &&
      (arcade.phase === "running" || arcade.phase === "reveal");
    grid.hidden = onBridge;
    counts.hidden = onBridge;
    paintGrid(state, arcade);
    paintDrains(arcade);

    if (arcade.phase === "card" || arcade.phase === "idle") {
      stair.hidden = false;
      bridge.hidden = true;
      // Between rounds the headline is always the next game, never a count of
      // who is left — DESIGN.md is explicit that the grid says that, quietly.
      const between = arcade.phase === "idle";
      setText(title, between ? "" : roundLabel);
      const lines = between
        ? [HOUSE.roundEnd]
        : arcade.round
          ? ARCADE_ROUND_CARD[arcade.round]
          : ARCADE_ROUND_CARD.recruitment;
      replace(
        cardLines,
        [
          ...lines.map((line) =>
            h("p", { class: "mono s-house" }, [
              h("span", { class: "s-prompt", attrs: { "aria-hidden": "true" }, text: ">" }),
              h("span", { text: line }),
            ]),
          ),
          // The mask card, once, before Game 1.
          ...(!between && arcade.round === "plan_apply"
            ? [
                h(
                  "p",
                  { class: "mono s-staff" },
                  STAFF_CARD.map((l) => h("span", { class: "s-staff-line", text: l })),
                ),
              ]
            : []),
        ],
      );
      setText(cue, "");
      setText(recruitCount, "");
      recap.hidden = true;
      light.hidden = true;
      return;
    }

    stair.hidden = true;
    replace(cardLines, []);

    if (arcade.round === "glass_bridge") {
      // SPEC.md's own epigraph for the round, which is also the answer to
      // the question the room has been asking for three minutes.
      setText(
        title,
        arcade.phase === "reveal" ? "The tempered ones are real." : "",
      );
      setText(cue, "");
      setText(recruitCount, "");
      recap.hidden = true;
      light.hidden = true;
      paintBridge(state, arcade);
      return;
    }
    bridge.hidden = true;

    if (arcade.round === "plan_apply") {
      setText(title, "");
      setText(cue, "");
      setText(recruitCount, "");
      recap.hidden = arcade.phase !== "reveal";
      paintLight(arcade);
      if (arcade.phase === "reveal") {
        setText(title, HOUSE.roundEnd);
      }
      return;
    }

    light.hidden = true;
    const r = arcade.recruitment;
    if (!r) {
      setText(title, roundLabel);
      return;
    }
    if (arcade.phase === "reveal") {
      // SPEC.md: "At the end, the big screen 'recruits' everyone: the grid
      // fills with player numbers and the Front-End Man welcomes them." The
      // grid is already up; this is the welcome.
      setText(title, "Recruited.");
      setText(cue, "");
      setText(recruitCount, "");
      recap.hidden = (r.recap ?? []).length === 0;
      replace(
        recap,
        (r.recap ?? []).map((item) =>
          h("li", { class: "s-recap-row" }, [
            h("span", { class: "s-recap-cue", attrs: { "aria-hidden": "true" }, text: item.cue }),
            h("span", { class: "display s-recap-answer", text: item.answer }),
            h("span", { class: "s-recap-note", text: item.note }),
          ]),
        ),
      );
      return;
    }
    recap.hidden = true;
    setText(title, "");
    setText(cue, r.cue ?? "");
    setText(recruitCount, `${r.answered ?? 0} of ${r.eligible ?? 0} answered`);
  };

  ticker = setInterval(() => {
    // Only two things move without a frame arriving: the wipe, and the step's
    // countdown. Both are drawn off the absolute epochs the server sent.
    const a = lastState?.arcade;
    if (a?.round === "plan_apply" && a.phase === "running") paintLight(a);
    else if (a?.round === "glass_bridge" && a.phase === "running" && lastState) {
      const g = a.glass;
      const left = remainingMs(g?.stepEndsAt ?? null, serverNow());
      setText(
        bridgeClock,
        [
          `WAVE ${g?.wave ?? 1} OF 3`,
          `STEP ${(g?.step ?? 0) + 1} OF ${g?.of ?? 0}`,
          `${g?.waveSeconds[(g?.wave ?? 1) - 1] ?? 0}s A STEP`,
          left === null ? null : formatCountdown(left),
        ]
          .filter((x) => x !== null)
          .join(" · "),
      );
    }
  }, ARCADE_TICK_MS);

  return {
    node,
    update(state) {
      lastState = state;
      paint(state);
    },
    stop() {
      if (ticker !== null) clearInterval(ticker);
      ticker = null;
      if (drainTimer !== null) clearTimeout(drainTimer);
      drainTimer = null;
    },
  };
}

/**
 * Rank, name, total, and the contributions as one stacked bar in the activity
 * hues — the thing DESIGN.md asks the standings to keep from the live
 * scoreboard. A bar is readable at any resolution; the number is the bonus.
 *
 * Bench Credit is drawn hatched as well as dimmed, because nothing on this
 * surface may be conveyed by colour alone and a credited block is not the
 * same claim as a played one.
 */
function standingRow(
  row: StandingRow,
  top: number,
  activities: readonly ActivitySummary[],
): HTMLElement {
  const segments = stackedBar(row, activities, top);
  return h("li", { class: "s-row" }, [
    h("span", { class: "mono s-rank", text: String(row.rank) }),
    h("div", { class: "s-row-main" }, [
      h("span", { class: "display s-name-big", text: row.nickname }),
      h(
        "div",
        { class: "s-bar" },
        segments.map((seg) =>
          h("div", {
            class: seg.bench ? "s-seg s-seg-bench" : "s-seg",
            attrs: {
              style: `flex-basis:${seg.percent}%;background:${seg.hue}`,
              // Not read aloud anywhere, but it keeps the DOM honest about
              // what each block is when someone inspects a recording.
              "data-activity": seg.key,
            },
          }),
        ),
      ),
    ]),
    h("span", { class: "mono s-total", text: String(row.total) }),
  ]);
}

/** Which hue is which activity, in words. Three chips, ≥ 32px, no legend key. */
function activityLegend(activities: readonly ActivitySummary[]): HTMLElement[] {
  const chips = activities.map((a, i) =>
    h("span", { class: "s-legend-item" }, [
      h("span", {
        class: "s-legend-swatch",
        attrs: { style: `background:${activityHue(a, i)}`, "aria-hidden": "true" },
      }),
      h("span", { class: "s-legend-label", text: a.title }),
    ]),
  );
  chips.push(
    h("span", { class: "s-legend-item" }, [
      h("span", {
        class: "s-legend-swatch",
        attrs: { style: "background:var(--spot)", "aria-hidden": "true" },
      }),
      h("span", { class: "s-legend-label", text: "Spot Awards" }),
    ]),
  );
  return chips;
}

function sceneStandings(): Scene {
  const list = h("ol", { class: "s-rows" });
  const legend = h("div", { class: "s-legend" });
  const empty = h("p", { class: "s-line", text: "No scores yet." });
  const node = h("section", { class: "s-stage s-standings" }, [
    h("p", { class: "s-kicker label", text: "Standings · top five" }),
    list,
    legend,
    empty,
  ]);
  return {
    node,
    update(state) {
      // Exactly what arrived. The top five and the seal are the server's
      // rules; a screen that trimmed the list would be enforcing them twice.
      empty.hidden = state.standings.length > 0;
      legend.hidden = state.standings.length === 0;
      const top = state.standings[0]?.total ?? 0;
      replace(
        list,
        state.standings.map((row) => standingRow(row, top, state.activities)),
      );
      replace(legend, activityLegend(state.activities));
    },
  };
}

function sceneSealed(): Scene {
  const line = h("p", { class: "s-line s-line-big" });
  const node = h("section", { class: "s-stage s-sealed" }, [
    h("div", { class: "s-lock" }, [lockGlyph("s-lock-glyph")]),
    h("h1", { class: "display s-title s-title-huge", text: "Scores are hidden" }),
    line,
  ]);
  return {
    node,
    update(state) {
      setText(line, state.holding?.line ?? "");
      line.hidden = (state.holding?.line ?? "") === "";
    },
  };
}

/**
 * The final reveal: 5th, 4th, 3rd, 2nd — then a hold on an empty first slot
 * for longer than is comfortable — then the winner.
 *
 * Each step is a hard cut with a four-second dwell, because video latency is
 * one to two seconds and a thing that shows for two seconds was never seen.
 * The pace is local; the host pacing it with the space bar needs a message
 * this protocol does not have yet.
 */
const DWELL_MS = 4_000;
const EMPTY_FIRST_HOLD_MS = 7_000;

function sceneFinal(): Scene {
  const list = h("ol", { class: "s-rows s-final-rows" });
  const winnerName = h("p", { class: "display s-winner-name" });
  const winnerTotal = h("p", { class: "mono s-winner-total" });
  const winnerBar = h("div", { class: "s-bar s-winner-bar" });
  const winner = h("div", { class: "s-winner", attrs: { hidden: true } }, [
    h("p", { class: "s-kicker label", text: "The winner" }),
    winnerName,
    winnerTotal,
    winnerBar,
  ]);
  const legend = h("div", { class: "s-legend" });
  const node = h("section", { class: "s-stage s-final" }, [
    h("p", { class: "s-kicker label", text: "Final standings" }),
    list,
    winner,
    legend,
  ]);

  let timers: ReturnType<typeof setTimeout>[] = [];
  let signature = "";

  const play = (
    rows: readonly StandingRow[],
    activities: readonly ActivitySummary[],
  ): void => {
    for (const t of timers) clearTimeout(t);
    timers = [];
    replace(list, []);
    winner.hidden = true;
    replace(legend, rows.length === 0 ? [] : activityLegend(activities));

    if (rows.length === 0) {
      replace(list, [h("p", { class: "s-line", text: "No scores were recorded." })]);
      return;
    }

    const top = rows[0]?.total ?? 0;
    // Bottom to top: 5th first, 1st last.
    const climb = [...rows].reverse().filter((r) => r.rank > 1);
    climb.forEach((row, i) => {
      timers.push(
        setTimeout(() => {
          list.insertBefore(standingRow(row, top, activities), list.firstChild);
        }, i * DWELL_MS),
      );
    });
    const first = rows.find((r) => r.rank === 1);
    if (!first) return;
    timers.push(
      setTimeout(
        () => {
          setText(winnerName, first.nickname);
          setText(winnerTotal, String(first.total));
          // The winner gets the breakdown too: how they got there is the
          // thing the host talks over while it is on screen.
          replace(
            winnerBar,
            stackedBar(first, activities, top).map((seg) =>
              h("div", {
                class: seg.bench ? "s-seg s-seg-bench" : "s-seg",
                attrs: {
                  style: `flex-basis:${seg.percent}%;background:${seg.hue}`,
                  "data-activity": seg.key,
                },
              }),
            ),
          );
          winner.hidden = false;
        },
        climb.length * DWELL_MS + EMPTY_FIRST_HOLD_MS,
      ),
    );
  };

  return {
    node,
    update(state) {
      // Replay only when the result actually changes, never on every broadcast.
      const sig = state.standings
        .map((r) => `${r.rank}:${r.nickname}:${r.total}:${JSON.stringify(r.perActivity)}:${r.spot}`)
        .join("|");
      if (sig === signature) return;
      signature = sig;
      play(state.standings, state.activities);
    },
    stop() {
      for (const t of timers) clearTimeout(t);
      timers = [];
    },
  };
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(kind: "spot" | "text", text: string): void {
  if (toastTimer !== null) clearTimeout(toastTimer);
  replace(toastBar, [
    kind === "spot" ? h("span", { class: "label s-toast-kind", text: "Spot Award" }) : null,
    h("span", { class: "s-toast-text", text }),
  ]);
  toastBar.hidden = false;
  toastBar.dataset["kind"] = kind;
  // Six seconds: comfortably past the four-second dwell floor.
  toastTimer = setTimeout(() => {
    toastBar.hidden = true;
  }, 6_000);
}

/* ------------------------------------------------------------------ */

/**
 * The top five and the seal are the server's rules. The screen renders what
 * arrives, so if more than five rows — or any row at all while sealed — ever
 * turn up, that is a bug to fix on the wire and not something to quietly
 * paper over here. Shout, render honestly.
 */
function guardPublic(state: RenderState): void {
  if (state.standings.length > 5) {
    console.error(
      `protocol violation: the screen received ${state.standings.length} standings rows; the wire must carry at most 5`,
    );
  }
  if (state.seal === "sealed" && state.standings.length > 0) {
    console.error(
      "protocol violation: standings arrived while sealed; sealed means no surface shows them",
    );
  }
  if (state.hostExtras !== undefined) {
    console.error("protocol violation: the screen received hostExtras");
  }
  // The room's screen is in the room. It learns the answer at the reveal and
  // not before, the same as every phone in front of it.
  if (state.trivia !== undefined && state.trivia.phase !== "revealed") {
    if (state.trivia.correct !== undefined) {
      console.error(
        "protocol violation: the screen received the correct answer before the reveal",
      );
    }
    if (state.trivia.distribution !== undefined) {
      console.error(
        "protocol violation: the screen received the distribution before the reveal",
      );
    }
  }
}

client = new QuorumClient({
  hello: () => ({ t: "hello", role: "screen", screenToken }),
  ...(mock ? { transport: mockTransport(mock) } : {}),

  onState(state) {
    guardPublic(state);
    render(state);
  },

  onStatus(status) {
    // Never a modal, and never anything about the network unless it is wrong.
    const bad = status === "reconnecting";
    banner.hidden = !bad;
    if (bad) setText(banner, "reconnecting");
  },

  onToast: showToast,

  onRefused(reason, message) {
    replace(stage, [
      h("section", { class: "s-stage s-card" }, [
        h("p", { class: "s-kicker label", text: "Quorum" }),
        h("h1", { class: "display s-title", text: "Refused" }),
        h("p", { class: "s-line", text: `${reason}: ${message}` }),
      ]),
    ]);
  },
});

client.start();
