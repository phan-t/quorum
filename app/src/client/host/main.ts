/**
 * The host console. Served at `/host`, token in the URL **fragment** so it is
 * never in a request line, an access log or a referrer.
 *
 * The design goal is glanceable: the host looks at this for two seconds
 * between sentences and has to know what is happening and what to press. So:
 * one primary button, always in the same place, always bound to space, always
 * labelled with what it will do; everything destructive two-step and never on
 * space; refusals inline in the button that caused them.
 */

import type {
  ArcadePlanApplyView,
  ArcadeRecruitmentView,
  ArcadeView,
  HostCommand,
  RenderState,
  RosterEntry,
  TriviaView,
} from "../../protocol.ts";
import { initTheme, themeToggle } from "../shared/theme.ts";
import type { ArcadePhase, ArcadeRoundKind, Seal, Segment } from "../../engine/types.ts";
import { h, keyedList, qs, replace, setAttr, setText } from "../shared/dom.ts";
import { QuorumClient } from "../shared/net.ts";
import { mockBadge, mockTransport, readMockConfig } from "../shared/mock.ts";
import {
  ARCADE_ROUND_LABEL,
  ARCADE_ROUND_NUMBER,
  LIGHT_FACE,
  SEGMENTS,
  SEGMENT_BUILT,
  SEGMENT_LABEL,
  SEGMENT_PHASE,
  answerTiles,
  bridgeEntries,
  formatCountdown,
  gridEntries,
  itemEndsAt,
  nextSegment,
  playerTag,
  questionLabel,
  remainingMs,
} from "../shared/view.ts";
import { bindEscape, bindSpace, control, primaryControl, type Control } from "./controls.ts";
import { createScoringPanel } from "./scoring.ts";
import { createParticipantView } from "../participant/view.ts";

initTheme();

document.title = "DO NOT SHARE · Quorum host";

const mock = readMockConfig();
const app = qs<HTMLElement>("#app");

