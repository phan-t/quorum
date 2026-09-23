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
import {
  bindEscape,
  bindSpace,
  control,
  handsBackSpace,
  primaryControl,
  releaseFocus,
  type Control,
} from "./controls.ts";
import {
  ARCADE_PLAYABLE,
  defaultPlan,
  isLastIncluded,
  movePlan,
  nextRound,
  parseSetup,
  planIncluded,
  planSummary,
  togglePlan,
  type ArcadePick,
  type ArcadePlan,
} from "./plan.ts";
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

/**
 * Every key this console answers to, on the console.
 *
 * A host will not guess a shortcut, and a shortcut nobody guesses is a feature
 * that does not exist. It is in the rail, where it is out of the way, and
 * again in driving mode, where the rail is not.
 */
const KEYS_HINT =
  "SPACE next \u00b7 G scoring grid \u00b7 SHIFT+H holding card \u00b7 SHIFT+D driving mode \u00b7 ESC cancel";

const rail = h("aside", { class: "rail" }, [
  h("section", { class: "rail-block" }, [
    h("p", { class: "label", text: "Run of show" }),
    railSegments,
  ]),
  h("section", { class: "rail-block rail-grow" }, [
    h("p", { class: "label" }, ["Participants ", railCount]),
    railRoster,
  ]),
  h("p", { class: "mono rail-keys", text: KEYS_HINT }),
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

/** The primary button's home. Driving mode borrows the button and gives it back. */
const panelFoot = h("div", { class: "panel-foot" }, [footLeft, primary.el]);

const panel = h("main", { class: "panel" }, [
  h("div", { class: "panel-head" }, [panelKind, panelSub]),
  panelBody,
  scoring.el,
  panelFoot,
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

/* ------------------------------------------------------------------ */
/* Driving mode                                                        */
/* ------------------------------------------------------------------ */

/**
 * The console with everything taken off it except the two things a host who
 * is also facilitating actually needs: what happens next, and who is still
 * answering.
 *
 * Strictly additive. The whole console stays mounted and stays rendered
 * underneath — this view is shown over it and the columns are hidden — so
 * turning the mode off puts the host back exactly where they were. The one
 * thing that moves is the primary button itself, which is *moved* rather than
 * copied: a second copy of the most important string in the product is a
 * second copy that can get out of step, and a refusal has to land in the
 * button the host is looking at.
 */
const dvContext = h("p", { class: "mono dv-context" });
const dvBig = h("p", { class: "dv-big" });
const dvSub = h("p", { class: "mono dv-sub" });
const dvWaiting = h("p", { class: "dv-waiting" });
const dvPrimary = h("div", { class: "dv-primary" });
const drivingView = h("section", { class: "driving-view", attrs: { hidden: true } }, [
  h("p", { class: "label dv-label", text: "Driving mode" }),
  dvContext,
  dvBig,
  dvSub,
  dvWaiting,
  dvPrimary,
  h("p", { class: "mono dv-keys", text: KEYS_HINT }),
]);

replace(app, [
  statusBar,
  h("div", { class: "cols" }, [rail, panel, tray]),
  drivingView,
]);
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
  handsBackSpace(button);
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
/* ---- pre-flight ---------------------------------------------------- */

/**
 * What is ready and what is not, before the room is looking.
 *
 * "No questions loaded" used to be found out when trivia was opened in front
 * of thirty people. It is knowable an hour earlier, so it is said an hour
 * earlier. This list informs and never blocks: nothing on it touches the
 * primary button, and a host who wants to start anyway presses start.
 *
 * Three states, each said three ways — a glyph, a word and a colour — because
 * nothing on this console is carried by colour alone.
 */
type PreflightState = "ready" | "not" | "ask";

interface PreflightRow {
  readonly el: HTMLLIElement;
  set(state: PreflightState, text: string): void;
}

function preflightRow(extra?: HTMLElement): PreflightRow {
  const mark = h("span", { class: "mono pf-mark", attrs: { "aria-hidden": "true" } });
  const word = h("span", { class: "mono pf-word" });
  const text = h("span", { class: "pf-text" });
  const el = h("li", { class: "pf-row", attrs: { "data-state": "ask" } }, [
    mark,
    word,
    text,
    extra ?? null,
  ]);
  return {
    el,
    set(state, body) {
      setAttr(el, "data-state", state);
      setText(mark, state === "ready" ? "✓" : state === "not" ? "✗" : "?");
      setText(
        word,
        state === "ready" ? "ready" : state === "not" ? "not ready" : "by eye",
      );
      setText(text, body);
    },
  };
}

/**
 * The Desktop is the one item the console cannot check. Nothing on the wire
 * tells the host whether the big screen is connected — so rather than guess,
 * or quietly leave it off the list, it asks the host to look and tick. An
 * honest question beats a tick that means nothing.
 */
let deskSeen = false;
const deskTick = handsBackSpace(
  h("button", { class: "pf-tick", type: "button", text: "Tick when you can see it" }),
);
deskTick.addEventListener("click", () => {
  deskSeen = !deskSeen;
  if (lastState) render(lastState);
});

const pfQuestions = preflightRow();
const pfArcade = preflightRow();
const pfDesktop = preflightRow(deskTick);
const pfPeople = preflightRow();

const preflight = h("section", { class: "pf" }, [
  h("p", { class: "label", text: "Before the room arrives" }),
  h("ul", { class: "pf-list" }, [
    pfQuestions.el,
    pfArcade.el,
    pfDesktop.el,
    pfPeople.el,
  ]),
  h("p", {
    class: "pb-note",
    text: "None of this stops you starting. It is what the console can see from where it sits — the projector it cannot, so that one is yours to look at.",
  }),
]);

/** Where the arcade running order sits while the session has not started. */
const lobbySetupSlot = h("div", { class: "lobby-setup" });

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
  preflight,
  lobbySetupSlot,
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
    // Applied, so the space bar goes back to the run of show: a host who
    // left the cursor in this field would otherwise type spaces into it
    // while the room waited for the next thing to happen.
    field.blur();
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

/**
 * The running order, chosen during setup rather than mid-session. See
 * plan.ts. Once the session is running, the arcade advances on the primary
 * button like everything else: the button says "Announce Plan / Apply"
 * because Plan / Apply is what the host said comes next.
 */
let arcadePlan: ArcadePlan = defaultPlan();

/**
 * Rounds this session has played *and revealed*. Revealed is the line,
 * because revealing is what puts the points on the board — a round that was
 * played and not revealed is not finished with.
 */
const arcadePlayed = new Set<ArcadePick>();

/**
 * A deviation, good for one announce: the round the host picked by hand
 * because the room is running long, or because a round has to be run again.
 * It clears itself once that round is revealed and the order picks back up.
 */
let arcadeOverride: ArcadePick | null = null;

/** The round the primary button is offering; null when the order is finished. */
function currentPick(): ArcadePick | null {
  if (arcadeOverride !== null) return arcadeOverride;
  return nextRound(arcadePlan, arcadePlayed);
}

function isPlayable(kind: ArcadeRoundKind): kind is ArcadePick {
  return (ARCADE_PLAYABLE as readonly string[]).includes(kind);
}

/**
 * The six-item picker, which is now the way *off* the running order rather
 * than the way onto it: it lives behind "Run a different round", and a round
 * chosen here overrides the order for the next announce only.
 */
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
    handsBackSpace(button);
    button.addEventListener("click", () => {
      arcadeOverride = kind as ArcadePick;
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

/* ---- the running order, set before the session ---------------------- */

/** Which settings belong to which round, so the order can carry them. */
const ARCADE_CFG: Readonly<Record<ArcadePick, HTMLElement>> = {
  recruitment: arcadeRecruitCfg,
  plan_apply: arcadePlanCfg,
  glass_bridge: arcadeGlassCfg,
};

/**
 * The order and the timings, kept in this browser.
 *
 * A console reloaded at 2:45pm has to come back with the order still set. It
 * is best-effort on purpose: a browser with storage turned off gets the
 * default order and a working console, never a broken one.
 */
const SETUP_KEY = "quorum.host.arcade.v1";

const TIMING_FIELDS: readonly (readonly [HTMLInputElement, string])[] = [
  [arcadeSeconds, "secondsPerItem"],
  [arcadeTarget, "target"],
  [arcadeFloorSeconds, "seconds"],
  [arcadeWave1, "wave1"],
  [arcadeWave2, "wave2"],
  [arcadeWave3, "wave3"],
];

function saveSetup(): void {
  const timings: Record<string, number> = {};
  for (const [field, key] of TIMING_FIELDS) {
    const v = Number(field.value);
    if (Number.isFinite(v) && v > 0) timings[key] = Math.round(v);
  }
  try {
    localStorage.setItem(SETUP_KEY, JSON.stringify({ plan: arcadePlan, timings }));
  } catch {
    // Storage off, or full. The order still works; it just will not survive
    // a reload, and nothing about that is worth an error in front of a room.
  }
}

/**
 * Which rounds have already been played, against the session they were played
 * in.
 *
 * A console reloaded in the middle of the arcade would otherwise come back
 * offering a round the room has already played. Stored under the session id,
 * so it is never restored into a different session, and best-effort like the
 * order itself: without it the console still works, it just offers a round
 * the host then has to correct by hand.
 */
const PLAYED_KEY = "quorum.host.arcade.played.v1";
let playedLoadedFor: string | null = null;

function loadPlayed(sid: string): void {
  if (playedLoadedFor === sid) return;
  playedLoadedFor = sid;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(PLAYED_KEY);
  } catch {
    return;
  }
  if (raw === null) return;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return;
    const o = v as { sid?: unknown; played?: unknown };
    if (o.sid !== sid || !Array.isArray(o.played)) return;
    for (const k of o.played as unknown[]) {
      if (typeof k !== "string") continue;
      if (!(ARCADE_PLAYABLE as readonly string[]).includes(k)) continue;
      arcadePlayed.add(k as ArcadePick);
    }
  } catch {
    // Nothing usable stored. The order starts from the top, which is visible
    // on the button rather than silent.
  }
}

function savePlayed(sid: string): void {
  try {
    localStorage.setItem(PLAYED_KEY, JSON.stringify({ sid, played: [...arcadePlayed] }));
  } catch {
    // See saveSetup.
  }
}

function loadSetup(): void {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(SETUP_KEY);
  } catch {
    return;
  }
  const stored = parseSetup(raw);
  if (stored === null) return;
  arcadePlan = stored.plan;
  for (const [field, key] of TIMING_FIELDS) {
    const v = stored.timings[key];
    if (v !== undefined) field.value = String(v);
  }
}

for (const [field] of TIMING_FIELDS) {
  field.addEventListener("change", () => saveSetup());
}

const arcadeSetupRows = h("div", { class: "a-setup-rows" });
const arcadeSetupNote = h("p", { class: "pb-note a-setup-note", attrs: { hidden: true } });

const arcadeSetup = h("section", { class: "a-setup" }, [
  h("p", { class: "label", text: "Arcade running order" }),
  h("p", {
    class: "pb-note",
    text: "Set this before you start. Once the session is running, the main button announces these rounds in this order \u2014 it always says which one is next.",
  }),
  arcadeSetupRows,
  arcadeSetupNote,
  h("p", {
    class: "pb-note",
    text: "Unseal, Tug of Raft and Gganbu are designed but not built, so they are not in the order.",
  }),
]);

function noteSetup(message: string): void {
  setText(arcadeSetupNote, message);
  arcadeSetupNote.hidden = message === "";
}

function changeSetup(next: ArcadePlan, refused: string): void {
  if (next === arcadePlan) {
    noteSetup(refused);
    return;
  }
  arcadePlan = next;
  noteSetup("");
  saveSetup();
  renderArcadeSetup();
  if (lastState) render(lastState);
}

/**
 * One row per built round: where it comes in the order, what the game is, its
 * own settings, and the two things the host can do to it — move it, or take
 * it out. The rows are rebuilt on every change; the settings fields are moved
 * into them rather than recreated, so a number the host typed survives.
 */
function renderArcadeSetup(): void {
  const included = planIncluded(arcadePlan);
  replace(
    arcadeSetupRows,
    arcadePlan.map((entry, i) => {
      const kind = entry.kind;
      const cfg = ARCADE_CFG[kind];
      cfg.hidden = false;
      const up = handsBackSpace(
        h("button", {
          class: "a-setup-move",
          type: "button",
          text: "\u2191",
          disabled: i === 0,
          attrs: { "aria-label": `Move ${ARCADE_ROUND_LABEL[kind]} earlier` },
        }),
      );
      up.addEventListener("click", () =>
        changeSetup(movePlan(arcadePlan, kind, -1), ""),
      );
      const down = handsBackSpace(
        h("button", {
          class: "a-setup-move",
          type: "button",
          text: "\u2193",
          disabled: i === arcadePlan.length - 1,
          attrs: { "aria-label": `Move ${ARCADE_ROUND_LABEL[kind]} later` },
        }),
      );
      down.addEventListener("click", () =>
        changeSetup(movePlan(arcadePlan, kind, 1), ""),
      );
      const inOut = handsBackSpace(
        h("button", {
          class: entry.included ? "a-setup-in on" : "a-setup-in",
          type: "button",
          text: entry.included ? "Playing" : "Skipped",
          attrs: { "aria-pressed": entry.included ? "true" : "false" },
        }),
      );
      inOut.addEventListener("click", () =>
        changeSetup(
          togglePlan(arcadePlan, kind),
          isLastIncluded(arcadePlan, kind)
            ? "Keep at least one round \u2014 the arcade has to have something to announce."
            : "",
        ),
      );
      return h(
        "div",
        { class: entry.included ? "a-setup-row" : "a-setup-row is-out" },
        [
          h("span", {
            class: "mono a-setup-pos",
            text: entry.included ? String(included.indexOf(kind) + 1) : "\u2013",
          }),
          h("div", { class: "a-setup-main" }, [
            h("span", { class: "a-setup-name", text: ARCADE_ROUND_LABEL[kind] }),
            h("span", { class: "a-setup-what", text: ARCADE_ROUND_WHAT[kind] }),
            entry.included ? cfg : null,
          ]),
          h("div", { class: "a-setup-acts" }, [up, down, inOut]),
        ],
      );
    }),
  );
}

/** The line that says which round the button is about to announce. */
const arcadeUpNext = h("p", { class: "a-upnext" });

const arcadeAltToggle = handsBackSpace(
  h("button", {
    class: "a-alt-toggle",
    type: "button",
    text: "Run a different round",
    attrs: { "aria-expanded": "false" },
  }),
);
const arcadeAlt = h("div", { class: "a-alt", attrs: { hidden: true } }, [
  h("p", {
    class: "pb-note",
    text: "Pick a round here to run it next instead of the one in the order \u2014 to skip ahead, or to run one again. The order picks up again afterwards.",
  }),
  arcadePicker,
]);
arcadeAltToggle.addEventListener("click", () => {
  const open = arcadeAlt.hidden;
  arcadeAlt.hidden = !open;
  setAttr(arcadeAltToggle, "aria-expanded", open ? "true" : "false");
  setText(arcadeAltToggle, open ? "Hide the other rounds" : "Run a different round");
});

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
  arcadeUpNext,
  arcadeAltToggle,
  arcadeAlt,
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

/** The round command the running order and its fields describe. */
function arcadeRoundCommand(pick: ArcadePick): HostCommand {
  const int = (el: HTMLInputElement, dflt: number): number => {
    const v = Number(el.value);
    return Number.isFinite(v) && Number.isInteger(v) && v > 0 ? v : dflt;
  };
  if (pick === "recruitment") {
    return {
      name: "arcade.round",
      kind: "recruitment",
      secondsPerItem: int(arcadeSeconds, 20),
    };
  }
  if (pick === "glass_bridge") {
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
  // A round that has been revealed is a round that has been played: revealing
  // is what puts the points on the board. That is what moves the running
  // order on, and what ends a deviation.
  if (
    a !== undefined &&
    a.phase === "reveal" &&
    a.round !== null &&
    isPlayable(a.round)
  ) {
    arcadePlayed.add(a.round);
    savePlayed(s.sid);
    if (arcadeOverride === a.round) arcadeOverride = null;
  }

  const pick = currentPick();
  for (const [kind, button] of arcadePickButtons) {
    const on = ARCADE_BUILT[kind] && kind === pick;
    button.classList.toggle("on", on);
    setAttr(button, "aria-checked", on ? "true" : "false");
  }

  // Which round is next was decided during setup, and the line below says so.
  // Once the card is up the choice is made either way — `startRound` refuses a
  // second one — so the line and the way off the order both come off the
  // panel for the duration, leaving the controls that *are* live during a
  // round where the host can press them without scrolling. The Glass Bridge
  // added two of those, and they are the ones the host needs at 14:40.
  const inPlay = a !== undefined && (a.phase === "card" || a.phase === "running");
  arcadeUpNext.hidden = inPlay;
  arcadeAltToggle.hidden = inPlay;
  if (inPlay && !arcadeAlt.hidden) {
    arcadeAlt.hidden = true;
    setAttr(arcadeAltToggle, "aria-expanded", "false");
    setText(arcadeAltToggle, "Run a different round");
  }

  const order = planIncluded(arcadePlan);
  const at = pick === null ? -1 : order.indexOf(pick);
  setText(
    arcadeUpNext,
    pick === null
      ? "Every round you chose has been played. The button moves on to the standings."
      : arcadeOverride !== null
        ? `Next: ${ARCADE_ROUND_LABEL[pick]} — you picked this one by hand.`
        : `Next: ${ARCADE_ROUND_LABEL[pick]} — round ${at + 1} of ${order.length} in your running order.`,
  );

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
    // The running order is still live: the host can still change it, and the
    // line above says which round entering leads to.
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

/**
 * The next round in the order the host set during setup — or, when they have
 * all been played, the next thing in the run of show. The button never says
 * "choose something": the choosing was done before the room arrived.
 */
function announceNext(): { label: string; cmd: HostCommand | null } {
  const pick = currentPick();
  if (pick === null) {
    return { label: "Show standings", cmd: { name: "segment", kind: "standings" } };
  }
  return {
    label: `Announce ${ARCADE_ROUND_LABEL[pick]}`,
    cmd: arcadeRoundCommand(pick),
  };
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
        return announceNext();
      case "reveal":
        return announceNext();
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
  loadPlayed(s.sid);

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

  /* pre-flight, and where the running order sits */
  renderPreflight(s);
  placeArcadeSetup(s);

  /* primary */
  const plan = primaryPlan();
  primary.setLabel(plan.label);
  primary.setDisabled(plan.cmd === null);

  /* preview — what the room sees, not what the console sees */
  preview.update(roomView(s), null);

  /* driving mode, when it is on. The console above is rendered either way. */
  if (driving) renderDriving(s);
}

/**
 * The checklist, filled in. Four things, three of which the console can see
 * for itself.
 */
function renderPreflight(s: RenderState): void {
  const setup = s.phase === "draft" || s.phase === "lobby";
  preflight.hidden = !setup;
  if (!setup) return;

  const loaded = s.hostExtras?.trivia?.loaded ?? 0;
  pfQuestions.set(
    loaded > 0 ? "ready" : "not",
    loaded > 0
      ? `${loaded} trivia question${loaded === 1 ? "" : "s"} loaded.`
      : "No trivia questions loaded. Open Trivia and upload the CSV, or trivia opens empty in front of the room.",
  );

  const order = planIncluded(arcadePlan);
  pfArcade.set(
    order.length > 0 ? "ready" : "not",
    order.length > 0
      ? `Arcade rounds: ${planSummary(arcadePlan, ARCADE_ROUND_LABEL)}.`
      : "No arcade rounds chosen.",
  );

  pfDesktop.set(
    deskSeen ? "ready" : "ask",
    deskSeen
      ? "You have seen the Desktop up on the projector."
      : "The console cannot see the Desktop from here. Look at the big screen, then tick.",
  );
  setText(deskTick, deskSeen ? "Untick" : "Tick when you can see it");

  const joined = s.roster.length;
  const on = s.roster.filter((r) => r.conn === "on").length;
  const away = s.roster.filter((r) => r.conn === "away").length;
  pfPeople.set(
    joined > 0 ? "ready" : "not",
    joined > 0
      ? `${joined} joined · ${on} on, ${away} away.`
      : "Nobody has joined yet. The join code is above.",
  );
}

/**
 * The running order lives where the host is when they need it: in the lobby
 * panel before the session starts, and behind "Run a different round" in the
 * arcade panel once it has. One element that moves, not two that can
 * disagree — and moving it keeps the numbers the host typed into it.
 */
function placeArcadeSetup(s: RenderState): void {
  const home =
    s.phase === "draft" || s.phase === "lobby" ? lobbySetupSlot : arcadeAlt;
  if (arcadeSetup.parentElement !== home) home.appendChild(arcadeSetup);
}

/**
 * Driving mode's two lines: what is happening, and who is still answering.
 *
 * Both are read off the console that is still rendering underneath, so there
 * is one place each number is worked out and driving mode cannot drift from
 * the console it is covering.
 */
function renderDriving(s: RenderState): void {
  setText(dvContext, drivingContext(s));
  const counts = drivingCounts(s);
  setText(dvBig, counts.big);
  setText(dvSub, counts.sub);
  const waiting = drivingWaiting(s);
  dvWaiting.hidden = waiting === "";
  setText(dvWaiting, waiting);
}

function drivingContext(s: RenderState): string {
  if (s.phase !== "running") {
    return `${SEGMENT_LABEL[s.segment].toUpperCase()} · ${s.phase.toUpperCase()}`;
  }
  if (s.segment === "trivia" && s.trivia !== undefined) {
    return triviaHead.textContent ?? "";
  }
  if (s.segment === "arcade" && s.arcade !== undefined) {
    return arcadeState.textContent ?? "";
  }
  return `${SEGMENT_LABEL[s.segment].toUpperCase()} · ${s.phase.toUpperCase()}`;
}

function drivingCounts(s: RenderState): { big: string; sub: string } {
  const on = s.roster.filter((r) => r.conn === "on").length;
  const away = s.roster.filter((r) => r.conn === "away").length;
  const room = `${on} on · ${away} away`;

  if (s.segment === "trivia" && s.trivia !== undefined) {
    const t = s.trivia;
    return { big: `${t.answered ?? 0} of ${t.eligible ?? 0} answered`, sub: room };
  }

  if (s.segment === "arcade" && s.arcade !== undefined) {
    const a = s.arcade;
    const r = a.recruitment;
    const gl = a.glass;
    const pa = a.planApply;
    let detail = room;
    if (r !== undefined) {
      detail = `${r.answered ?? 0} of ${r.eligible ?? 0} answered this item`;
    } else if (gl !== undefined) {
      const onBridge = bridgeEntries(a, s.roster, gl).filter((e) => e.onBridge);
      const stepped = new Set(s.hostExtras?.arcade?.answeredBy ?? []);
      detail = `${onBridge.filter((e) => stepped.has(e.pid)).length} of ${onBridge.length} have picked`;
    } else if (pa !== undefined) {
      detail = `${pa.crossed ?? 0} finished`;
    }
    return { big: `${a.onFloor} still playing · ${a.inLounge} out`, sub: detail };
  }

  return { big: room, sub: `${s.roster.length} in the room` };
}

function drivingWaiting(s: RenderState): string {
  if (s.segment === "trivia" && s.trivia?.phase === "open") {
    return triviaWaiting.hidden ? "" : (triviaWaiting.textContent ?? "");
  }
  if (s.segment === "arcade" && s.arcade !== undefined) {
    return arcadeFloorList.textContent ?? "";
  }
  return "";
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
  // Driving mode reads its lines off the console above, so it has to be
  // refreshed on the same beat — otherwise its clock stops at whatever the
  // last state said, which is a frozen console as far as the host can tell.
  if (driving) renderDriving(lastState);
}, 250);

/* ------------------------------------------------------------------ */
/* The rest of the keyboard                                            */
/* ------------------------------------------------------------------ */

/**
 * The holding card, in one key.
 *
 * Recovery used to be three actions at the moment a host least wants three:
 * switch to Holding, type a title, type a line, press the button. This is one
 * key, and it reuses whatever the card last said — falling back to something
 * neutral and true if it has never been set.
 *
 * Shift is deliberate. A bare letter is a key a hand resting on a laptop can
 * find by accident, and this one puts a new slide in front of thirty people.
 * H for holding: it collides with nothing — space advances, G is the scoring
 * grid, Escape disarms — and it is printed in the rail and in driving mode,
 * because a host will not guess a shortcut.
 */
const HOLDING_FALLBACK_TITLE = "Back shortly";
const HOLDING_FALLBACK_LINE = "Sit tight — we'll pick this up in a moment.";

function showHoldingNow(): void {
  const s = lastState;
  if (s === null) return;
  if (s.phase !== "running") {
    primary.flash("nothing is in front of the room yet");
    return;
  }
  const title =
    holdingTitle.value.trim() ||
    (s.holding?.title ?? "").trim() ||
    HOLDING_FALLBACK_TITLE;
  const line =
    holdingLine.value.trim() ||
    (s.holding?.line ?? "").trim() ||
    HOLDING_FALLBACK_LINE;
  // The card's words go first, so the room never sees the previous card's
  // second line under this one's title.
  holdingTitle.value = title;
  holdingLine.value = line;
  holdingDirty = false;
  issue({ name: "holding", title, line }, primary);
  if (s.segment !== "holding") issue({ name: "segment", kind: "holding" }, primary);
}

/* ---- driving mode ---- */

/**
 * The console with everything taken off it but the primary button and the
 * live counts, for the half of the session the host is also facilitating.
 *
 * Additive by construction: the console underneath stays mounted and stays
 * rendered, so turning the mode off is not a rebuild — it is the same console
 * the host left, in the same state. The primary button is moved rather than
 * copied, so the most important string in the product has exactly one copy
 * and a refusal lands where the host is looking.
 */
let driving = false;

function setDriving(on: boolean): void {
  if (on === driving) return;
  driving = on;
  document.body.classList.toggle("driving", on);
  drivingView.hidden = !on;
  const home = on ? dvPrimary : panelFoot;
  if (primary.el.parentElement !== home) home.appendChild(primary.el);
  // The button just moved out from under the cursor; space must still work.
  releaseFocus();
  if (lastState) render(lastState);
}

document.addEventListener("keydown", (ev) => {
  if (!ev.shiftKey || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.repeat) return;
  const el = ev.target as HTMLElement | null;
  const tag = el?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (el?.isContentEditable) return;
  const key = ev.key.toLowerCase();
  if (key === "h") {
    ev.preventDefault();
    showHoldingNow();
    return;
  }
  if (key === "d") {
    ev.preventDefault();
    setDriving(!driving);
  }
});

/* ---- the running order, as the console last had it ---- */

loadSetup();
renderArcadeSetup();

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
  // The grid is on the console, and driving mode is the console put away.
  // Asking for the grid is asking for the console back.
  setDriving(false);
  scoring.focusFirst();
});

// The holding fields stop being "dirty" once the host applies or leaves them.
document.addEventListener("click", (ev) => {
  const t = ev.target;
  if (t instanceof HTMLElement && t.closest(".field-actions")) holdingDirty = false;
});

client.start();