/** The fragment never leaves the browser. That is the whole reason it is here. */
function readToken(): string {
  const raw = location.hash.replace(/^#/, "");
  if (raw === "") return "";
  if (raw.includes("=")) return new URLSearchParams(raw).get("token") ?? "";
  return raw;
}

const hostToken = readToken() || (mock ? "mock-host-token" : "");
if (hostToken === "") {
  replace(app, [
    h("div", { class: "gate" }, [
      h("p", { class: "label", text: "Quorum host" }),
      h("h1", { class: "display", text: "This console needs its token" }),
      h("p", {
        class: "gate-note",
        text: "Open it as /host#<host token>. Everything after the # stays in this browser, so the token never reaches a server log. Add ?mock=1 to drive a fake session instead.",
      }),
    ]),
  ]);
  throw new Error("no host token");
}

/* ------------------------------------------------------------------ */
/* Chrome                                                              */
/* ------------------------------------------------------------------ */

const elTitle = h("span", { class: "sb-title" });
const elCode = h("span", { class: "sb-code mono" });
const elCounts = h("span", { class: "sb-counts mono" });
const elScoreboard = h("span", { class: "sb-seal mono" });
const elPhase = h("span", { class: "sb-phase mono" });

/**
 * The scoreboard's three states, said as what the room can see.
 *
 * The engine calls these live / sealed / revealed and SCORING.md keeps that
 * word, because sealing is a real mechanic and not a display toggle. The
 * status bar is not the place to teach it: the host glances here to answer
 * "can they see the scores right now", and only one of these three words
 * answers that on its own.
 */
const SCOREBOARD_STATE: Readonly<Record<Seal, string>> = {
  live: "● SCOREBOARD LIVE",
  sealed: "■ SCOREBOARD HIDDEN",
  revealed: "● WINNERS REVEALED",
};

const elConn = h("span", { class: "sb-conn mono", attrs: { hidden: true } });

const elTheme = themeToggle();

const statusBar = h("header", { class: "statusbar" }, [
  h("span", { class: "sb-warn mono", text: "⚠ DO NOT SHARE" }),
  elTitle,
  elCode,
  elCounts,
  elPhase,
  elConn,
  elScoreboard,
  elTheme,
]);

const railSegments = h("ul", { class: "rail-list" });
const railRoster = h("ul", { class: "roster" });
const railCount = h("span", { class: "mono rail-count" });

const rail = h("aside", { class: "rail" }, [
  h("section", { class: "rail-block" }, [
    h("p", { class: "label", text: "Run of show" }),
    railSegments,
  ]),
  h("section", { class: "rail-block rail-grow" }, [
    h("p", { class: "label" }, ["Participants ", railCount]),
    railRoster,
  ]),
]);

const panelKind = h("span", { class: "label" });
const panelSub = h("span", { class: "mono panel-sub" });
const panelBody = h("div", { class: "panel-body" });
const footLeft = h("div", { class: "foot-left" });
const primary = primaryControl((c) => {
  const plan = primaryPlan();
  if (plan.cmd === null) return;
  issue(plan.cmd, c);
});

/**
 * Scoring is not a segment. Manual entry and Spot Awards happen from the
 * console while whatever segment is up stays up — typically the holding card
 * during the TTX, or the standings between activities — so the grid lives
 * below the segment body rather than replacing it.
 */
const scoring = createScoringPanel({ issue: (cmd, from) => issue(cmd, from) });

const panel = h("main", { class: "panel" }, [
  h("div", { class: "panel-head" }, [panelKind, panelSub]),
  panelBody,
  scoring.el,
  h("div", { class: "panel-foot" }, [footLeft, primary.el]),
]);

const preview = createParticipantView({
  compact: true,
  // No `onAnswer`: the preview is a picture of a participant's screen, not
  // one. It must not be able to answer the question the host is running.
  now: () => client?.now() ?? Date.now(),
});
const toastList = h("ul", { class: "toasts" });
const tray = h("aside", { class: "tray" }, [
  h("div", { class: "tray-preview" }, [
    h("p", { class: "label", text: "Participant preview" }),
    h("div", { class: "preview-frame" }, [preview.root]),
  ]),
  h("div", { class: "tray-toasts" }, [
    h("p", { class: "label", text: "Recent" }),
    toastList,
  ]),
]);

replace(app, [statusBar, h("div", { class: "cols" }, [rail, panel, tray])]);
if (mock) document.body.appendChild(mockBadge());

/* ------------------------------------------------------------------ */
/* Controls that are always there                                      */
/* ------------------------------------------------------------------ */

const lockControl = control({
  label: "Lock joining",
  className: "ctl-secondary",
  onFire: (c) => issue({ name: "lobby.lock", locked: !lastState?.joinsLocked }, c),
});

/**
 * The seal, said as what it does to the room.
 *
 * SCORING.md keeps the word "seal" and so does the Desktop — it is the
 * mechanic's name. The console does not: the person driving it needs to know
 * that pressing this takes the scoreboard away from thirty people, and
 * "Seal standings" does not say that to somebody who has not read SCORING.md.
 *
 * One button, two jobs, so the confirm asks about the job in hand: hiding it
 * and running the 5-to-1 reveal are not the same promise.
 */
const sealControl = control({
  label: "Hide the scoreboard",
  className: "ctl-secondary ctl-seal",
  question: () =>
    (lastState?.seal ?? "live") === "live"
      ? "Hide it from the room?"
      : "Count down 5 to 1 now?",
  onFire: (c) => {
    const seal = lastState?.seal ?? "live";
    issue({ name: "seal", state: seal === "live" ? "sealed" : "revealed" }, c);
  },
});

const unsealControl = control({
  label: "Show the scoreboard again",
  className: "ctl-secondary",
  question: "Put it back in front of the room?",
  onFire: (c) => issue({ name: "seal", state: "live" }, c),
});

const closeControl = control({
  label: "Close session",
  className: "ctl-danger",
  question: "Really close?",
  onFire: (c) => issue({ name: "close" }, c),
});

replace(footLeft, [
  lockControl.el,
  sealControl.el,
  unsealControl.el,
  closeControl.el,
]);

/* ------------------------------------------------------------------ */
/* Run of show rail                                                    */
/* ------------------------------------------------------------------ */

const segmentRows = new Map<Segment, { li: HTMLLIElement; button: HTMLButtonElement }>();
for (const seg of SEGMENTS) {
  const button = h("button", { class: "seg", type: "button" }, [
    h("span", { class: "seg-mark", text: "○" }),
    h("span", { class: "seg-name", text: SEGMENT_LABEL[seg] }),
    SEGMENT_BUILT[seg]
      ? null
      : h("span", { class: "seg-phase mono", text: `P${SEGMENT_PHASE[seg]}` }),
  ]);
  button.addEventListener("click", () => issue({ name: "segment", kind: seg }, null));
  const li = h("li", {}, [button]);
  railSegments.appendChild(li);
  segmentRows.set(seg, { li, button });
}

/* ------------------------------------------------------------------ */
/* Roster                                                              */
/* ------------------------------------------------------------------ */

interface RosterRow {
  el: HTMLLIElement;
  dot: HTMLElement;
  name: HTMLElement;
  num: HTMLElement;
}
const rosterRows = new WeakMap<HTMLElement, RosterRow>();

const roster = keyedList<RosterEntry>(
  railRoster,
  (r) => r.pid,
  (r) => {
    const dot = h("span", { class: "dot", attrs: { "data-conn": r.conn } });
    // textContent, always. A nickname is whatever somebody typed.
    const name = h("span", { class: "r-name" });
    const num = h("span", { class: "r-num mono" });
    const kick = control({
      label: "kick",
      className: "ctl-row ctl-danger",
      question: "Kick?",
      onFire: (c) => issue({ name: "participant.kick", pid: r.pid }, c),
    });
    const release = control({
      // One word, not "free name". Two words plus "kick" cover the nickname on
      // a 132px row, so the host could not read *who* they were about to act
      // on while the confirm was armed — a worse failure than the jargon this
      // replaced ("release"), because freeing the wrong person's name is
      // silent. The confirm names them instead.
      label: "free",
      className: "ctl-row",
      question: `Free ${r.nickname}'s name?`,
      title:
        "Frees their nickname so they can take it back when they reconnect, or on another device",
      onFire: (c) => issue({ name: "participant.release", pid: r.pid }, c),
    });
    const el = h("li", { class: "r-row" }, [
      dot,
      name,
      num,
      h("span", { class: "r-actions" }, [release.el, kick.el]),
    ]);
    rosterRows.set(el, { el, dot, name, num });
    return el;
  },
  (el, r) => {
    const row = rosterRows.get(el);
    if (!row) return;
    setAttr(row.dot, "data-conn", r.conn);
    setText(row.name, r.nickname);
    setText(row.num, String(r.playerNumber).padStart(3, "0"));
    el.classList.toggle("away", r.conn === "away");
  },
);

/* ------------------------------------------------------------------ */
/* Panel bodies — built once, so the holding fields keep what is typed  */
/* ------------------------------------------------------------------ */

const bodyLobbyCode = h("span", { class: "mono join-code" });
const bodyLobbyUrl = h("span", { class: "mono join-url" });
const bodyLobbyCount = h("span", { class: "mono big-num" });
const bodyLobbyLock = h("span", { class: "mono lock-state" });
const bodyLobby = h("section", { class: "pb" }, [
  h("div", { class: "kv" }, [
    h("span", { class: "label", text: "Join code" }),
    bodyLobbyCode,
  ]),
  h("div", { class: "kv" }, [
    h("span", { class: "label", text: "Join link" }),
    bodyLobbyUrl,
  ]),
  h("div", { class: "kv" }, [
    h("span", { class: "label", text: "Joined" }),
    bodyLobbyCount,
  ]),
  h("div", { class: "kv" }, [
    h("span", { class: "label", text: "Joining" }),
    bodyLobbyLock,
  ]),
]);

const holdingTitle = h("input", {
  class: "field",
  type: "text",
  placeholder: "Agentic Security TTX",
  attrs: { maxlength: "80", "aria-label": "Holding card title" },
});
const holdingLine = h("input", {
  class: "field",
  type: "text",
  placeholder: "Back at 14:20. Prize: the good coffee.",
  attrs: { maxlength: "140", "aria-label": "Holding card second line" },
});
const holdingApply = control({
  label: "Show it to the room",
  className: "ctl-secondary",
  onFire: (c) =>
    issue(
      { name: "holding", title: holdingTitle.value.trim(), line: holdingLine.value.trim() },
      c,
    ),
});
const holdingClear = control({
  label: "Clear the card",
  className: "ctl-secondary",
  onFire: (c) => {
    holdingTitle.value = "";
    holdingLine.value = "";
    issue({ name: "holding", title: "", line: "" }, c);
  },
});
/** True while the host is editing, so an inbound state does not eat keystrokes. */
let holdingDirty = false;
for (const field of [holdingTitle, holdingLine]) {
  field.addEventListener("input", () => {
    holdingDirty = true;
  });
  field.addEventListener("keydown", (ev) => {
    if ((ev as KeyboardEvent).key !== "Enter") return;
    holdingApply.el.querySelector("button")?.click();
  });
}
const bodyHolding = h("section", { class: "pb" }, [
  h("label", { class: "field-row" }, [
    h("span", { class: "label", text: "Title" }),
    holdingTitle,
  ]),
  h("label", { class: "field-row" }, [
    h("span", { class: "label", text: "Second line" }),
    holdingLine,
  ]),
  h("div", { class: "field-actions" }, [holdingApply.el, holdingClear.el]),
  h("p", {
    class: "pb-note",
    text: "This is the slide the room sits in front of between activities. It goes up the moment you press Show it to the room, and the participant preview on the right is what they see.",
  }),
]);

const standingsRows = h("ol", { class: "h-rows" });
const standingsNote = h("p", { class: "pb-note" });
const bodyStandings = h("section", { class: "pb" }, [standingsRows, standingsNote]);

const bodyPending = h("section", { class: "pb" }, [
  h("p", { class: "pb-note pb-warn" }),
]);

/* ---- trivia ---- */

/**
 * Sudden death is armed here and rides out on the next `trivia.open`, because
 * that is the only event the engine has for it. It is a property of the
 * question, fixed the instant it opens: flipping it mid-question would change
 * the rules under people who have already answered.
 */
let suddenDeathArmed = false;

const triviaHead = h("p", { class: "mono t-head-line" });
const triviaQuestion = h("p", { class: "t-q" });
const triviaRound = h("p", { class: "t-round-card", attrs: { hidden: true } });
const triviaAnswers = h("ul", { class: "t-answers" });
const triviaCounts = h("p", { class: "mono t-counts" });
const triviaNote = h("p", { class: "pb-note t-note", attrs: { hidden: true } });
const triviaWaiting = h("p", { class: "mono t-waiting", attrs: { hidden: true } });

/**
 * The question set. SPEC: "Questions load per session. Editing a loaded set
 * means re-uploading; there is no in-app editor by design."
 *
 * Errors are line-numbered and listed here rather than flashed in a button,
 * because a button shows one line for three seconds and a rejected CSV has
 * four things wrong with it on four different rows.
 */
const triviaUpload = h("input", {
  class: "field t-upload",
  type: "file",
  attrs: { accept: ".csv,text/csv", "aria-label": "Trivia question CSV" },
}) as HTMLInputElement;
const triviaUploadNote = h("p", { class: "pb-note" });
const triviaErrors = h("ul", { class: "t-errors", attrs: { hidden: true } });

triviaUpload.addEventListener("change", () => {
  const file = triviaUpload.files?.[0];
  if (!file || lastState === null) return;
  const sid = lastState.sid;
  setText(triviaUploadNote, `Loading ${file.name}…`);
  triviaErrors.hidden = true;
  void file
    .text()
    .then((text) =>
      fetch(`/api/sessions/${encodeURIComponent(sid)}/content/trivia`, {
        method: "POST",
        // The token travels in a header, never a query string: the whole
        // reason it lives in the URL fragment is to stay out of access logs.
        headers: { authorization: `Bearer ${hostToken}`, "content-type": "text/csv" },
        body: text,
      }),
    )
    .then(async (res) => {
      const body = (await res.json().catch(() => ({}))) as {
        questions?: number;
        errors?: string[];
        message?: string;
        error?: string;
      };
      if (res.ok) {
        setText(triviaUploadNote, `${body.questions ?? 0} questions loaded.`);
        triviaErrors.hidden = true;
        return;
      }
      setText(triviaUploadNote, body.message ?? "That file was not loaded.");
      const lines = body.errors ?? [body.error ?? "Upload failed."];
      triviaErrors.hidden = lines.length === 0;
      replace(triviaErrors, lines.map((line) => h("li", { text: line })));
    })
    .catch(() => setText(triviaUploadNote, "Upload failed. Check the connection."))
    .finally(() => {
      // Cleared so re-uploading the same corrected file still fires `change`.
      triviaUpload.value = "";
    });
});

const closeEarly = control({
  label: "Close early",
  className: "ctl-secondary",
  title: "Stops the question now. It closes on its own when the timer runs out.",
  onFire: (c) => issue({ name: "trivia.close" }, c),
});

const suddenDeath = control({
  label: "Sudden death: off",
  className: "ctl-secondary",
  title:
    "First correct answer wins. No timer, and nobody's score changes. Takes effect on the next question you open.",
  onFire: (c) => {
    suddenDeathArmed = !suddenDeathArmed;
    c.setLabel(`Sudden death: ${suddenDeathArmed ? "on" : "off"}`);
    c.el.classList.toggle("on", suddenDeathArmed);
    if (lastState) render(lastState);
  },
});

const triviaLoad = h("div", { class: "t-load" }, [
  h("label", { class: "label", text: "Question set (CSV)" }),
  triviaUpload,
  triviaUploadNote,
  triviaErrors,
]);

const bodyTrivia = h("section", { class: "pb pb-trivia" }, [
  triviaHead,
  triviaRound,
  triviaQuestion,
  triviaAnswers,
  triviaCounts,
  triviaNote,
  triviaWaiting,
  h("div", { class: "field-actions" }, [closeEarly.el, suddenDeath.el]),
  triviaLoad,
]);

/* ---- arcade ---- */

/**
 * The console's arcade panel: pick the round, set it up, run the card → play
 * → reveal, and watch the Floor/Lounge split.
 *
 * The picker is a local choice until the host presses the primary button,
 * because `startRound` is what commits it and a round that started because
 * somebody clicked a radio would be a round nobody meant to start. The two
 * built rounds are selectable; the other four are listed and disabled, so the
 * host can see the shape of the run of show without being able to start
 * something that does not exist.
 */
const ARCADE_ROUNDS: readonly ArcadeRoundKind[] = [
  "recruitment",
  "plan_apply",
  "unseal",
  "tug_of_raft",
  "gganbu",
  "glass_bridge",
];

/**
 * What each round actually is, in one line, for a host who has never seen the
 * show and has never run Terraform.
 *
 * The names stay: the room sees them, they are on the round cards, and they
 * are the joke. But a picker of six in-jokes is a picker nobody can choose
 * from, so every pill carries the game underneath its name. Each line is the
 * mechanic from SPEC.md's round table, said as the thing the player does.
 */
const ARCADE_ROUND_WHAT: Readonly<Record<ArcadeRoundKind, string>> = {
  recruitment: "Two emoji, one product name — type it. Six items, nobody is knocked out.",
  plan_apply: "Tap fast while the light is green. Stop the moment it turns. Tapping on red knocks you out.",
  unseal: "Pick a shape, then tap the scrambled letters in order. One wrong tap and you are out.",
  tug_of_raft: "Tug of war. Two teams, one rope — tap on the beat. Nobody is knocked out.",
  gganbu: "Paired off. Six over-or-under questions, and you bet tokens against your partner.",
  glass_bridge: "Pick the real product feature, twice per step. Pick the fake one and you are out.",
};

/** The round's state, as the thing that is happening in the room. */
const ARCADE_PHASE_WORD: Readonly<Record<ArcadePhase, string>> = {
  idle: "NOT STARTED",
  card: "CARD ON SCREEN",
  running: "PLAYING",
  reveal: "RESULTS ON SCREEN",
};

const ARCADE_BUILT: Readonly<Record<ArcadeRoundKind, boolean>> = {
  recruitment: true,
  plan_apply: true,
  unseal: false,
  tug_of_raft: false,
  gganbu: false,
  glass_bridge: true,
};

type ArcadePick = "recruitment" | "plan_apply" | "glass_bridge";

let arcadePick: ArcadePick = "recruitment";

const arcadePicker = h("div", { class: "a-picker", role: "radiogroup" });
const arcadePickButtons = new Map<ArcadeRoundKind, HTMLButtonElement>();
for (const kind of ARCADE_ROUNDS) {
  const built = ARCADE_BUILT[kind];
  const button = h("button", {
    class: built ? "a-pick" : "a-pick is-unbuilt",
    type: "button",
    disabled: !built,
    attrs: {
      role: "radio",
      "aria-checked": "false",
      title: built ? "" : "Designed, not built yet — you cannot start this one",
    },
  }, [
    h("span", { class: "a-pick-name", text: ARCADE_ROUND_LABEL[kind] }),
    h("span", { class: "a-pick-what", text: ARCADE_ROUND_WHAT[kind] }),
    built ? null : h("span", { class: "mono a-pick-todo", text: "not built yet" }),
  ]) as HTMLButtonElement;
  if (built) {
    button.addEventListener("click", () => {
      arcadePick = kind as ArcadePick;
      if (lastState) render(lastState);
    });
  }
  arcadePickButtons.set(kind, button);
  arcadePicker.appendChild(button);
}

const arcadeSeconds = h("input", {
  class: "field field-num",
  type: "number",
  value: "20",
  attrs: { min: "5", max: "60", "aria-label": "Seconds per item" },
}) as HTMLInputElement;
const arcadeTarget = h("input", {
  class: "field field-num",
  type: "number",
  value: "120",
  attrs: { min: "10", max: "999", "aria-label": "Taps to finish" },
}) as HTMLInputElement;
const arcadeFloorSeconds = h("input", {
  class: "field field-num",
  type: "number",
  value: "75",
  attrs: { min: "15", max: "300", "aria-label": "Seconds of play" },
}) as HTMLInputElement;

const arcadeRecruitCfg = h("div", { class: "a-cfg" }, [
  h("label", { class: "field-row" }, [
    h("span", { class: "label", text: "Seconds per item" }),
    arcadeSeconds,
  ]),
  h("p", {
    class: "pb-note",
    text: "Six items, timed one after another. You do not have to press anything.",
  }),
]);
const arcadePlanCfg = h("div", { class: "a-cfg" }, [
  h("label", { class: "field-row" }, [
    h("span", { class: "label", text: "Taps to finish" }),
    arcadeTarget,
  ]),
  h("label", { class: "field-row" }, [
    h("span", { class: "label", text: "Seconds of play" }),
    arcadeFloorSeconds,
  ]),
  h("p", {
    class: "pb-note",
    text: "At 120 taps about half the room finishes. The light changes on its own every 2–6 seconds, and the Desktop shows everyone a warning just before it turns.",
  }),
]);

/**
 * The Glass Bridge's three step timers, and nothing else.
 *
 * The eighteen panes are not a host setting and are not on the wire: they
 * carry which pane is real and both reveal notes, so a console that could
 * choose them would be a console the answer key travels through. SPEC.md
 * tunes the three waves to 12 / 9 / 6, which is the asymmetry the round is
 * built on — wave 1 goes blind and slowest, wave 3 goes last and fastest.
 */
const arcadeWave1 = h("input", {
  class: "field field-num",
  type: "number",
  value: "12",
  attrs: { min: "3", max: "60", "aria-label": "Seconds a step, wave 1" },
}) as HTMLInputElement;
const arcadeWave2 = h("input", {
  class: "field field-num",
  type: "number",
  value: "9",
  attrs: { min: "3", max: "60", "aria-label": "Seconds a step, wave 2" },
}) as HTMLInputElement;
const arcadeWave3 = h("input", {
  class: "field field-num",
  type: "number",
  value: "6",
  attrs: { min: "3", max: "60", "aria-label": "Seconds a step, wave 3" },
}) as HTMLInputElement;

const arcadeGlassCfg = h("div", { class: "a-cfg" }, [
  // One row, not three. The console's panel scrolls, and every row this
  // block spends is a row the round's own controls are pushed below the fold
  // by — which is a button the host cannot press while the bridge is running.
  h("div", { class: "a-cfg-row" }, [
    h("label", { class: "a-cfg-cell" }, [
      h("span", { class: "label", text: "Wave 1 · s" }),
      arcadeWave1,
    ]),
    h("label", { class: "a-cfg-cell" }, [
      h("span", { class: "label", text: "Wave 2 · s" }),
      arcadeWave2,
    ]),
    h("label", { class: "a-cfg-cell" }, [
      h("span", { class: "label", text: "Wave 3 · s" }),
      arcadeWave3,
    ]),
  ]),
  h("p", {
    class: "pb-note",
    text: "Six steps, two panes to choose from at each. The room crosses in three groups, split by player number, and each step ends on its own clock. The two buttons below are for cutting one short.",
  }),
]);

/** The bridge, as the host reads it out: the step, the clock and the answer. */
const arcadeBridge = h("div", { class: "a-bridge-host", attrs: { hidden: true } });

const arcadeState = h("p", { class: "mono t-head-line" });
const arcadeSplit = h("div", { class: "a-split" });
const arcadeFloorList = h("p", { class: "mono a-floor-list" });
const arcadeBacking = h("ul", { class: "a-backing" });
const arcadeItem = h("p", { class: "a-item" });
const arcadeNote = h("p", { class: "pb-note a-note", attrs: { hidden: true } });

const arcadeEnd = control({
  label: "End the round",
  className: "ctl-secondary",
  title: "Stops play now. This happens on its own when the clock runs out.",
  onFire: (c) => issue({ name: "arcade.end" }, c),
});
const arcadeNext = control({
  label: "Skip to the next item",
  className: "ctl-secondary",
  title: "Recruitment only. Moves everyone on to the next item; the timer does this on its own.",
  onFire: (c) => issue({ name: "arcade.next" }, c),
});
const arcadeNextStep = control({
  label: "Close the step",
  className: "ctl-secondary",
  title:
    "The Glass Bridge only. Ends the step everyone is on: anyone who has not picked is out, the broken pane is shown, and the next step opens. The step clock does this on its own.",
  onFire: (c) => issue({ name: "arcade.nextStep" }, c),
});
const arcadeNextWave = control({
  label: "Send the next wave",
  className: "ctl-secondary",
  title:
    "The Glass Bridge only. Ends this group's step and sends the next group of players onto the bridge. Use it when everyone still going in this group is out.",
  onFire: (c) => issue({ name: "arcade.nextWave" }, c),
});

const bodyArcade = h("section", { class: "pb pb-arcade" }, [
  arcadeState,
  arcadePicker,
  arcadeRecruitCfg,
  arcadePlanCfg,
  arcadeGlassCfg,
  arcadeItem,
  arcadeNote,
  arcadeBridge,
  arcadeSplit,
  arcadeFloorList,
  // Above the Backing list, not below it. The list grows by a row for every
  // person the round drains, and a control that walks away down a scrolling
  // panel as the round goes on is a control the host cannot press at the
  // moment they need it — which on this bridge is eighteen times.
  h("div", { class: "field-actions" }, [
    arcadeEnd.el,
    arcadeNext.el,
    arcadeNextStep.el,
    arcadeNextWave.el,
  ]),
  h("p", {
    class: "label",
    text: "Backing — players who are out pick someone to root for",
  }),
  arcadeBacking,
]);

/** The round command the picker and its fields currently describe. */
function arcadeRoundCommand(): HostCommand {
  const int = (el: HTMLInputElement, dflt: number): number => {
    const v = Number(el.value);
    return Number.isFinite(v) && Number.isInteger(v) && v > 0 ? v : dflt;
  };
  if (arcadePick === "recruitment") {
    return {
      name: "arcade.round",
      kind: "recruitment",
      secondsPerItem: int(arcadeSeconds, 20),
    };
  }
  if (arcadePick === "glass_bridge") {
    return {
      name: "arcade.round",
      kind: "glass_bridge",
      waveSeconds: [
        int(arcadeWave1, 12),
        int(arcadeWave2, 9),
        int(arcadeWave3, 6),
      ],
    };
  }
  return {
    name: "arcade.round",
    kind: "plan_apply",
    target: int(arcadeTarget, 120),
    seconds: int(arcadeFloorSeconds, 75),
  };
}

function renderArcade(s: RenderState): void {
  const a = s.arcade;
  for (const [kind, button] of arcadePickButtons) {
    const on = ARCADE_BUILT[kind] && kind === arcadePick;
    button.classList.toggle("on", on);
    setAttr(button, "aria-checked", on ? "true" : "false");
  }
  // The picker and the settings are for choosing a round, and once the card
  // is up the choice is made: `startRound` refuses a second one. They come
  // off the panel for the duration, so the controls that *are* live during a
  // round are not pushed below the fold of a panel that scrolls — the Glass
  // Bridge added three settings and two buttons, and the two buttons are the
  // ones the host needs at 14:40.
  const inPlay = a !== undefined && (a.phase === "card" || a.phase === "running");
  arcadePicker.hidden = inPlay;
  arcadeRecruitCfg.hidden = inPlay || arcadePick !== "recruitment";
  arcadePlanCfg.hidden = inPlay || arcadePick !== "plan_apply";
  arcadeGlassCfg.hidden = inPlay || arcadePick !== "glass_bridge";

  if (a === undefined) {
    setText(arcadeState, "NOT IN THE ARCADE YET");
    setText(
      arcadeItem,
      "Entering hands out the player numbers; everyone keeps theirs for the whole arcade. The room calls the players still going in a round the Floor, and the ones who are out the Lounge.",
    );
    arcadeNote.hidden = true;
    replace(arcadeSplit, []);
    setText(arcadeFloorList, "");
    replace(arcadeBacking, []);
    arcadeBridge.hidden = true;
    arcadeEnd.setDisabled(true);
    arcadeNext.setDisabled(true);
    arcadeNextStep.setDisabled(true);
    arcadeNextWave.setDisabled(true);
    // The picker is still live: the host chooses the round before entering.
    return;
  }

  const roundLabel = a.round ? ARCADE_ROUND_LABEL[a.round] : "no round";
  // The phase, as the thing that is happening. "CARD" and "IDLE" are the
  // engine's words for its own states, and the host reads this line out loud.
  const phaseWord = ARCADE_PHASE_WORD[a.phase];
  const left = remainingMs(a.endsAt, client?.now() ?? Date.now());
  setText(
    arcadeState,
    [
      // SPEC.md's number for the round, not its position in this run. The
      // console counted from `roundIndex`, so it read ROUND 1 · RECRUITMENT
      // while the card in front of the room read *Game 1 — Plan / Apply* —
      // and the host reads the console out loud. SPEC.md numbers Recruitment
      // 0; the host picks the order, so the position is not the number.
      a.round ? `ROUND ${ARCADE_ROUND_NUMBER[a.round]}` : null,
      roundLabel.toUpperCase(),
      phaseWord,
      a.phase === "running" && left !== null ? formatCountdown(left) : null,
    ]
      .filter((x) => x !== null)
      .join(" · "),
  );

  // The split, which is the one number the host is asked about between rounds
  // and the reason nobody is sitting out. The room calls the two sides the
  // Floor and the Lounge; the console says what those mean.
  const total = a.onFloor + a.inLounge;
  replace(arcadeSplit, [
    h("div", { class: "a-split-bar" }, [
      h("div", {
        class: "a-split-floor",
        attrs: {
          style: `flex-basis:${total > 0 ? (a.onFloor / total) * 100 : 100}%`,
        },
      }),
      h("div", {
        class: "a-split-lounge",
        attrs: {
          style: `flex-basis:${total > 0 ? (a.inLounge / total) * 100 : 0}%`,
        },
      }),
    ]),
    h("p", {
      class: "mono a-split-text",
      text: `${a.onFloor} still playing · ${a.inLounge} out`,
    }),
  ]);

  // The console is the one surface that may hold the answer while the item is
  // open, because the host is the one about to read it out.
  const r = a.recruitment;
  const pa = a.planApply;
  const gl = a.glass;
  if (!gl) arcadeBridge.hidden = true;
  if (r) {
    // The item's own clock, not the round's: the host is timing when to read
    // the answer out, and the round header already carries the round's.
    const itemLeft = remainingMs(
      itemEndsAt(r),
      client?.now() ?? Date.now(),
    );
    setText(
      arcadeItem,
      `Item ${r.at + 1} of ${r.of}${itemLeft === null ? "" : ` · ${formatCountdown(itemLeft)}`} — ${r.cue ?? ""} → ${r.answer ?? "?"}  (${r.solved ?? 0} solved, ${r.answered ?? 0} of ${r.eligible ?? 0} answered)`,
    );
    const note = r.note ?? "";
    arcadeNote.hidden = note === "";
    setText(arcadeNote, note);
  } else if (pa) {
    // The Desktop's sign says PLAN or APPLY IN PROGRESS. The console says
    // both: the word the host can see on the Desktop they are sharing, and
    // what it means for the people playing.
    setText(
      arcadeItem,
      [
        LIGHT_FACE[pa.light].sign === "PLAN"
          ? "GREEN (PLAN) — taps count"
          : "RED (APPLY) — tapping knocks you out",
        `${pa.crossed ?? 0} finished`,
        `${pa.target} taps to finish`,
        `points banked at ${pa.checkpoints.join(" / ")}`,
      ].join(" · "),
    );
    arcadeNote.hidden = false;
    setText(
      arcadeNote,
      pa.headTurnsAt === undefined
        ? "The light goes back to green on its own."
        : `The light turns red in ${Math.max(0, Math.round((pa.headTurnsAt - (client?.now() ?? Date.now())) / 100) / 10)}s.`,
    );
  } else if (gl) {
    // The console is the one surface that may hold the answer while the
    // round is running, because the host is the one who reads it out at the
    // reveal — the same rule Recruitment's answer and trivia's `correct`
    // follow. It is also the only surface in the building that is not in the
    // room, which is why it is the only one that has it.
    const stepLeft = remainingMs(
      gl.stepEndsAt ?? null,
      client?.now() ?? Date.now(),
    );
    const step = (gl.step ?? 0);
    const pane = gl.board?.[step];
    const answer = gl.recap?.[step];
    setText(
      arcadeItem,
      [
        `WAVE ${gl.wave} OF 3`,
        `STEP ${step + 1} OF ${gl.of}`,
        `${gl.waveSeconds[gl.wave - 1] ?? 0}s`,
        stepLeft === null ? null : formatCountdown(stepLeft),
        pane ? `— ${pane.product}` : null,
      ]
        .filter((x) => x !== null)
        .join(" · "),
    );
    arcadeNote.hidden = true;
    // A running-round tool. At the reveal the Desktop carries the whole
    // recap, both notes and all, and the host reads it off that.
    arcadeBridge.hidden = a.phase !== "running" && a.phase !== "card";
    // Who has put their weight on something, out of who the step is waiting
    // for. Who, never what: `answeredBy` is a list of pids and stays one.
    const waiting = bridgeEntries(a, s.roster, gl).filter((e) => e.onBridge);
    const stepped = new Set(s.hostExtras?.arcade?.answeredBy ?? []);
    const broken = gl.broken
      .map((b, i) => (b === null ? null : `${i + 1}${b === 0 ? "L" : "R"}`))
      .filter((x) => x !== null);
    replace(arcadeBridge, [
      ...(pane
        ? [0, 1].map((side) =>
            h("p", {
              class: "a-bridge-answer",
              attrs: { "data-real": answer?.real === side ? "yes" : "no" },
            }, [
              h("span", {
                class: "mono a-bridge-mark",
                text: answer === undefined ? "·" : answer.real === side ? "REAL" : "FAKE",
              }),
              h("span", { class: "a-bridge-answer-label", text: pane.labels[side] ?? "" }),
            ]),
          )
        : []),
      h("p", { class: "mono a-bridge-broken" }, [
        [
          `${waiting.filter((e) => stepped.has(e.pid)).length} of ${waiting.length} have picked`,
          `panes broken ${broken.length === 0 ? "—" : broken.join(" ")}`,
          `across ${
            (gl.crossed ?? []).length === 0
              ? "—"
              : (gl.crossed ?? []).map((n) => playerTag(n)).join(" ")
          }${gl.fastest === undefined ? "" : ` · fastest ${playerTag(gl.fastest)}`}`,
        ].join(" · "),
      ]),
    ]);
  } else {
    setText(arcadeItem, "");
    arcadeNote.hidden = true;
  }

  const entries = gridEntries(a, s.roster);
  const lounge = entries.filter((e) => e.standing === "drained");
  setText(
    arcadeFloorList,
    lounge.length === 0
      ? "Nobody is out this round."
      : `Out this round: ${lounge.map((e) => e.tag).join(" ")}`,
  );

  // Who has backed whom, by number on both sides: the host reads these out.
  const backing = s.hostExtras?.arcade?.backing ?? {};
  const numberOf = new Map(entries.map((e) => [e.pid, e.tag]));
  const nameOf = new Map(entries.map((e) => [e.pid, e.nickname]));
  replace(
    arcadeBacking,
    Object.entries(backing).map(([pid, onPid]) =>
      h("li", { class: "a-backing-row" }, [
        h("span", { class: "mono", text: numberOf.get(pid) ?? "???" }),
        h("span", { class: "a-backing-name", text: nameOf.get(pid) ?? "" }),
        h("span", { class: "label", text: "backs" }),
        h("span", { class: "mono", text: numberOf.get(onPid) ?? "???" }),
        h("span", { class: "a-backing-name", text: nameOf.get(onPid) ?? "" }),
      ]),
    ),
  );

  arcadeEnd.setDisabled(a.phase !== "running");
  arcadeNext.setDisabled(a.phase !== "running" || a.round !== "recruitment");
  const bridging = a.phase === "running" && a.round === "glass_bridge";
  const g = a.glass;
  // "Close the step" is refused by the engine on the wave's last step — there
  // is no next step to open — and "send the next wave" is refused after wave
  // 3. Both say so by being unpressable rather than by being pressed.
  arcadeNextStep.setDisabled(
    !bridging || g === undefined || (g.step ?? 0) + 1 >= g.of,
  );
  arcadeNextWave.setDisabled(!bridging || g === undefined || g.wave >= 3);
}

const bodies: Record<string, HTMLElement> = {
  lobby: bodyLobby,
  holding: bodyHolding,
  standings: bodyStandings,
  final: bodyStandings,
  trivia: bodyTrivia,
  arcade: bodyArcade,
};

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

const pending = new Map<string, Control>();
let lastState: RenderState | null = null;
let client: QuorumClient | null = null;

function issue(cmd: HostCommand, from: Control | null): void {
  if (client === null) return;
  const cid = client.command(cmd);
  if (from) pending.set(cid, from);
}

function primaryPlan(): { label: string; cmd: HostCommand | null } {
  const s = lastState;
  if (s === null) return { label: "Connecting", cmd: null };
  if (s.phase === "closed") return { label: "Session closed", cmd: null };
  // draft -> lobby -> running is two presses, and the button says which.
  if (s.phase === "draft") {
    return { label: "Open the lobby", cmd: { name: "open" } };
  }
  if (s.phase === "lobby") {
    return { label: "Start the session", cmd: { name: "start" } };
  }
  // Inside trivia the primary button walks the question rather than the run of
  // show: open, close, reveal, next. That is the whole activity on the space
  // bar, which is what the host is holding while they read the question out.
  if (s.segment === "trivia" && s.trivia !== undefined) {
    const t = s.trivia;
    switch (t.phase) {
      case "idle":
        return {
          label: `Open ${questionLabel(t)}${suddenDeathArmed ? " — sudden death" : ""}`,
          cmd: { name: "trivia.open", suddenDeath: suddenDeathArmed },
        };
      case "open":
        return { label: "Close the question", cmd: { name: "trivia.close" } };
      case "closed":
        return { label: "Reveal the answer", cmd: { name: "trivia.reveal" } };
      case "revealed":
        return t.index + 1 < t.of
          ? { label: "Next question", cmd: { name: "trivia.next" } }
          : { label: "Show standings", cmd: { name: "segment", kind: "standings" } };
    }
  }
  // Inside the arcade the primary button walks the round the same way it
  // walks a question: enter, card, Floor, end, reveal. One activity, one key.
  if (s.segment === "arcade") {
    const a = s.arcade;
    if (a === undefined) {
      return { label: "Enter the arcade", cmd: { name: "arcade.enter" } };
    }
    switch (a.phase) {
      case "card":
        return { label: "Start the round", cmd: { name: "arcade.begin" } };
      case "running":
        return { label: "End the round", cmd: { name: "arcade.end" } };
      case "idle":
        // A round that has been played and not revealed. Revealing it is what
        // puts the points on the board, so it is never skipped by accident.
        if (a.round !== null) {
          return {
            label: `Show the results — ${ARCADE_ROUND_LABEL[a.round]}`,
            cmd: { name: "arcade.reveal" },
          };
        }
        return {
          label: `Announce ${ARCADE_ROUND_LABEL[arcadePick]}`,
          cmd: arcadeRoundCommand(),
        };
      case "reveal":
        return {
          label: `Announce ${ARCADE_ROUND_LABEL[arcadePick]}`,
          cmd: arcadeRoundCommand(),
        };
    }
  }

  const next = nextSegment(s.segment);
  if (next === null) return { label: "Nothing queued", cmd: null };
  const labels: Record<Segment, string> = {
    lobby: "Show the lobby",
    holding: "Show the holding card",
    trivia: "Open trivia",
    arcade: "Open the arcade",
    standings: "Show standings",
    final: "Show the final",
  };
  return { label: labels[next], cmd: { name: "segment", kind: next } };
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

function render(s: RenderState): void {
  lastState = s;

  /* status bar */
  setText(elTitle, s.title);
  const code = s.hostExtras?.joinCode ?? "————";
  setText(elCode, code);
  // Counts come from the roster, not from `hostExtras`: a `roster` delta
  // updates the roster and leaves `hostExtras` behind, so the roster is the
  // only field guaranteed to be current. See the report.
  const on = s.roster.filter((r) => r.conn === "on").length;
  const away = s.roster.filter((r) => r.conn === "away").length;
  setText(elCounts, `${on} on · ${away} away`);
  setText(elPhase, s.phase.toUpperCase());
  setText(elScoreboard, SCOREBOARD_STATE[s.seal]);
  setAttr(elScoreboard, "data-seal", s.seal);
  // Hidden is loud: the whole bar carries it, so the host never has to wonder
  // whether the room can see the scoreboard.
  statusBar.classList.toggle("sealed", s.seal === "sealed");

  /* rail */
  for (const [seg, row] of segmentRows) {
    const current = s.segment === seg;
    row.button.classList.toggle("current", current);
    const mark = row.button.querySelector(".seg-mark");
    if (mark instanceof HTMLElement) setText(mark, current ? "●" : "○");
    row.button.disabled = s.phase !== "running";
  }
  setText(railCount, `${s.roster.length}`);
  roster.update(s.roster);

  /* always-there controls */
  lockControl.setLabel(s.joinsLocked ? "Unlock joining" : "Lock joining");
  lockControl.el.classList.toggle("on", s.joinsLocked);
  sealControl.setLabel(
    s.seal === "live" ? "Hide the scoreboard" : "Reveal the winners, 5 to 1",
  );
  sealControl.setDisabled(s.seal === "revealed");
  unsealControl.el.hidden = s.seal === "live";
  closeControl.setDisabled(s.phase === "closed" || s.phase === "draft");

  /* panel */
  const bodyKey = s.phase === "draft" ? "lobby" : s.segment;
  const body = bodies[bodyKey] ?? bodyLobby;
  if (panelBody.firstElementChild !== body) replace(panelBody, [body]);
  setText(panelKind, SEGMENT_LABEL[s.segment].toUpperCase());
  // The phase, not the word "live": "live" is the seal's vocabulary and two
  // meanings in one status bar is one too many.
  setText(panelSub, s.phase === "draft" ? "not open yet" : s.phase);

  if (body === bodyLobby) {
    setText(bodyLobbyCode, code);
    setText(bodyLobbyUrl, `${location.origin}/j/${code}`);
    setText(bodyLobbyCount, String(s.roster.length));
    setText(bodyLobbyLock, s.joinsLocked ? "LOCKED" : "OPEN");
    setAttr(bodyLobbyLock, "data-locked", s.joinsLocked ? "yes" : "no");
  }

  if (body === bodyHolding && !holdingDirty) {
    holdingTitle.value = s.holding?.title ?? "";
    holdingLine.value = s.holding?.line ?? "";
  }

  if (body === bodyStandings) {
    replace(
      standingsRows,
      s.standings.map((row) =>
        h("li", { class: "h-row" }, [
          h("span", { class: "mono h-rank", text: String(row.rank) }),
          h("span", { class: "h-name", text: row.nickname }),
          h("span", { class: "mono h-total", text: String(row.total) }),
        ]),
      ),
    );
    setText(
      standingsNote,
      s.standings.length === 0
        ? "No scores yet. Type them into the grid below, or press G."
        : s.seal === "sealed"
          ? "Hidden from the room. This console is the only place it shows."
          : "The room sees exactly this.",
    );
    standingsNote.classList.toggle("pb-warn", s.seal === "sealed");
  }

  if (body === bodyTrivia) renderTrivia(s);

  if (body === bodyArcade) renderArcade(s);

  if (body === bodyPending) {
    const note = bodyPending.firstElementChild;
    if (note instanceof HTMLElement) {
      setText(
        note,
        `${SEGMENT_LABEL[s.segment]} is not built yet (Phase ${SEGMENT_PHASE[s.segment]}). The room is looking at a placeholder.`,
      );

    }
  }

  /* scoring — the grid is the host's, sealed or not: sealing is about what
     the room sees, and a host who cannot see the scores cannot score. */
  scoring.update(s);

  /* primary */
  const plan = primaryPlan();
  primary.setLabel(plan.label);
  primary.setDisabled(plan.cmd === null);

  /* preview — what the room sees, not what the console sees */
  preview.update(roomView(s), null);
}

/**
 * The live question: what it is, who has answered, and the four counts.
 *
 * The console is the one surface that sees the correct answer and the
 * distribution while the question is still open, because the host is the one
 * about to read it out and the one deciding whether to wait. Everything here
 * comes from `hostExtras` or from the host's own projection of `trivia`; none
 * of it exists on the wire to a participant.
 */
function renderTrivia(s: RenderState): void {
  const t = s.trivia;
  if (t === undefined) {
    setText(triviaHead, "NO QUESTIONS LOADED");
    setText(
      triviaQuestion,
      "Upload this session's questions below — a CSV exported from Kahoot — before you open trivia.",
    );
    triviaRound.hidden = true;
    replace(triviaAnswers, []);
    setText(triviaCounts, "");
    triviaNote.hidden = true;
    triviaWaiting.hidden = true;
    closeEarly.setDisabled(true);
    suddenDeath.setDisabled(true);
    triviaLoad.hidden = false;
    return;
  }

  // Re-uploading is allowed right up until the first question opens; after
  // that the engine refuses it, so the console stops offering it.
  triviaLoad.hidden = t.phase !== "idle" || t.index > 0;

  const left = remainingMs(t.closesAt, client?.now() ?? Date.now());
  setText(
    triviaHead,
    [
      questionLabel(t).toUpperCase(),
      t.phase.toUpperCase(),
      t.suddenDeath ? "SUDDEN DEATH" : null,
      t.phase === "open" && left !== null ? formatCountdown(left) : null,
      t.basePoints === 0 ? "WARM-UP · 0 POINTS" : `${t.basePoints} POINTS`,
    ]
      .filter((x) => x !== null)
      .join(" · "),
  );

  // The round card: SPEC gives one to the first question of a run of
  // consecutive questions sharing a `Round`. The console is where it appears
  // first, because the host announces it before opening the question.
  triviaRound.hidden = t.round === null;
  if (t.round) {
    setText(
      triviaRound,
      t.round.startsHere
        ? `Round card — ${t.round.name} · ${t.round.size} questions`
        : `${t.round.name} · ${t.round.position} of ${t.round.size}`,
    );
    triviaRound.classList.toggle("is-card", t.round.startsHere);
  }

  setText(triviaQuestion, t.text);

  const distribution = t.distribution ?? [];
  const correct = t.correct ?? [];
  const top = Math.max(1, ...distribution);
  replace(
    triviaAnswers,
    answerTiles(t.answers).map((tile) => {
      const n = distribution[tile.index] ?? 0;
      return h(
        "li",
        {
          class: correct.includes(tile.index) ? "t-answer is-correct" : "t-answer",
          attrs: { style: `--tile:${tile.hue}` },
        },
        [
          h("span", { class: "mono t-answer-i", text: String(tile.index + 1) }),
          h("span", { class: "t-answer-shape", attrs: { "aria-hidden": "true" }, text: tile.shape }),
          h("span", { class: "t-answer-text", text: tile.text }),
          h("span", {
            class: "t-answer-bar",
            attrs: { style: `width:${(n / top) * 100}%`, "aria-hidden": "true" },
          }),
          h("span", { class: "mono t-answer-n", text: String(n) }),
        ],
      );
    }),
  );

  const answered = t.answered ?? 0;
  const eligible = t.eligible ?? 0;
  setText(triviaCounts, `${answered} of ${eligible} answered`);
  triviaCounts.classList.toggle("all-in", eligible > 0 && answered >= eligible);

  const note = t.note ?? "";
  triviaNote.hidden = note === "";
  setText(triviaNote, note);

  // Who is still out. The host's decision is "wait or close", and three names
  // is a different decision from eleven.
  const answeredBy = new Set(s.hostExtras?.trivia?.answeredBy ?? []);
  const waiting = s.roster.filter((r) => !answeredBy.has(r.pid)).map((r) => r.nickname);
  triviaWaiting.hidden = t.phase !== "open" || waiting.length === 0;
  setText(
    triviaWaiting,
    waiting.length <= 6
      ? `waiting on ${waiting.join(", ")}`
      : `waiting on ${waiting.length} people`,
  );

  closeEarly.setDisabled(t.phase !== "open");
  // Arming it mid-question would be a promise the engine cannot keep.
  suddenDeath.setDisabled(t.phase === "open");
}

/**
 * The console is shown everything; the room is not. The preview has to be the
 * room's view or it is worse than no preview at all.
 *
 * The trivia block is the sharp end of that: the host's copy carries the
 * correct answer and the distribution from the moment the question loads, and
 * a preview that rendered those would be showing the host a participant view
 * that does not exist — and putting the answer key in the corner of a console
 * people screen-share by accident.
 */
function roomView(s: RenderState): RenderState {
  const { hostExtras: _hostExtras, own: _own, trivia, arcade, ...rest } = s;
  // Fields are *removed*, not set to undefined, so the preview is fed the
  // same shape a participant is: their copy has no `correct` key at all
  // before the reveal, and a preview that carried one would be a participant
  // view that does not exist.
  let roomTrivia: TriviaView | undefined;
  if (trivia !== undefined) {
    const {
      correct,
      distribution: _distribution,
      note,
      podium,
      answered: _answered,
      eligible: _eligible,
      ...shared
    } = trivia;
    const revealed = trivia.phase === "revealed";
    roomTrivia = {
      ...shared,
      // The room has not been sent the question until it is open.
      ...(trivia.phase === "idle" ? { text: "", answers: [] } : {}),
      ...(revealed && correct !== undefined ? { correct } : {}),
      ...(revealed && note !== undefined ? { note } : {}),
      ...(revealed && podium !== undefined ? { podium } : {}),
    };
  }
  // The arcade's version of the same rule, and the sharp end of it is the
  // light schedule: the console holds `nextChangeAt` and `headTurnsAt` from
  // the moment the round starts, and a preview that carried them would be a
  // participant who cannot be caught — in the corner of a window that gets
  // shared.
  let roomArcade: ArcadeView | undefined;
  if (arcade !== undefined) {
    const { recruitment, planApply, ...shared } = arcade;
    const revealed = arcade.phase === "reveal";
    const open = arcade.phase === "running" || revealed;
    let roomRecruitment: ArcadeRecruitmentView | undefined;
    if (recruitment !== undefined) {
      const {
        cue,
        answer,
        note,
        recap,
        answered: _answered,
        eligible: _eligible,
        solved: _solved,
        firstThree,
        ...rest2
      } = recruitment;
      roomRecruitment = {
        ...rest2,
        ...(open && cue !== undefined ? { cue } : {}),
        ...(revealed && answer !== undefined ? { answer } : {}),
        ...(revealed && note !== undefined ? { note } : {}),
        ...(revealed && recap !== undefined ? { recap } : {}),
        ...(revealed && firstThree !== undefined ? { firstThree } : {}),
      };
    }
    let roomPlan: ArcadePlanApplyView | undefined;
    if (planApply !== undefined) {
      const {
        nextChangeAt: _nextChangeAt,
        headTurnsAt: _headTurnsAt,
        crossed: _crossed,
        finishOrder: _finishOrder,
        ...rest2
      } = planApply;
      roomPlan = rest2;
    }
    roomArcade = {
      ...shared,
      ...(roomRecruitment !== undefined ? { recruitment: roomRecruitment } : {}),
      ...(roomPlan !== undefined ? { planApply: roomPlan } : {}),
    };
  }

  return {
    ...rest,
    ...(roomTrivia !== undefined ? { trivia: roomTrivia } : {}),
    ...(roomArcade !== undefined ? { arcade: roomArcade } : {}),
    standings: s.seal === "sealed" ? [] : s.standings,
  };
}

function addToast(kind: "spot" | "text", text: string): void {
  const li = h("li", { class: `toast toast-${kind}` }, [
    h("span", { class: "mono toast-kind", text: kind }),
    h("span", { class: "toast-text", text }),
  ]);
  toastList.insertBefore(li, toastList.firstChild);
  while (toastList.childElementCount > 5) toastList.lastElementChild?.remove();
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

client = new QuorumClient({
  hello: () => ({ t: "hello", role: "host", hostToken }),
  ...(mock ? { transport: mockTransport(mock) } : {}),

  onState(state) {
    render(state);
  },

  onStatus(status) {
    const bad = status !== "live";
    elConn.hidden = !bad;
    setText(elConn, status === "reconnecting" ? "RECONNECTING" : status.toUpperCase());
    setAttr(elConn, "data-status", status);
    preview.setBanner(status === "reconnecting" ? "reconnecting…" : null);
  },

  onRefused(reason, message) {
    replace(app, [
      h("div", { class: "gate" }, [
        h("p", { class: "label", text: "Quorum host" }),
        h("h1", { class: "display", text: "Refused" }),
        h("p", { class: "gate-note", text: `${reason}: ${message}` }),
      ]),
    ]);
  },

  onToast(kind, text) {
    addToast(kind, text);
  },

  onCommandResult(cid, result) {
    const target = pending.get(cid);
    pending.delete(cid);
    if (!target) return;
    if (result.ok) return; // the state change is the feedback
    // `not_applied` is the server saying it understood and there was nothing
    // to do — re-committing a score it already holds, revoking an award that
    // is already gone. That is not a refusal, and three seconds of red in a
    // grid cell over it would train the host to ignore the red.
    if (result.code === "not_applied") return;
    target.flash(result.message || "refused");
  },
});

/**
 * The console's own countdown. The state does not arrive once a second — it
 * arrives when something happens — so the one number on this page that has to
 * move by itself gets a heartbeat of its own.
 */
setInterval(() => {
  if (lastState === null) return;
  if (lastState.segment === "trivia" && lastState.trivia?.phase === "open") {
    renderTrivia(lastState);
  }
  // The arcade's clocks move without anything arriving: the item timer, the
  // Floor's countdown, and the light turning every two to six seconds.
  if (lastState.segment === "arcade" && lastState.arcade !== undefined) {
    renderArcade(lastState);
  }
}, 250);

bindSpace(primary);
bindEscape(() => [
  lockControl,
  sealControl,
  unsealControl,
  closeControl,
  primary,
]);

/**
 * `G` puts the cursor in the scoring grid, from anywhere that is not already
 * a field. Keyboard-first means reachable without a mouse, and the grid is
 * the one part of the console with real typing in it.
 */
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "g" && ev.key !== "G") return;
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const el = ev.target as HTMLElement | null;
  const tag = el?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (el?.isContentEditable) return;
  ev.preventDefault();
  scoring.focusFirst();
});

// The holding fields stop being "dirty" once the host applies or leaves them.
document.addEventListener("click", (ev) => {
  const t = ev.target;
  if (t instanceof HTMLElement && t.closest(".field-actions")) holdingDirty = false;
});

client.start();
