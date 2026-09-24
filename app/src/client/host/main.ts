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
  SendoffView,
  TriviaView,
} from "../../protocol.ts";
import { initTheme, themeToggle } from "../shared/theme.ts";
import type { ArcadePhase, ArcadeRoundKind, Seal, Segment } from "../../engine/types.ts";
import { MAX_AUTO_SECONDS, MIN_AUTO_SECONDS } from "../../engine/sendoff.ts";
import { h, keyedList, qs, replace, setAttr, setText } from "../shared/dom.ts";
import { QuorumClient } from "../shared/net.ts";
import { mockBadge, mockTransport, readMockConfig } from "../shared/mock.ts";
import {
  ARCADE_ROUND_LABEL,
  ARCADE_ROUND_NUMBER,
  LIGHT_FACE,
  SEGMENT_LABEL,
  SEGMENT_PHASE,
  UNSEAL_FACE,
  answerTiles,
  bridgeEntries,
  formatCountdown,
  gridEntries,
  itemEndsAt,
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
import {
  HOLDING_STEPS_MAX,
  TRAY_MAX,
  TRAY_MIN,
  addHoldingStep,
  anchorHoldingCards,
  clampTray,
  defaultRunbook,
  dropRunbook,
  entryById,
  holdingSteps,
  isLastIncludedSegment,
  isRemovableStep,
  moveRunbook,
  nextEntryAfter,
  parseRunbook,
  parseTrayWidth,
  removeStep,
  runbookIncludedEntries,
  runbookRail,
  setEntryCard,
  toggleRunbook,
  type Runbook,
  type RunbookEntry,
} from "./runbook.ts";
import {
  CARD_LINE_MAX,
  CARD_MAX,
  CARD_TITLE_MAX,
  addCard,
  cardById,
  cardMatching,
  cardName,
  defaultDeck,
  editCard,
  isLastCard,
  migrateDeck,
  moveCard,
  parseDeck,
  removeCard,
  type HoldingCard,
  type HoldingDeck,
} from "./cards.ts";
import { createScoringPanel } from "./scoring.ts";
import { createParticipantView } from "../participant/view.ts";

initTheme();

document.title = "Quorum host";

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
        text: "Open it as /host#<host token>. Everything after the # stays in this browser, so the token never reaches a server log.",
      }),
    ]),
  ]);
  throw new Error("no host token");
}

/* ------------------------------------------------------------------ */
/* Chrome                                                              */
/* ------------------------------------------------------------------ */

const elTitle = h("span", { class: "sb-title" });
const elScoreboard = h("span", { class: "sb-seal mono" });

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

/**
 * Whose session, whether it is connected, whether the room can see the scores.
 *
 * Four things have left this bar and none of them is lost. A red DO NOT SHARE
 * chip and the join code went first: the code is in the lobby panel beside the
 * join link with a copy button on each, which is where a host reaches for it.
 * The head count and the phase followed, because both were second copies — the
 * rail counts the roster two inches to the left, and the panel head says the
 * phase directly above the controls the phase governs. A bar of duplicates is
 * a bar the eye stops reading, and then it is not there for the one line that
 * is only here.
 */
const statusBar = h("header", { class: "statusbar" }, [
  elTitle,
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
    h("p", { class: "label", text: "Runbook" }),
    railSegments,
  ]),
  h("section", { class: "rail-block rail-grow" }, [
    h("p", { class: "label" }, ["Participants ", railCount]),
    railRoster,
  ]),
  h("p", { class: "mono rail-keys", text: KEYS_HINT }),
]);

const panelSub = h("span", { class: "mono panel-sub" });
const panelBody = h("div", { class: "panel-body" });
const primary = primaryControl((c) => {
  const plan = primaryPlan();
  plan.fire?.(c);
});

/**
 * Scoring is not a segment. Manual entry and Spot Awards happen from the
 * console while whatever segment is up stays up — typically the holding card
 * during the TTX, or the standings between activities — so the grid lives
 * below the segment body rather than replacing it.
 */
const scoring = createScoringPanel({ issue: (cmd, from) => issue(cmd, from) });

/**
 * The primary button's home, and now the only thing in it.
 *
 * The foot used to carry Lock joining, the seal, Reopen, Close session and
 * the wipe's arm button alongside it — five things pressed once or never,
 * wrapping onto a second row, in the same 8px gap as the one button pressed
 * every thirty seconds. They have moved to the control panel in the tray
 * (see `controlPanel` below), so the foot is one full-width button and
 * nothing else: same place, same key, impossible to miss and impossible to
 * mistake for its neighbour, because it has none.
 *
 * Driving mode borrows the button and gives it back.
 */
/**
 * What stands in the foot before the show starts.
 *
 * "Start the session" is a lifecycle step, not a step of the run of show, and
 * it belongs beside Lock joining and Close session rather than inside the
 * button the host presses every thirty seconds. So it is there — and it is
 * *this* button, moved, exactly the way driving mode borrows it below. Moved
 * rather than copied: two Start buttons would be two copies of the most
 * important string in the product, and one of them would be the one the host
 * presses while the other is the one a refusal lands in.
 *
 * Which leaves the foot with nothing in it until the session is running, and
 * a foot with nothing in it is a host wondering whether the console is
 * broken. So it says where the button went and, by name, what the space bar
 * is about to press. See `placePrimary`.
 */
const footNote = h("p", { class: "pb-note foot-note", attrs: { hidden: true } });

const panelFoot = h("div", { class: "panel-foot" }, [primary.el, footNote]);

/**
 * The primary button's other home: the top of the control panel's Session
 * group, for as long as the next thing to press is a lifecycle step — Open
 * the lobby, then Start the session.
 *
 * Empty and hidden the rest of the time. A bordered gap where a button used
 * to be reads as a console that has lost something.
 */
const cpLifecycle = h("div", {
  class: "cp-lifecycle",
  attrs: { hidden: true },
});

const panel = h("main", { class: "panel" }, [
  h("div", { class: "panel-head" }, [panelSub]),
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
const previewFrame = h("div", { class: "preview-frame" }, [preview.root]);
const previewBox = h("div", { class: "tray-preview" }, [
  h("p", { class: "label", text: "Participant preview" }),
  previewFrame,
]);
/**
 * The control panel: everything the host presses once, or never.
 *
 * Filled in further down, once the controls it holds have been built. It sits
 * under the participant preview because that is the half of the console the
 * eye is not using to run the show — the panel foot is for the one button
 * pressed constantly, and the tray is for the rest.
 *
 * It scrolls rather than pushing anything off the bottom of the tray. The
 * splitter takes the column down to 216px and the panel has to stay usable
 * there, so nothing in it is laid out in fixed columns: the rows wrap, the
 * buttons wrap their labels, and the whole block gives way to a scrollbar
 * before it gives way to a control the host cannot reach.
 */
const trayControls = h("section", {
  class: "cp",
  attrs: { "aria-label": "Session controls" },
});

/**
 * Everything in the tray below the preview, in one scrolling region.
 *
 * The preview stays pinned — it is the thing the host looks at to see what
 * the room sees, and a preview that scrolls away is not a preview. Under it,
 * the control panel and the Recent list share whatever the column has left,
 * and when they cannot both fit the region scrolls rather than squeezing one
 * of them to nothing. On a short window that means the Recent list is the
 * part you scroll to, which is the right way round: it is a log.
 */
const tray = h("aside", { class: "tray" }, [
  previewBox,
  h("div", { class: "tray-body" }, [
    trayControls,
    h("div", { class: "tray-toasts" }, [
      h("p", { class: "label", text: "Recent" }),
      toastList,
    ]),
  ]),
]);

/* ------------------------------------------------------------------ */
/* The preview column's width                                          */
/* ------------------------------------------------------------------ */

/**
 * A splitter between the activity panel and the preview.
 *
 * Wider is a better preview and a narrower scoring grid, and which of those
 * a host wants is not something this file can know — it depends on the room,
 * the laptop and whether they are scoring by hand. So it is theirs to set,
 * and it is remembered.
 *
 * `role="separator"` with a tabindex is the window-splitter pattern, and it
 * is in the tab order on purpose: this console is driven by keyboard, and a
 * resize that can only be dragged is a resize this host cannot do while they
 * are talking. Arrow keys move it, Shift+Arrow moves it faster, Home and End
 * go to the stops, and the widths are the ones runbook.ts clamps to.
 */
const TRAY_KEY = "quorum.host.tray.v1";

const trayGrip = h("div", {
  class: "tray-grip",
  attrs: {
    role: "separator",
    tabindex: "0",
    "aria-orientation": "vertical",
    "aria-label": "Preview column width",
    "aria-valuemin": String(TRAY_MIN),
    "aria-valuemax": String(TRAY_MAX),
    title: "Drag to resize the preview, or focus it and use ← →",
  },
});

/** `null` means "whatever the stylesheet says for this window width". */
let trayWidth: number | null = null;

try {
  trayWidth = parseTrayWidth(localStorage.getItem(TRAY_KEY));
} catch {
  // Storage off. The stylesheet's default is a working console.
}

function saveTray(): void {
  try {
    if (trayWidth === null) localStorage.removeItem(TRAY_KEY);
    else localStorage.setItem(TRAY_KEY, String(trayWidth));
  } catch {
    // See the runbook: it still works, it just will not survive a reload.
  }
}

/**
 * The preview renders the participant surface at 1280 x 800 and scales it
 * down to whatever the column is. It is a transform, so the participant's
 * own container queries still measure 1280px and still resolve to the laptop
 * layout — which is the whole point of previewing at that size.
 */
function sizePreview(): void {
  // Inside the 1px border on each side.
  const inner = Math.max(80, previewFrame.clientWidth);
  previewFrame.style.setProperty("--pv-scale", String(inner / 1280));
}

function applyTray(): void {
  if (trayWidth === null) cols.style.removeProperty("--tray-w");
  else cols.style.setProperty("--tray-w", `${trayWidth}px`);
  setAttr(
    trayGrip,
    "aria-valuenow",
    String(trayWidth ?? Math.round(tray.getBoundingClientRect().width)),
  );
  sizePreview();
}

/**
 * The widest this window can afford.
 *
 * runbook.ts clamps to 216-560px, which is about the preview; this is about
 * everything else. The rail is 300px and the splitter is 6, and the activity
 * panel needs 620 to keep the scoring grid's ~700px table close to fitting.
 * (It used to also have to hold the foot's four secondary controls on one
 * row; those are in the tray now, and the grid is what the number is for.)
 * On a 1512px window that leaves the
 * full 560; on a 1280px laptop it leaves 354, and 354 is the honest answer
 * there — the pixels are not available, and a splitter that let the host drag
 * past them would be a splitter that broke the grid.
 */
const PANEL_FLOOR = 620;

function maxTray(): number {
  const room = window.innerWidth - 300 - 6 - PANEL_FLOOR;
  return Math.max(TRAY_MIN, Math.min(TRAY_MAX, Math.round(room)));
}

function setTray(width: number): void {
  const next = Math.min(clampTray(width), maxTray());
  if (next === trayWidth) return;
  trayWidth = next;
  applyTray();
}

// A window that got narrower must not leave a preview column the panel cannot
// live with. The stylesheet's own default follows the window already; a width
// the host set does not, so it is re-clamped here.
window.addEventListener("resize", () => {
  if (trayWidth !== null) setTray(trayWidth);
  sizePreview();
});

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

const cols = h("div", { class: "cols" }, [rail, panel, trayGrip, tray]);

replace(app, [statusBar, cols, drivingView]);

/* ---- the splitter, by pointer and by key ---- */

let trayDragging = false;

trayGrip.addEventListener("pointerdown", (ev) => {
  const e = ev as PointerEvent;
  if (e.button !== 0) return;
  trayDragging = true;
  trayGrip.setPointerCapture(e.pointerId);
  trayGrip.classList.add("is-dragging");
  e.preventDefault();
});
trayGrip.addEventListener("pointermove", (ev) => {
  if (!trayDragging) return;
  const e = ev as PointerEvent;
  // The splitter is 6px wide and sits to the left of the column it sizes.
  setTray(window.innerWidth - e.clientX - 3);
});
const endTrayDrag = (ev: Event): void => {
  if (!trayDragging) return;
  trayDragging = false;
  trayGrip.classList.remove("is-dragging");
  const e = ev as PointerEvent;
  if (trayGrip.hasPointerCapture(e.pointerId)) {
    trayGrip.releasePointerCapture(e.pointerId);
  }
  saveTray();
};
trayGrip.addEventListener("pointerup", endTrayDrag);
trayGrip.addEventListener("pointercancel", endTrayDrag);
// Nudging it back to the stylesheet's default, which is the one width that
// follows the window rather than a number the host once dragged to.
trayGrip.addEventListener("dblclick", () => {
  trayWidth = null;
  applyTray();
  saveTray();
});

trayGrip.addEventListener("keydown", (ev) => {
  const e = ev as KeyboardEvent;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const now = trayWidth ?? Math.round(tray.getBoundingClientRect().width);
  const step = e.shiftKey ? 48 : 16;
  switch (e.key) {
    case "ArrowLeft":
      setTray(now + step);
      break;
    case "ArrowRight":
      setTray(now - step);
      break;
    case "Home":
      setTray(TRAY_MAX);
      break;
    case "End":
      setTray(TRAY_MIN);
      break;
    default:
      return;
  }
  e.preventDefault();
  saveTray();
});

if (trayWidth !== null) trayWidth = Math.min(trayWidth, maxTray());
applyTray();
// The column also changes width when the window does, and the preview's
// scale is a function of the column. One observer covers both.
new ResizeObserver(() => sizePreview()).observe(previewFrame);
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

/**
 * Practice: run a game for real, and score nobody.
 *
 * The room is meeting most of these games for the first time, and the first
 * run of one is spent learning the rule that ends it — a tap during APPLY
 * drains you; one of the two panes is invented. That is a lesson worth having
 * and a terrible thing to be scored on, so a round can be run once to learn it
 * and once for keeps.
 *
 * It is a toggle rather than a per-round setting because the host is holding
 * the room's attention, not a settings screen: "practice is on" is one fact to
 * keep in your head, and the Desktop and every phone say it out loud so it is
 * not only in the host's head.
 *
 * The engine refuses to change it while a question or a round is live, so the
 * flag can never decide after the fact whether what the room just did counted.
 */
function practiceToggle(): Control {
  return control({
    label: "Practice: off",
    className: "ctl-secondary ctl-practice",
    title:
      "The game runs normally and nobody scores. Use it for a first run, then turn it off and play it for real.",
    question: () =>
      (lastState?.practice ?? false)
        ? "Score the next game?"
        : "Run this game without scoring it?",
    onFire: (c) => issue({ name: "practice", on: !(lastState?.practice ?? false) }, c),
  });
}

/**
 * One flag, two buttons, on the two panels it applies to.
 *
 * It lived in the control panel first, which is where a session-wide switch
 * belongs and is the wrong place for this one: the moment a host decides a
 * game is a practice run is the moment they are looking at that game, about to
 * start it. So the button is on the game, beside the controls that run it, and
 * the control panel no longer carries it at all — a third copy of one flag is
 * a way to be unsure which of them you last pressed.
 */
const arcadePractice = practiceToggle();
const triviaPractice = practiceToggle();
const practiceControls = [arcadePractice, triviaPractice];

const closeControl = control({
  label: "Close session",
  className: "ctl-danger",
  question: "Really close?",
  onFire: (c) => issue({ name: "close" }, c),
});

/**
 * The way back from a close, which used to not exist.
 *
 * Closing was one press behind an inline Yes and it was final: the engine
 * refuses every rule event on a closed session, so a mis-press cost the
 * scores, the join code and thirty rejoins. This puts the session back on
 * `running` with everything it had. It is an ordinary two-step control,
 * because nothing about it is destructive — it is the *undo*, and an undo
 * behind a wall of confirmation is an undo nobody reaches in time.
 *
 * Shown only when the session is closed. There is nothing to reopen otherwise,
 * and a button that is permanently greyed out is a button the eye stops
 * reading.
 */
const reopenControl = control({
  label: "Reopen the session",
  className: "ctl-secondary",
  question: "Carry on where you left off, scores and all?",
  title:
    "Puts the session back to running with every score intact. The segment and scoreboard stay where the close left them.",
  onFire: (c) => issue({ name: "session.reopen" }, c),
});

// These five are assembled into the control panel below, once the wipe's arm
// button exists, because the wipe belongs in the same block as Close session
// and nowhere near Lock joining.

/* ------------------------------------------------------------------ */
/* Starting the session over                                           */
/* ------------------------------------------------------------------ */

/**
 * The wipe, and the three deliberate acts it takes.
 *
 * This is the one control on the console that destroys something nobody can
 * get back, and the console's usual two-step is not enough for it: an inline
 * Yes is one stray click away from a second stray click, and the Yes takes
 * focus on purpose, which puts a destructive button under the space bar's
 * nose. So this is not a {@link control} at all. It is:
 *
 *   1. press **Restart session**, which only opens a panel;
 *   2. **type the word** into a field — the console will not accept anything
 *      else, and a field is the one widget on this page that a stray keypress
 *      cannot turn into an action;
 *   3. press **Wipe**, which is disabled until the
 *      word matches.
 *
 * None of those three is the space bar, and that is structural rather than a
 * rule this file remembers to follow. `bindSpace` ignores the key entirely
 * while the cursor is in a text field, and for any other button it *blurs* the
 * button and fires the primary instead — only the Yes and No of an inline
 * confirm are exempt, and neither of these buttons is one. So space typed at
 * step 2 puts a space in the field, space at step 1 or 3 advances the run of
 * show, and there is no state of this page in which space wipes anything.
 *
 * Escape abandons it at any point and empties the field. So does pressing the
 * arm button again, switching to driving mode, or leaving it thirty seconds —
 * a console armed for a wipe must not still be armed when the host comes back
 * from talking to the room.
 *
 * Why a typed word and not the join code: the code is `hvs.` and twenty-four
 * case-sensitive characters, which is not something a host does in a few
 * seconds under pressure. The join code still guards the *wire* — the command
 * carries it and the server refuses a mismatch — the console just fills it in
 * from the state it was already sent, rather than asking anybody to type it.
 */
const RESTART_WORD = "restart";

/** Long enough to type seven letters, short enough not to sit armed. */
const RESTART_DISARM_MS = 30_000;

const restartArm = handsBackSpace(
  h("button", {
    class: "rs-arm",
    type: "button",
    text: "Restart session",
    attrs: { "aria-expanded": "false", "aria-controls": "restart-panel" },
  }),
) as HTMLButtonElement;

const restartKeeps = h("p", { class: "pb-note rs-keeps" });

const restartField = h("input", {
  class: "field rs-field",
  type: "text",
  attrs: {
    autocomplete: "off",
    autocorrect: "off",
    autocapitalize: "off",
    spellcheck: "false",
    placeholder: RESTART_WORD,
    "aria-label": `Type ${RESTART_WORD} to confirm`,
  },
}) as HTMLInputElement;

const restartGo = h("button", {
  class: "rs-go",
  type: "button",
  text: "Wipe",
  disabled: true,
}) as HTMLButtonElement;

const restartCancel = handsBackSpace(
  h("button", { class: "rs-cancel", type: "button", text: "Cancel" }),
) as HTMLButtonElement;

const restartPanel = h(
  "section",
  { class: "rs-panel", attrs: { id: "restart-panel", hidden: true } },
  [
    h("p", { class: "label rs-label", text: "Restart session" }),
    h("p", {
      class: "rs-loses",
      text: "This wipes every score, every Spot Award, and everything the arcade has done. It cannot be undone.",
    }),
    restartKeeps,
    h("div", { class: "rs-row" }, [
      h("label", { class: "rs-ask", attrs: { for: "restart-word" } }, [
        "Type ",
        h("span", { class: "mono rs-word", text: RESTART_WORD }),
        " to switch the button on",
      ]),
      restartField,
      restartGo,
      restartCancel,
    ]),
  ],
);
setAttr(restartField, "id", "restart-word");

let restartArmed = false;
let restartTimer: ReturnType<typeof setTimeout> | null = null;

function restartTyped(): boolean {
  return restartField.value.trim().toLowerCase() === RESTART_WORD;
}

function syncRestartGo(): void {
  const s = lastState;
  restartGo.disabled =
    !restartTyped() || s === null || s.phase === "draft";
}

function setRestartArmed(on: boolean): void {
  if (on === restartArmed) return;
  restartArmed = on;
  restartPanel.hidden = !on;
  setAttr(restartArm, "aria-expanded", on ? "true" : "false");
  restartArm.classList.toggle("is-armed", on);
  setText(restartArm, on ? "Never mind" : "Restart session");
  // Emptied on the way in as well as on the way out: a field that still holds
  // the word from last time would turn the button on before anybody typed.
  restartField.value = "";
  syncRestartGo();
  if (restartTimer !== null) clearTimeout(restartTimer);
  restartTimer = null;
  if (on) {
    // The control panel scrolls when the tray is narrow, and a panel that
    // opened below the fold is a panel the host thinks did nothing.
    restartPanel.scrollIntoView({ block: "nearest" });
    restartField.focus();
    restartTimer = setTimeout(() => setRestartArmed(false), RESTART_DISARM_MS);
  } else {
    releaseFocus();
  }
}

restartArm.addEventListener("click", () => setRestartArmed(!restartArmed));
restartCancel.addEventListener("click", () => setRestartArmed(false));
restartField.addEventListener("input", syncRestartGo);
restartField.addEventListener("keydown", (ev) => {
  if ((ev as KeyboardEvent).key !== "Enter") return;
  ev.preventDefault();
  fireRestart();
});
restartGo.addEventListener("click", () => fireRestart());

function fireRestart(): void {
  // Two gates, and the second is not decoration. `disabled` is the word the
  // host typed; the join code is the session the command is for, and a console
  // that has not been told which session it is attached to has no business
  // wiping one.
  if (restartGo.disabled) return;
  const code = lastState?.hostExtras?.joinCode ?? "";
  if (code === "") {
    primary.flash("not connected, nothing was changed");
    return;
  }
  // Refusals land in the primary button, which is the one place on this
  // console the host is always looking.
  issue({ name: "session.restart", confirm: code }, primary);
  setRestartArmed(false);
}

/* ------------------------------------------------------------------ */
/* The control panel                                                   */
/* ------------------------------------------------------------------ */

/**
 * Everything pressed once, or never, in one place — and not the place the
 * host's hand lives.
 *
 * The panel foot had grown to five buttons and the primary, which put Close
 * session 8px from Open trivia (space) in the same grey, in the row the host
 * reaches for every thirty seconds. Those five are here now, under the
 * participant preview, grouped by what they are rather than by when they were
 * added:
 *
 *   Session     start it, lock and unlock joining, close, reopen, the wipe
 *   Scoreboard  hide it, show it again, run the 5-to-1 reveal
 *   Shortcuts   the three keys, as buttons, each labelled with its key
 *
 * The lifecycle row at the top of Session is the primary button itself,
 * borrowed while the next thing to press is Open the lobby or Start the
 * session — the host asked for Start to sit with the other lifecycle
 * controls, and the run of show is not a lifecycle. It is the same element,
 * so there is one Start button, it still carries "(space)", and the space bar
 * still finds it: `bindSpace` holds the {@link Control}, not the place it
 * happens to be mounted. Nothing about `spaceVerdict` changes, so nothing
 * about the wipe being off the space bar changes either.
 *
 * The keys are unchanged and every one of them still works from everywhere it
 * worked before; the rail still prints the whole list. These buttons are a
 * second path to three of them, and the key on the face of each is the point:
 * a host who presses "Driving mode SHIFT+D" twice has learned SHIFT+D.
 *
 * The two that cannot be undone are not merely moved, they are walled off —
 * their own bordered block, in the danger colour, under a heading that says
 * so. Close session and Restart session must not read as the same
 * kind of thing as Lock joining, and next to each other in a wrapping row of
 * grey buttons is exactly how they read before.
 *
 * The wipe's three-act guard moves intact: arm, type the word, press a button
 * that is disabled until it matches. Nothing here makes it reachable by the
 * space bar — `spaceVerdict` blurs any focused button that is not an inline
 * confirm's Yes or No and fires the primary instead, and the field swallows
 * the key outright. That is a property of the keydown decision, not of where
 * the buttons are mounted, so moving them cannot weaken it.
 */

/** One shortcut, as a button that teaches its key. */
function shortcutButton(
  name: string,
  keys: string,
  onPress: () => void,
): HTMLButtonElement {
  const button = handsBackSpace(
    h(
      "button",
      {
        class: "cp-key",
        type: "button",
        attrs: { "aria-label": `${name} (${keys})` },
      },
      [
        h("span", { class: "cp-key-name", text: name }),
        // The key is on the face of the button, not in a tooltip: a tooltip is
        // a shortcut nobody learns. Hidden from the accessibility tree because
        // the button's own label already says it, once.
        h("span", {
          class: "mono cp-key-cap",
          text: keys,
          attrs: { "aria-hidden": "true" },
        }),
      ],
    ),
  ) as HTMLButtonElement;
  button.addEventListener("click", onPress);
  return button;
}

const cpHolding = shortcutButton("Holding card", "SHIFT+H", () =>
  showHoldingNow(),
);
const cpDriving = shortcutButton("Driving mode", "SHIFT+D", () =>
  setDriving(!driving),
);
const cpGrid = shortcutButton("Scoring grid", "G", () => {
  // Same two steps the key takes: the grid is on the console, and driving
  // mode is the console put away.
  setDriving(false);
  scoring.focusFirst();
});
setAttr(cpDriving, "aria-pressed", "false");

replace(trayControls, [
  h("section", { class: "cp-group" }, [
    h("p", { class: "label", text: "Session" }),
    // Open the lobby, then Start the session: the primary button itself,
    // borrowed until the session is running. See `placePrimary`.
    cpLifecycle,
    h("div", { class: "cp-row" }, [lockControl.el, reopenControl.el]),
    h("div", { class: "cp-danger" }, [
      h("p", { class: "label cp-danger-label", text: "Cannot be undone" }),
      h("div", { class: "cp-row" }, [closeControl.el, restartArm]),
      restartPanel,
    ]),
  ]),
  h("section", { class: "cp-group" }, [
    h("p", { class: "label", text: "Scoreboard" }),
    h("div", { class: "cp-row" }, [sealControl.el, unsealControl.el]),
  ]),
  h("section", { class: "cp-group" }, [
    h("p", { class: "label", text: "Shortcuts" }),
    h("div", { class: "cp-row cp-row-keys" }, [cpHolding, cpDriving, cpGrid]),
  ]),
]);

/* ------------------------------------------------------------------ */
/* The holding cards                                                   */
/* ------------------------------------------------------------------ */

/**
 * The deck: every holding card this event has, in the host's order.
 *
 * Loaded before the runbook because the runbook points into it — a holding
 * step that has never been told which card it shows is anchored to the first
 * one, which is where the single card the previous build stored ends up.
 *
 * Two keys, and the older one is read rather than dropped:
 *
 *   quorum.host.cards.v1    the deck. What this build writes.
 *   quorum.host.holding.v1  `{title, line}`. What the last build wrote, and
 *                           what a host who set their card up last night has.
 *
 * The old key is also kept *up to date* with whatever card is first in the
 * deck. Nothing here reads it again once the new key exists, and the console
 * would work perfectly well without writing it. It is written because the
 * afternoon this ships into is tomorrow: if this build has to be rolled back
 * at 13:50, the build it rolls back to finds a card where it left one.
 */
const CARDS_KEY = "quorum.host.cards.v1";
const HOLDING_KEY = "quorum.host.holding.v1";

let deck: HoldingDeck = defaultDeck();

/** True when the deck came from the old single-card key, for the note below. */
let deckMigrated = false;

/**
 * Read the deck from storage. A function rather than a block at load, because
 * staged setup arrives after the first state and re-runs exactly this.
 */
function loadDeck(): void {
  try {
    const stored = parseDeck(localStorage.getItem(CARDS_KEY));
    if (stored !== null) {
      deck = stored;
      return;
    }
    const legacy = migrateDeck(localStorage.getItem(HOLDING_KEY));
    if (legacy !== null) {
      deck = legacy;
      deckMigrated = true;
    }
  } catch {
    // Storage off, or blocked. One blank card and a working console.
  }
}

loadDeck();

function saveDeck(): void {
  try {
    localStorage.setItem(CARDS_KEY, JSON.stringify({ cards: deck }));
    // The rollback copy. See above.
    const first = deck[0];
    localStorage.setItem(
      HOLDING_KEY,
      JSON.stringify({ title: first?.title ?? "", line: first?.line ?? "" }),
    );
  } catch {
    // See the runbook: it still works, it just will not survive a reload.
  }
}

// Written straight back, so the migration happens once and a console reloaded
// after it is an ordinary console with a deck.
if (deckMigrated) saveDeck();

/**
 * The card a runbook step shows, or `null` when the step points at a card
 * that is not there any more.
 *
 * `null` is a state a host can produce — delete a card that two steps were
 * using — and it is deliberately not repaired behind their back. A step that
 * silently started showing different words would be worse than a step that
 * says, in the runbook and in the pre-flight list, that it needs a card. The
 * run of show is never broken by it: the step still walks, and what it puts
 * in front of the room is the standby card below.
 *
 * A step with no card id at all is the previous build's stored runbook, and
 * it reads as the first card. `anchorHoldingCards` writes that id in at
 * start-up so the implicit reading is only ever a fallback.
 */
function cardForEntry(entry: RunbookEntry): HoldingCard | null {
  if (entry.kind !== "holding") return null;
  if (entry.card === undefined) return deck[0] ?? null;
  return cardById(deck, entry.card);
}

/**
 * What goes up when there is no card to put up: SHIFT+H before anybody has
 * written anything, or a step whose card was deleted. Neutral and true.
 */
const STANDBY_TITLE = "Back shortly";
const STANDBY_LINE = "Sit tight. We'll pick this up in a moment.";

function cardTitle(card: HoldingCard | null): string {
  const t = card?.title.trim() ?? "";
  return t === "" ? STANDBY_TITLE : t;
}

function cardLine(card: HoldingCard | null): string {
  const l = card?.line.trim() ?? "";
  return l === "" ? STANDBY_LINE : l;
}

/* ------------------------------------------------------------------ */
/* The runbook                                                         */
/* ------------------------------------------------------------------ */

/**
 * Which segments this event runs, and in what order. See runbook.ts for the
 * rules and for why the lobby and the final are not in it.
 *
 * Kept in this browser, like the arcade's running order and for the same
 * reason: a host who sets it up on Thursday finds it on Friday, and a console
 * reloaded at 2:45pm comes back with it still set. Best-effort — storage off
 * means the default runbook and a working console, never a broken one.
 */
const RUNBOOK_KEY = "quorum.host.runbook.v1";

let runbook: Runbook = defaultRunbook();

/** As `loadDeck`, and for the same reason. */
function loadRunbook(): void {
  try {
    runbook = parseRunbook(localStorage.getItem(RUNBOOK_KEY)) ?? defaultRunbook();
  } catch {
    // Storage off, or blocked. The default runbook is the shipped run of show.
  }
}

loadRunbook();

// Every holding step gets the id of the card it shows written into it. For a
// runbook stored by the build before this one that is the first card, which
// is the card the old single-card key migrated into — so a host who wrote
// "Agentic Security TTX" last night finds their runbook still showing it.
{
  const first = deck[0];
  if (first !== undefined) {
    const anchored = anchorHoldingCards(runbook, first.id);
    if (anchored !== runbook) {
      runbook = anchored;
      // Written back once, for the same reason the deck is.
      try {
        localStorage.setItem(RUNBOOK_KEY, JSON.stringify(runbook));
      } catch {
        // Storage off. The anchoring is redone on the next load.
      }
    }
  }
}

function saveRunbook(): void {
  try {
    localStorage.setItem(RUNBOOK_KEY, JSON.stringify(runbook));
  } catch {
    // See above: it still works, it just will not survive a reload, and
    // nothing about that is worth an error in front of a room.
  }
}

/* ------------------------------------------------------------------ */
/* Where the host is in the runbook                                    */
/* ------------------------------------------------------------------ */

/**
 * Which *step* the console believes the room is on.
 *
 * This did not exist before, and it did not have to: a runbook held each
 * segment at most once, so "the segment the room is in" and "the step we are
 * on" were the same fact and the wire carried it. With two holding steps they
 * come apart \u2014 `segment: "holding"` no longer says whether that is the TTX
 * before trivia or the coffee break after the arcade, and the space bar has
 * to know which, or it walks the wrong way.
 *
 * So the console keeps a cursor. It moves when the host advances, when they
 * click a step in the rail, when they press a Show button, and when SHIFT+H
 * puts a card up. Everything else leaves it alone.
 *
 * The wire still wins over it. `currentEntry` checks the cursor against the
 * segment the room is actually in and re-derives it when they disagree, which
 * is what happens when a step is deleted underneath it, when a second console
 * moves the session, or when a reload lands in the middle of the afternoon.
 * The engine is never asked about any of this: a step id is console
 * vocabulary and putting one on the wire would be a protocol change for a
 * feature that does not need one.
 */
const AT_KEY = "quorum.host.at.v1";

let atSid: string | null = null;
let atId: string | null = null;

/**
 * The step the console has just *asked* the room to go to, until the room
 * says it is there.
 *
 * Arriving at a holding step is two commands, and the engine broadcasts after
 * each: the card first, then the segment. So between them a state arrives
 * that carries the new card and the *old* segment \u2014 and a cursor checked
 * against that state looks wrong, gets re-derived to the segment the room is
 * still in, and is gone by the time the second broadcast lands. The console
 * then falls back to "the first holding step", which with two of them is a
 * coin toss, and the space bar walks the wrong way. That is exactly the
 * failure this cursor exists to prevent, and it showed up on the second
 * holding card the first time the run of show was walked end to end.
 *
 * So the intent outlives the gap. It is consulted only when its kind matches
 * the segment the room reports, which means a stale one can never point the
 * console at the wrong *segment* \u2014 at worst it would prefer one holding step
 * over another \u2014 and every navigation overwrites it.
 */
let atWanted: string | null = null;

/** The card the console last put in front of the room, for SHIFT+H. */
let lastShownCardId: string | null = null;

/**
 * Picked back up after a reload, and only for the session it was written in.
 * A console reloaded at 14:45 between two holding steps comes back on the
 * right one; a console pointed at a different session starts from what the
 * wire says.
 */
function loadAt(sid: string): void {
  if (atSid === sid) return;
  atSid = sid;
  atId = null;
  try {
    const raw = localStorage.getItem(AT_KEY);
    if (raw === null) return;
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return;
    const o = v as { sid?: unknown; id?: unknown };
    if (o.sid !== sid) return;
    if (typeof o.id === "string") atId = o.id;
    if (typeof (o as { card?: unknown }).card === "string") {
      lastShownCardId = (o as { card: string }).card;
    }
  } catch {
    // Storage off. The wire says which segment; that is enough to run on.
  }
}

function saveAt(): void {
  if (atSid === null) return;
  try {
    localStorage.setItem(
      AT_KEY,
      JSON.stringify({ sid: atSid, id: atId, card: lastShownCardId }),
    );
  } catch {
    // See the runbook: it still works, it just will not survive a reload.
  }
}

/**
 * The step the console is on, checked against the room.
 *
 * The cursor is trusted only while it agrees with the segment the wire says
 * is up. When it does not, the room wins and the first step of that kind is
 * taken instead \u2014 preferring one that is in the runbook, because a host who
 * jumped to a segment they had taken out still wants the plan to carry on
 * from the nearest thing in it.
 */
function currentEntry(s: RenderState): RunbookEntry | null {
  const rail = runbookRail(runbook);
  // The step we asked for wins the moment the room is in its segment. This is
  // the only thing that can tell two holding steps apart across the two
  // broadcasts it takes to arrive at one.
  const wanted = atWanted === null ? undefined : rail.find((e) => e.id === atWanted);
  if (wanted !== undefined && wanted.kind === s.segment) {
    atWanted = null;
    return wanted;
  }
  const at = atId === null ? undefined : rail.find((e) => e.id === atId);
  if (at !== undefined && at.kind === s.segment) {
    // Two holding steps, and the cursor is on the one the room is *not*
    // looking at. That happens after a reload, and after a card is put up
    // some other way; the card on the screen is the better evidence, so the
    // console moves to the step that owns it. Only when the cursor's own card
    // disagrees, so a step is never dragged off a card it is correctly on.
    if (s.segment === "holding") {
      const up = cardMatching(deck, s.holding?.title, s.holding?.line);
      if (up !== null && cardForEntry(at)?.id !== up.id) {
        const owner = stepForCard(up.id);
        if (owner !== null) return owner;
      }
    }
    return at;
  }
  return (
    rail.find((e) => e.kind === s.segment && e.included) ??
    rail.find((e) => e.kind === s.segment) ??
    null
  );
}

/** The step that shows this card, preferring one that is in the runbook. */
function stepForCard(cardId: string): RunbookEntry | null {
  const steps = holdingSteps(runbook).filter((e) => e.card === cardId);
  return steps.find((e) => e.included) ?? steps[0] ?? null;
}

/** The first holding row in the rail \u2014 where the cursor lands when a card
 *  that no step owns goes up, so the rail still marks the right kind of row. */
function firstHoldingStepId(): string | null {
  return holdingSteps(runbook)[0]?.id ?? null;
}

/**
 * Go to a step: send its card if it has one, then switch the room to it.
 *
 * The card goes first so the room never sees the previous card's second line
 * under this one's title \u2014 the same order SHIFT+H has always used. Two
 * commands and no new ones: `setHolding` has always taken a title and a line.
 */
function goToEntry(entry: RunbookEntry, from: Control | null): void {
  atId = entry.id;
  atWanted = entry.id;
  if (entry.kind === "holding") {
    const card = cardForEntry(entry);
    lastShownCardId = card?.id ?? null;
    issue({ name: "holding", title: cardTitle(card), line: cardLine(card) }, from);
  }
  issue({ name: "segment", kind: entry.kind }, from);
  saveAt();
  // Nothing is re-rendered here on purpose. The state that comes back is what
  // repaints the console, as it was before any of this existed — and a render
  // against the state we are *leaving* would throw the cursor away: it would
  // see a holding step against a segment that is still trivia, call the
  // cursor wrong, and re-derive it to the row the room is on. The next real
  // state arrives with `segment: "holding"`, the cursor agrees with it, and
  // the console stays on the step the host actually asked for rather than on
  // whichever holding step happens to come first.
}

/**
 * Put one card up, from a Show button or from SHIFT+H, wherever the host is.
 *
 * The cursor follows it onto the step that owns the card, so the rail keeps
 * marking a row of the kind the room is actually in and the main button keeps
 * offering what comes after it. That is what the console did before this
 * change, when there was one holding row for it to land on.
 */
function showCard(card: HoldingCard | null, from: Control | null): void {
  const s = lastState;
  if (s === null) return;
  if (s.phase !== "running") {
    (from ?? primary).flash("nothing is in front of the room yet");
    return;
  }
  lastShownCardId = card?.id ?? null;
  issue(
    { name: "holding", title: cardTitle(card), line: cardLine(card) },
    from ?? primary,
  );
  if (s.segment !== "holding") {
    issue({ name: "segment", kind: "holding" }, from ?? primary);
  }
  const step = card === null ? null : stepForCard(card.id);
  atId = step?.id ?? firstHoldingStepId();
  atWanted = atId;
  saveAt();
  // See `goToEntry`: the state coming back is the repaint, and a render
  // against the segment we are leaving would undo the cursor.
}

interface RailRow {
  readonly li: HTMLLIElement;
  readonly button: HTMLButtonElement;
  readonly mark: HTMLElement;
  readonly name: HTMLElement;
  readonly tag: HTMLElement;
}

/**
 * One row per *step*, not per segment.
 *
 * It used to be per segment, built once at start-up, because a runbook could
 * hold each segment at most once. A runbook with two holding steps in it has
 * two rows that are both `holding`, and they are not interchangeable: one is
 * the TTX and one is the coffee break, and the whole point of naming them is
 * that the rail reads like the afternoon.
 *
 * Keyed by step id and cached, so the rows are still moved rather than
 * rebuilt — nothing the host is pointing at changes identity underneath them
 * — and rows for steps that no longer exist are dropped.
 */
const railRows = new Map<string, RailRow>();

function railRow(id: string): RailRow {
  const existing = railRows.get(id);
  if (existing !== undefined) return existing;
  const mark = h("span", { class: "seg-mark", text: "○" });
  const name = h("span", { class: "seg-name" });
  const tag = h("span", { class: "seg-phase mono", attrs: { hidden: true } });
  const button = h("button", { class: "seg", type: "button" }, [mark, name, tag]);
  handsBackSpace(button);
  button.addEventListener("click", () => {
    const entry = entryById(runbook, id);
    if (entry === null) return;
    goToEntry(entry, null);
  });
  const li = h("li", {}, [button]);
  const row: RailRow = { li, button, mark, name, tag };
  railRows.set(id, row);
  return row;
}

/**
 * The rail, in the host's order.
 *
 * Every step is listed, including the ones taken out of the runbook —
 * marked, and still one click away. Out of the runbook means "not on the
 * space bar", never "not at all": the rail is also the way off the plan when
 * the room runs long, and a console that could not jump to trivia because
 * trivia was not in the plan would be a console that had lost a feature at
 * 2:45pm.
 */
function renderRail(): void {
  const wanted = runbookRail(runbook);
  const seen = new Set<string>();
  for (const entry of wanted) {
    const row = railRow(entry.id);
    seen.add(entry.id);
    // appendChild on a node that is already a child *moves* it, which is how
    // the order follows the runbook without anything being rebuilt.
    railSegments.appendChild(row.li);
    setText(row.name, entryName(entry));
    setAttr(row.button, "aria-label", entryFullName(entry));
    row.button.classList.toggle("is-out", !entry.included);
    // A step pointing at a card that is not there says so here as well as in
    // setup: the rail is where the host looks while the room is waiting.
    const missing = entry.kind === "holding" && cardForEntry(entry) === null;
    const tag = missing ? "no card" : entry.included ? "" : "out";
    row.tag.hidden = tag === "";
    row.tag.classList.toggle("is-missing", missing);
    setText(row.tag, tag);
  }
  for (const [id, row] of railRows) {
    if (seen.has(id)) continue;
    row.li.remove();
    railRows.delete(id);
  }
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

/**
 * The join code and the join link, both at reading size, both copyable.
 *
 * The code used to be set in 34px with 0.26em of tracking, and that was right
 * once: it was a four-letter word ("RAFT survives a bad microphone") read
 * aloud to a room off a shared screen, and tracking is what makes four
 * shouted letters legible. It is not that any more. It is a 28-character
 * `hvs.` token that goes into the meeting chat by copy and paste, and at that
 * length 0.26em of tracking is actively worse: it spreads the token past the
 * panel and it breaks it into a field of characters with no word shape left
 * to check against. So it sits at the link's 14px with no tracking, and the
 * host stops having to read it at all.
 *
 * Both stay on screen. The link is what goes into the chat; the sign-in page
 * asks for the code specifically, so somebody who has the link still needs
 * it, and somebody who has lost the chat message still needs the link.
 */
const bodyLobbyCode = h("span", { class: "mono join-code" });
const bodyLobbyUrl = h("span", { class: "mono join-url" });
const bodyLobbyCount = h("span", { class: "mono big-num" });
const bodyLobbyLock = h("span", { class: "mono lock-state" });

/**
 * Copy, and three ways to fail out loud rather than silently.
 *
 * `navigator.clipboard` needs a secure context. Localhost is one and the
 * deployment is one, but a console opened over plain http on a LAN address is
 * not, and the host finds that out at 14:00 with thirty people waiting. So:
 * the async clipboard, then the old `execCommand` path, and if neither
 * works the button says "Select it, then ⌘C" and selects the text for
 * them. The word they wanted is on screen either way.
 */
function copyText(text: string): Promise<boolean> {
  const legacy = (): boolean => {
    try {
      const box = h("textarea", {
        attrs: {
          "aria-hidden": "true",
          style: "position:fixed;top:0;left:0;opacity:0;pointer-events:none",
        },
      }) as HTMLTextAreaElement;
      box.value = text;
      document.body.appendChild(box);
      box.select();
      const ok = document.execCommand("copy");
      box.remove();
      return ok;
    } catch {
      return false;
    }
  };
  try {
    const api = navigator.clipboard;
    if (api !== undefined && typeof api.writeText === "function") {
      return api.writeText(text).then(
        () => true,
        () => legacy(),
      );
    }
  } catch {
    // Reading the property can itself throw in a locked-down browser.
  }
  return Promise.resolve(legacy());
}

/** Select the thing on screen, so ⌘C still works when nothing else does. */
function selectElement(el: HTMLElement): void {
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  } catch {
    // Nothing to do; the button already said what to press.
  }
}

const COPY_SAID_MS = 2_500;

/** The two-sheets copy mark. Its own constant so the idle and reset paths
 *  cannot drift apart. */
const COPY_MARK = "⧉";

function copyButton(what: string, source: HTMLElement): HTMLButtonElement {
  const button = handsBackSpace(
    h("button", {
      class: "copy-btn",
      type: "button",
      // A glyph, with the words in `aria-label` and `title`. The row is the
      // join code or a long URL and both want the width; the button is beside
      // text that already says what it is. ⧉ is the two-sheets copy mark, and
      // the system stack has it — which it would not reliably have had under
      // IBM Plex.
      text: COPY_MARK,
      attrs: { "aria-label": `Copy the ${what}`, title: `Copy the ${what}` },
    }),
  ) as HTMLButtonElement;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const say = (word: string, ok: boolean): void => {
    setText(button, word);
    button.classList.toggle("is-done", ok);
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      setText(button, COPY_MARK);
      button.classList.remove("is-done");
    }, COPY_SAID_MS);
  };
  button.addEventListener("click", () => {
    const text = source.textContent ?? "";
    if (text === "" || text.includes("——")) {
      say("Not connected", false);
      return;
    }
    void copyText(text).then((ok) => {
      if (!ok) selectElement(source);
      // A tick rather than the word: the state is carried by the glyph
      // changing, not by the colour, and the button keeps its width so the
      // row does not jump under the cursor.
      say(ok ? "✓" : "Select it, then ⌘C", ok);
    });
  });
  return button;
}

const copyCode = copyButton("code", bodyLobbyCode);
const copyUrl = copyButton("link", bodyLobbyUrl);

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

/* The Desktop had a row here, ticked by hand: nothing on the wire tells the
   console whether a Desktop is connected, so it asked the host to look at the
   projector and confirm. Removed at the user's request. A checklist the host
   has to answer on the product's behalf is a checklist item about the
   product, not about the room — and the host is looking at the shared screen
   anyway. If it comes back it should come back as a real check, which needs a
   field on the wire. */

const pfCards = preflightRow();
const pfQuestions = preflightRow();
const pfArcade = preflightRow();
const pfPeople = preflightRow();

const preflight = h("section", { class: "pf" }, [
  h("p", { class: "label", text: "Preflight checklist" }),
  h("ul", { class: "pf-list" }, [
    pfCards.el,
    pfQuestions.el,
    pfArcade.el,
    pfPeople.el,
  ]),
  h("p", {
    class: "pb-note",
  }),
]);

/* ---- the runbook, set before the room arrives ---------------------- */

/**
 * The runbook editor.
 *
 * The same shape as the arcade's running order below it, on purpose: a host
 * who has learned one has learned the other. Rows move with the two arrow
 * buttons, with Alt+Up and Alt+Down from anywhere inside a row, or by
 * dragging. The buttons are the path that matters — this console is driven by
 * keyboard while its host is talking to thirty people, and a reorder that can
 * only be done with a mouse is a reorder that cannot be done at all. Drag is
 * the extra, not the mechanism.
 *
 * Focus is put back on the control that was pressed after every change, since
 * the rows are rebuilt: a keyboard user pressing Alt+Down twice must move the
 * same row twice.
 */
/**
 * What the console calls a step.
 *
 * The holding card is the segment an *off-platform* activity is run in — the
 * TTX has no Quorum surface, so for thirty-five minutes the holding card is
 * the TTX. So a holding step is called by the name of the card it shows, and
 * the runbook and the rail read like the actual run of show:
 * `Lobby · Agentic Security TTX · Trivia · Arcade · Coffee break · Standings`
 * rather than the same generic placeholder twice.
 *
 * Console only. The room sees the card itself, which has always carried the
 * title; this is about the host being able to read their own plan.
 */
const SEGMENT_MAX_NAME = 22;

function entryFullName(entry: RunbookEntry): string {
  if (entry.kind !== "holding") return SEGMENT_LABEL[entry.kind];
  const card = cardForEntry(entry);
  // A step whose card was deleted keeps the generic name rather than
  // borrowing another card's: the missing card is said in its own words, on
  // the row and in the pre-flight list, and a name that lied would be worse.
  if (card === null) return SEGMENT_LABEL.holding;
  return cardName(card);
}

/** The same name, cut to something a 216px rail can hold. */
function entryName(entry: RunbookEntry): string {
  const full = entryFullName(entry);
  return full.length > SEGMENT_MAX_NAME
    ? `${full.slice(0, SEGMENT_MAX_NAME - 1)}\u2026`
    : full;
}

const runbookRows = h("div", { class: "a-setup-rows" });
const runbookNote = h("p", { class: "pb-note a-setup-note", attrs: { hidden: true } });

/**
 * Another holding step.
 *
 * A runbook can hold several, each showing a different card, which is what
 * lets one afternoon read `Lobby \u00b7 Agentic Security TTX \u00b7 Trivia \u00b7 Arcade \u00b7
 * Coffee break \u00b7 Standings \u00b7 Final`. The new step goes on the end, showing the
 * first card in the list, and the host moves it and points it at the card
 * they mean \u2014 a row that appeared in the middle of the list would be a list
 * that had rearranged itself under them.
 */
const runbookAdd = handsBackSpace(
  h("button", {
    class: "a-setup-add",
    type: "button",
    text: "+ Add a holding step",
    attrs: {
      "aria-label": "Add another holding step to the runbook",
      title: "A second place in the afternoon that shows a holding card",
    },
  }),
) as HTMLButtonElement;

runbookAdd.addEventListener("click", () => {
  const first = deck[0];
  if (first === undefined) return;
  changeRunbook(
    addHoldingStep(runbook, first.id),
    `That is as many holding steps as the runbook takes (${HOLDING_STEPS_MAX}). Point one of the ones you have at a different card instead.`,
  );
  // The new row is last, and the panel scrolls: bring the host to it and put
  // the cursor on its card chooser, which is the next thing they want.
  const added = runbook[runbook.length - 1];
  if (added !== undefined) {
    focusRunbookRow({ id: added.id, role: "card" });
    runbookRows.lastElementChild?.scrollIntoView({ block: "nearest" });
  }
});

const runbookSetup = h("section", { class: "a-setup" }, [
  h("p", { class: "label", text: "Runbook" }),
  h("p", {
    class: "pb-note",
    text: "Set this before you start. The main button follows this order and always says what is next. Anything you take out stays in the rail, one click away.",
  }),
  runbookRows,
  h("div", { class: "a-setup-addrow" }, [runbookAdd]),
  runbookNote,
  h("p", {
    class: "pb-note",
    text: "Move a row with its arrows, with Alt+↑ and Alt+↓, or by dragging. Lobby and Final are fixed.",
  }),
  h("p", {
    class: "pb-note",
    text: "A holding step shows one of your cards, picked on the row. Add one for each gap in the afternoon. The main button walks them in order.",
  }),
]);

function noteRunbook(message: string): void {
  setText(runbookNote, message);
  runbookNote.hidden = message === "";
  // A refusal the host cannot see is a button that silently did nothing. The
  // panel scrolls, so the words are brought to where they are looking.
  if (message !== "") runbookNote.scrollIntoView({ block: "nearest" });
}

/** Which control to put the cursor back on once the rows are rebuilt. */
interface RunbookFocus {
  readonly id: string;
  readonly role: string;
}

function focusRunbookRow(want: RunbookFocus): void {
  const row = runbookRows.querySelector(`[data-id="${want.id}"]`);
  if (!(row instanceof HTMLElement)) {
    // The row is gone — the host just deleted the step they were standing on.
    // The Add button is the nearest thing that is still there, and it beats
    // losing the cursor to the top of the document.
    runbookAdd.focus();
    return;
  }
  const exact = row.querySelector(`[data-role="${want.role}"]`);
  if (exact instanceof HTMLElement && !isDisabled(exact)) {
    exact.focus();
    return;
  }
  // The control it was on is disabled now — it moved to an end. Anything in
  // the same row beats losing the cursor to the top of the document.
  const any = Array.from(row.querySelectorAll("button, select")).find(
    (b) => b instanceof HTMLElement && !isDisabled(b),
  );
  if (any instanceof HTMLElement) any.focus();
}

function isDisabled(el: HTMLElement): boolean {
  return (
    (el instanceof HTMLButtonElement || el instanceof HTMLSelectElement) &&
    el.disabled
  );
}

function changeRunbook(
  next: Runbook,
  refused: string,
  focus?: RunbookFocus,
): void {
  if (next === runbook) {
    noteRunbook(refused);
    if (focus !== undefined) focusRunbookRow(focus);
    return;
  }
  runbook = next;
  noteRunbook("");
  saveRunbook();
  renderRunbookSetup();
  renderRail();
  if (focus !== undefined) focusRunbookRow(focus);
  if (lastState) render(lastState);
}

/** The row being dragged, for the pointer path. Its step id. */
let runbookDrag: string | null = null;

const RUNBOOK_FULL =
  "Keep at least one segment. The runbook has to have something between the lobby and the final.";

/**
 * One row per step: where it comes in the order, what it is, and the three
 * things a host can do to it — move it, take it out, and (for a holding step
 * they added) delete it outright.
 *
 * A holding step also carries the one piece of content a step can have: which
 * card it shows. That is a `select` rather than a pair of cycling arrows
 * because it has to say which card is chosen *and* what the others are, at a
 * glance, on a row the host is reading down; and because a native select is
 * the one widget on this page that is keyboard-operable everywhere without
 * this file having to reimplement it.
 */
function renderRunbookSetup(): void {
  const included = runbookIncludedEntries(runbook);
  replace(
    runbookRows,
    runbook.map((entry, i) => {
      const id = entry.id;
      const name = entryFullName(entry);
      const move = (role: "up" | "down", delta: -1 | 1): HTMLButtonElement => {
        const button = handsBackSpace(
          h("button", {
            class: "a-setup-move",
            type: "button",
            text: delta === -1 ? "\u2191" : "\u2193",
            disabled: delta === -1 ? i === 0 : i === runbook.length - 1,
            attrs: {
              "data-role": role,
              "aria-label": `Move ${name} ${delta === -1 ? "earlier" : "later"}`,
            },
          }),
        );
        button.addEventListener("click", () =>
          changeRunbook(moveRunbook(runbook, id, delta), "", { id, role }),
        );
        return button;
      };
      const inOut = handsBackSpace(
        h("button", {
          class: entry.included ? "a-setup-in on" : "a-setup-in",
          type: "button",
          text: entry.included ? "In" : "Out",
          attrs: {
            "data-role": "inout",
            "aria-pressed": entry.included ? "true" : "false",
            "aria-label": entry.included
              ? `${name} is in the runbook`
              : `${name} is out of the runbook`,
          },
        }),
      );
      inOut.addEventListener("click", () =>
        changeRunbook(
          toggleRunbook(runbook, id),
          isLastIncludedSegment(runbook, id) ? RUNBOOK_FULL : "",
          { id, role: "inout" },
        ),
      );

      /* ---- which card, for a holding step ---- */
      const missing = entry.kind === "holding" && cardForEntry(entry) === null;
      let chooser: HTMLElement | null = null;
      if (entry.kind === "holding") {
        const select = h("select", {
          class: "rb-card",
          attrs: {
            "data-role": "card",
            "aria-label": "Which holding card this step shows",
          },
        }) as HTMLSelectElement;
        for (const card of deck) {
          const option = h("option", {
            text: cardName(card),
            attrs: { value: card.id },
          }) as HTMLOptionElement;
          option.selected = card.id === entry.card;
          select.appendChild(option);
        }
        if (missing) {
          // The step points at a card that is not in the deck any more. The
          // chooser says so in the one place the host is looking, and it is
          // selected, so the row does not silently claim a card it is not
          // showing.
          const gone = h("option", {
            text: "Pick a card",
            attrs: { value: "" },
          }) as HTMLOptionElement;
          gone.selected = true;
          select.insertBefore(gone, select.firstChild);
        }
        select.addEventListener("change", () => {
          const pick = select.value;
          if (pick === "") return;
          changeRunbook(setEntryCard(runbook, id, pick), "", { id, role: "card" });
        });
        chooser = h("div", { class: "rb-card-row" }, [
          h("span", { class: "label", text: "Card" }),
          select,
        ]);
      }

      /* ---- delete, for a holding step the host added ---- */
      const acts: HTMLElement[] = [move("up", -1), move("down", 1), inOut];
      if (isRemovableStep(entry)) {
        const drop = handsBackSpace(
          h("button", {
            class: "a-setup-move rb-drop",
            type: "button",
            text: "\u00d7",
            attrs: {
              "data-role": "drop",
              "aria-label": `Delete the step ${name}`,
              title: `Delete this step. The card itself stays in the list.`,
            },
          }),
        );
        drop.addEventListener("click", () =>
          changeRunbook(removeStep(runbook, id), RUNBOOK_FULL, {
            id,
            role: "drop",
          }),
        );
        acts.push(drop);
      }

      const row = h(
        "div",
        {
          class: entry.included ? "a-setup-row rb-row" : "a-setup-row rb-row is-out",
          attrs: { draggable: "true", "data-id": id },
        },
        [
          h("span", {
            class: "mono rb-grip",
            text: "\u2807",
            attrs: { "aria-hidden": "true" },
          }),
          h("span", {
            class: "mono a-setup-pos",
            text: entry.included
              ? String(included.findIndex((e) => e.id === id) + 1)
              : "\u2013",
          }),
          h("div", { class: "a-setup-main" }, [
            h("span", { class: "a-setup-name", text: name }),
            chooser,
            missing
              ? h("span", {
                  class: "a-setup-what rb-missing",
                  text: "The card this step showed was deleted. Pick another, or take the step out. Until then it shows \"Back shortly\".",
                })
              : null,
          ]),
          h("div", { class: "a-setup-acts" }, acts),
        ],
      );

      /* ---- the keyboard path ---- */
      row.addEventListener("keydown", (ev) => {
        const e = ev as KeyboardEvent;
        if (!e.altKey || e.metaKey || e.ctrlKey) return;
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        e.stopPropagation();
        const role =
          document.activeElement instanceof HTMLElement
            ? (document.activeElement.dataset["role"] ?? "up")
            : "up";
        changeRunbook(
          moveRunbook(runbook, id, e.key === "ArrowUp" ? -1 : 1),
          "",
          { id, role },
        );
      });

      /* ---- the pointer path ---- */
      row.addEventListener("dragstart", (ev) => {
        runbookDrag = id;
        row.classList.add("is-dragging");
        const dt = (ev as DragEvent).dataTransfer;
        if (dt) {
          dt.effectAllowed = "move";
          dt.setData("text/plain", id);
        }
      });
      row.addEventListener("dragend", () => {
        runbookDrag = null;
        row.classList.remove("is-dragging");
      });
      row.addEventListener("dragover", (ev) => {
        if (runbookDrag === null || runbookDrag === id) return;
        ev.preventDefault();
        const dt = (ev as DragEvent).dataTransfer;
        if (dt) dt.dropEffect = "move";
        row.classList.add("is-over");
      });
      row.addEventListener("dragleave", () => row.classList.remove("is-over"));
      row.addEventListener("drop", (ev) => {
        ev.preventDefault();
        row.classList.remove("is-over");
        const moved = runbookDrag;
        runbookDrag = null;
        if (moved === null || moved === id) return;
        changeRunbook(dropRunbook(runbook, moved, i), "");
      });

      return row;
    }),
  );
  runbookAdd.disabled = holdingSteps(runbook).length >= HOLDING_STEPS_MAX;
}

/** Where the arcade running order sits while the session has not started. */
const lobbySetupSlot = h("div", { class: "lobby-setup" });

/** And where the holding card is written, for the same stretch of time. */
const holdingSetupSlot = h("div", { class: "lobby-setup" });

const bodyLobby = h("section", { class: "pb" }, [
  h("div", { class: "kv" }, [
    h("span", { class: "label", text: "Join code" }),
    bodyLobbyCode,
    copyCode,
  ]),
  h("div", { class: "kv" }, [
    h("span", { class: "label", text: "Join link" }),
    bodyLobbyUrl,
    copyUrl,
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
  runbookSetup,
  lobbySetupSlot,
  holdingSetupSlot,
]);

/* ------------------------------------------------------------------ */
/* The holding cards, written before the room arrives                  */
/* ------------------------------------------------------------------ */

/**
 * The card editor: one row per card, a title and a second line each.
 *
 * Setup only, like the runbook above it and the arcade's running order below
 * it, and for the same reason: what the cards say is knowable on Thursday,
 * and a thing that can be rewritten mid-session is a thing that gets
 * rewritten by accident. Once the session is running the Holding card
 * segment lists the cards with a button each, and the rail still jumps to any
 * of them \u2014 what goes away is the typing, not the reach.
 *
 * Nothing typed here goes anywhere near the room. It is saved to this
 * browser on every keystroke and sent to nobody: the only things that put a
 * card in front of thirty people are the main button walking into a holding
 * step, a rail jump, a Show button, and SHIFT+H.
 */
const cardsRows = h("div", { class: "a-setup-rows" });
const cardsNote = h("p", { class: "pb-note a-setup-note", attrs: { hidden: true } });

const cardsAdd = handsBackSpace(
  h("button", {
    class: "a-setup-add",
    type: "button",
    text: "+ Add a card",
    attrs: { "aria-label": "Add another holding card" },
  }),
) as HTMLButtonElement;

const cardsSetup = h("section", { class: "a-setup" }, [
  h("p", { class: "label", text: "Holding cards" }),
  h("p", {
    class: "pb-note",
    text: "What the room looks at between activities: the TTX, a coffee break, a gap while you set up. Write them now. They stay in this browser.",
  }),
  cardsRows,
  h("div", { class: "a-setup-addrow" }, [cardsAdd]),
  cardsNote,
  h("p", {
    class: "pb-note",
    text: "Nothing here reaches the room until you show it. A card goes up when the main button walks into its step, when you click it in the rail, when you press Show it to the room, or with SHIFT+H.",
  }),
  h("p", {
    class: "pb-note",
    text: "Name it something you would recognise in a hurry. The title is what the room reads and what the rail calls the step.",
  }),
]);
holdingSetupSlot.appendChild(cardsSetup);

function noteCards(message: string): void {
  setText(cardsNote, message);
  cardsNote.hidden = message === "";
  if (message !== "") cardsNote.scrollIntoView({ block: "nearest" });
}

/** Which control to put the cursor back on once the card rows are rebuilt. */
function focusCardRow(id: string, role: string): void {
  const row = cardsRows.querySelector(`[data-card="${id}"]`);
  if (!(row instanceof HTMLElement)) {
    cardsAdd.focus();
    return;
  }
  const exact = row.querySelector(`[data-role="${role}"]`);
  if (exact instanceof HTMLElement && !isDisabled(exact)) {
    exact.focus();
    return;
  }
  const any = Array.from(row.querySelectorAll("button, input")).find(
    (b) => b instanceof HTMLElement && !isDisabled(b),
  );
  if (any instanceof HTMLElement) any.focus();
}

/**
 * A structural change to the deck \u2014 one that adds, removes or moves a card.
 * Typing does not come through here: it edits one card in place and leaves
 * the rows alone, because rebuilding a row the host is typing into is how a
 * console eats keystrokes.
 */
function changeDeck(next: HoldingDeck, refused: string, focus?: [string, string]): void {
  if (next === deck) {
    noteCards(refused);
    if (focus !== undefined) focusCardRow(focus[0], focus[1]);
    return;
  }
  deck = next;
  noteCards("");
  saveDeck();
  renderCardsSetup();
  renderHoldingPanel();
  renderRunbookSetup();
  renderRail();
  if (focus !== undefined) focusCardRow(focus[0], focus[1]);
  if (lastState) render(lastState);
}

/** A card's words changed. The rows stay; everything that names them follows. */
function renamedCard(): void {
  saveDeck();
  renderHoldingPanel();
  renderRunbookSetup();
  renderRail();
  if (lastState) render(lastState);
}

const CARDS_FULL = `That is as many holding cards as one afternoon takes (${CARD_MAX}).`;
const CARDS_LAST =
  "Keep at least one card. SHIFT+H has to have something to put up, and that is the key you reach for when something has gone wrong.";

function renderCardsSetup(): void {
  replace(
    cardsRows,
    deck.map((card, i) => {
      const id = card.id;
      const name = cardName(card);

      const title = h("input", {
        class: "field",
        type: "text",
        placeholder: "Agentic Security TTX",
        value: card.title,
        attrs: {
          maxlength: String(CARD_TITLE_MAX),
          "data-role": "title",
          "aria-label": `Card ${i + 1} title`,
        },
      }) as HTMLInputElement;
      const line = h("input", {
        class: "field",
        type: "text",
        placeholder: "Back at 14:20. Prize: the good coffee.",
        value: card.line,
        attrs: {
          maxlength: String(CARD_LINE_MAX),
          "data-role": "line",
          "aria-label": `Card ${i + 1} second line`,
        },
      }) as HTMLInputElement;

      title.addEventListener("input", () => {
        deck = editCard(deck, id, { title: title.value });
        renamedCard();
      });
      line.addEventListener("input", () => {
        deck = editCard(deck, id, { line: line.value });
        renamedCard();
      });
      for (const field of [title, line]) {
        field.addEventListener("keydown", (ev) => {
          const e = ev as KeyboardEvent;
          // Escape and Enter both get the cursor out. This matters at 13:59:
          // a host who left the caret in here would press space at 14:00 and
          // type a space into a text field instead of starting the session.
          if (e.key === "Escape") {
            field.blur();
            return;
          }
          if (e.key !== "Enter") return;
          e.preventDefault();
          field.blur();
        });
      }

      const move = (role: "up" | "down", delta: -1 | 1): HTMLButtonElement => {
        const button = handsBackSpace(
          h("button", {
            class: "a-setup-move",
            type: "button",
            text: delta === -1 ? "\u2191" : "\u2193",
            disabled: delta === -1 ? i === 0 : i === deck.length - 1,
            attrs: {
              "data-role": role,
              "aria-label": `Move ${name} ${delta === -1 ? "earlier" : "later"}`,
            },
          }),
        );
        button.addEventListener("click", () =>
          changeDeck(moveCard(deck, id, delta), "", [id, role]),
        );
        return button;
      };

      const drop = handsBackSpace(
        h("button", {
          class: "a-setup-move rb-drop",
          type: "button",
          text: "\u00d7",
          attrs: {
            "data-role": "drop",
            "aria-label": `Delete the card ${name}`,
            title: "Delete this card",
          },
        }),
      );
      drop.addEventListener("click", () => {
        const using = holdingSteps(runbook).filter((e) => e.card === id).length;
        changeDeck(removeCard(deck, id), isLastCard(deck, id) ? CARDS_LAST : "", [
          id,
          "drop",
        ]);
        // Said after the fact rather than asked before it: the runbook rows
        // that pointed here now say so themselves, the pre-flight list counts
        // them, and none of it breaks the run of show.
        if (using > 0 && deck.every((c) => c.id !== id)) {
          noteCards(
            using === 1
              ? "One runbook step was showing that card and now needs another one. It is marked in the list above."
              : `${using} runbook steps were showing that card and now need another one. They are marked in the list above.`,
          );
        }
      });

      return h(
        "div",
        { class: "a-setup-row hc-edit", attrs: { "data-card": id } },
        [
          h("span", { class: "mono a-setup-pos", text: String(i + 1) }),
          h("div", { class: "a-setup-main" }, [
            h("label", { class: "field-row" }, [
              h("span", { class: "label", text: "Title" }),
              title,
            ]),
            h("label", { class: "field-row" }, [
              h("span", { class: "label", text: "Second line" }),
              line,
            ]),
          ]),
          h("div", { class: "a-setup-acts" }, [
            move("up", -1),
            move("down", 1),
            drop,
          ]),
        ],
      );
    }),
  );
  cardsAdd.disabled = deck.length >= CARD_MAX;
}

cardsAdd.addEventListener("click", () => {
  changeDeck(addCard(deck), CARDS_FULL);
  const added = deck[deck.length - 1];
  if (added !== undefined) {
    focusCardRow(added.id, "title");
    cardsRows.lastElementChild?.scrollIntoView({ block: "nearest" });
  }
});

/* ------------------------------------------------------------------ */
/* The Holding card segment, once the session is running               */
/* ------------------------------------------------------------------ */

/**
 * Every card, with a button each.
 *
 * No typing here: the editor is in the lobby panel, where it is used before
 * anybody is looking. What this panel is for is the other half \u2014 putting one
 * of them up, now, without having to find it in the rail.
 */
const holdingList = h("div", { class: "hc-list" });

/**
 * The "this one is on screen" marks, so `render` can move them. A dot and the
 * word, never the dot alone: nothing on this console is carried by colour.
 */
const holdingMarks = new Map<string, { mark: HTMLElement; word: HTMLElement }>();

const holdingClear = control({
  label: "Clear the card",
  className: "ctl-secondary",
  question: "Take the words off the room's screen?",
  onFire: (c) => {
    lastShownCardId = null;
    issue({ name: "holding", title: "", line: "" }, c);
  },
});

function renderHoldingPanel(): void {
  holdingMarks.clear();
  replace(
    holdingList,
    deck.map((card) => {
      const mark = h("span", {
        class: "mono hc-now",
        text: "\u25cf",
        attrs: { hidden: true },
      });
      const word = h("span", {
        class: "mono hc-onair",
        text: "on screen",
        attrs: { hidden: true },
      });
      holdingMarks.set(card.id, { mark, word });
      const show = control({
        label: "Show it to the room",
        className: "ctl-secondary",
        onFire: (c) => showCard(card, c),
      });
      return h("div", { class: "hc-row" }, [
        h("div", { class: "hc-main" }, [
          h("span", { class: "hc-name" }, [
            h("span", { class: "hc-title", text: cardName(card) }),
            mark,
            word,
          ]),
          h("span", { class: "hc-line", text: card.line.trim() || cardLine(card) }),
        ]),
        show.el,
      ]);
    }),
  );
}

const bodyHolding = h("section", { class: "pb" }, [
  holdingList,
  h("div", { class: "field-actions hc-actions" }, [holdingClear.el]),
  h("p", {
    class: "pb-note",
    text: "The slide the room sits in front of between activities. It goes up when you press its button. The preview on the right is what they see.",
  }),
]);

const standingsRows = h("ol", { class: "h-rows" });
const standingsNote = h("p", { class: "pb-note" });
const bodyStandings = h("section", { class: "pb" }, [standingsRows, standingsNote]);

const bodyPending = h("section", { class: "pb" }, [
  h("p", { class: "pb-note pb-warn" }),
]);

/* ---- the send-off --------------------------------------------------- */

/*
 * The console's half of the send-off, and the only part of it that is not a
 * mirror of what the room can already see.
 *
 * The panel exists for one affordance: the **next** kudo, before the room has
 * it. `SendoffView.next` is populated for the host role and for nobody else —
 * the Desktop is not told, and there is a test on the wire that says so.
 * Kudos are written by people who did not know the room they would be read
 * into, and one of them will be a joke that does not survive being read out
 * at a farewell. A host who can read ahead skips it and nobody in the room
 * ever learns there was something to skip; a host who cannot is finding out
 * at the same moment as the person it is about.
 *
 * Everything else here is position: which phase, which message of how many,
 * and a Back for an overshoot. The advance is the space bar, as it is in
 * every other segment.
 */
const sendoffWhere = h("p", { class: "mono t-head-line so-where" });
const sendoffNextFrom = h("p", { class: "so-next-from" });
const sendoffNextText = h("p", { class: "so-next-text" });
const sendoffNextLabel = h("p", { class: "label so-next-label" });
const sendoffNext = h("section", { class: "so-next" }, [
  sendoffNextLabel,
  sendoffNextFrom,
  sendoffNextText,
]);
const sendoffNote = h("p", { class: "pb-note so-hint" });

/**
 * Auto / Manual, and how fast auto goes.
 *
 * Both modes are wanted inside one segment, which is why this is a button on
 * the console rather than a setting in the file: the photographs play
 * themselves while the host talks over them, and then a message goes up and
 * the room reads it at its own pace. docs/sendoff.md's "the host advances it"
 * is still the default and still what the space bar does — this is the host
 * choosing to hand the photographs over to a clock, and taking them back with
 * one press.
 *
 * The slider is seconds per photograph. A message holds longer than whatever
 * it says, scaled by its length, because a message that leaves the screen
 * mid-sentence is the one failure this segment cannot have — see `slideMs`.
 */
const sendoffAutoControl = control({
  label: "Auto",
  className: "ctl-secondary",
  title:
    "Play the run on a clock. The title card and the closing card still wait for you, and Manual takes it back at any point.",
  onFire: (c) => issue({ name: "sendoff.auto", auto: !(lastState?.sendoff?.auto ?? false) }, c),
});

const sendoffSpeedValue = h("span", { class: "mono so-speed-value" });
const sendoffSpeed = h("input", {
  class: "so-speed",
  attrs: {
    type: "range",
    min: String(MIN_AUTO_SECONDS),
    max: String(MAX_AUTO_SECONDS),
    step: "1",
    "aria-label": "Seconds per photograph",
  },
}) as HTMLInputElement;
const sendoffSpeedRow = h("label", { class: "so-speed-row" }, [
  h("span", { class: "label", text: "Speed" }),
  sendoffSpeed,
  sendoffSpeedValue,
]);

// Dragging updates the number under the thumb; releasing sends it. A command
// per pixel of travel would be a broadcast per pixel of travel.
sendoffSpeed.addEventListener("input", () => {
  setText(sendoffSpeedValue, `${sendoffSpeed.value}s`);
});
sendoffSpeed.addEventListener("change", () => {
  issue({ name: "sendoff.speed", seconds: Number(sendoffSpeed.value) }, null);
  // Handed back deliberately: `spaceVerdict` ignores any key that lands in an
  // input, so a slider still holding focus is a space bar that has stopped
  // advancing the run — which the host would discover in front of the room.
  sendoffSpeed.blur();
});

const sendoffBackControl = control({
  label: "Back",
  className: "ctl-secondary",
  title:
    "One step back: the previous message, or out of the messages into the montage. For an overshoot.",
  onFire: (c) => issue({ name: "sendoff.back" }, c),
});

/**
 * Skip the next message, without the room seeing it.
 *
 * Two `sendoff.next` frames in one press, sent in the same tick. The engine
 * walks one step at a time and this change deliberately does not give it a
 * second way to move — a skip is not a different kind of step, it is two of
 * them — so the room's Desktop does briefly hold the skipped frame between
 * the two broadcasts. In practice that is the round trip of one frame, tens
 * of milliseconds, on a share running at fifteen frames a second.
 *
 * Two-step, and the question names who wrote it. Skipping is silent by
 * design: nothing on any surface says it happened, so nothing would tell a
 * host who pressed it by accident that a message has just gone unread.
 */
const sendoffSkipControl = control({
  label: "Skip the next one",
  className: "ctl-secondary ctl-skip",
  title:
    "Advances twice, so the message above is never put in front of the room. Nobody sees that anything was skipped.",
  question: () => {
    const from = lastState?.sendoff?.next?.from ?? "";
    return from === "" ? "Skip it, unread?" : `Skip ${from}'s message, unread?`;
  },
  onFire: (c) => {
    issue({ name: "sendoff.next" }, c);
    issue({ name: "sendoff.next" }, null);
  },
});

const bodySendoff = h("section", { class: "pb pb-sendoff" }, [
  sendoffWhere,
  sendoffNext,
  h("div", { class: "so-pace" }, [sendoffAutoControl.el, sendoffSpeedRow]),
  h("div", { class: "field-actions" }, [
    sendoffBackControl.el,
    sendoffSkipControl.el,
  ]),
  sendoffNote,
]);

function renderSendoff(s: RenderState): void {
  const so = s.sendoff;
  if (so === undefined) {
    setText(sendoffWhere, "No send-off staged");
    sendoffNext.hidden = true;
    sendoffBackControl.setDisabled(true);
    sendoffSkipControl.setDisabled(true);
    sendoffAutoControl.setDisabled(true);
    sendoffSpeedRow.hidden = true;
    setText(
      sendoffNote,
      "This event has no sendoff.json, so the room is looking at a card that says so. Stage one and reload, or take the step out of the run of show.",
    );
    return;
  }

  // Where the room is. The count is the thing a host is asked out loud —
  // "how many more?" — so it is said in the same words the Desktop uses.
  const part = so.parts > 1 ? ` (${so.part} of ${so.parts})` : "";
  setText(
    sendoffWhere,
    so.phase === "title"
      ? `Farewell card · ${so.total} ${so.total === 1 ? "message" : "messages"} to come`
      : so.phase === "run"
        ? so.kudo !== null
          ? `Message ${so.index} of ${so.total}${part}`
          : `Photograph · ${so.total - so.index} of ${so.total} messages to come`
        : so.phase === "closing"
          ? "Closing card"
          : "Finished",
  );

  // The next message, and only where there is a next: `next` is the first
  // kudo again once the messages are behind the room, which is true and not
  // useful — a closing card with "up next: message one" under it is a console
  // inviting the host to read the whole set a second time.
  const ahead = so.phase === "title" || so.phase === "run" ? (so.next ?? null) : null;
  sendoffNext.hidden = false;
  if (ahead !== null) {
    setText(
      sendoffNextLabel,
      so.phase === "title" ? "First message. Nobody has seen this" : "Next. The room has not seen this",
    );
    setText(sendoffNextFrom, ahead.from);
    setText(sendoffNextText, ahead.message);
    sendoffNextFrom.hidden = false;
    sendoffNextText.hidden = false;
    sendoffNext.classList.remove("is-empty");
    // The long ones step down to the console's body size rather than being
    // scrolled — see `.so-next-text`. A message the host has to scroll to
    // finish is a message they do not finish, and the whole affordance is
    // reading the thing before the room does.
    sendoffNext.classList.toggle("is-long", ahead.message.length > 420);
  } else {
    setText(
      sendoffNextLabel,
      so.phase === "done" ? "Nothing after this" : "Nothing more to read ahead",
    );
    sendoffNextFrom.hidden = true;
    sendoffNextText.hidden = true;
    sendoffNext.classList.add("is-empty");
  }

  // Back out of the title card is the one step the engine has nowhere to take.
  sendoffBackControl.setDisabled(so.phase === "title");
  if (so.phase === "title") sendoffBackControl.disarm();
  sendoffSkipControl.setDisabled(ahead === null);
  if (ahead === null) sendoffSkipControl.disarm();

  // Auto is offered wherever it would do something. On the title card it is
  // armed but idle — the card holds until the host presses, and then the run
  // starts playing itself, which is the shape a host setting up before the
  // room arrives will want.
  sendoffAutoControl.setLabel(so.auto ? "Manual" : "Auto");
  sendoffAutoControl.setDisabled(so.phase === "closing" || so.phase === "done");
  sendoffSpeedRow.hidden = !so.auto;
  if (document.activeElement !== sendoffSpeed) {
    sendoffSpeed.value = String(so.autoSeconds);
    setText(sendoffSpeedValue, `${so.autoSeconds}s`);
  }

  setText(
    sendoffNote,
    so.phase === "title"
      ? "Space starts the run. Nothing moves until you press it. Music only plays if the Desktop tab has had a click in it."
      : so.phase === "run"
        ? so.auto
          ? "Playing itself. Space still steps on early; Manual takes it back. Skip passes one without putting it on the screen."
          : "Space shows the next slide. Read ahead here; Skip advances past a message without putting it on the screen."
        : so.phase === "closing"
          ? "Space finishes the send-off and leaves this frame up."
          : "The send-off is finished. Space moves on to the next step in the run of show.",
  );
}

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
 * The question set, as a statement rather than a control.
 *
 * There used to be a file picker here. It went because the set is a file in
 * the event's own directory and is uploaded once, by the command in that
 * event's runbook, before the room arrives — loading questions is a thing you
 * do at nine in the morning with a terminal open, not a thing you do on the
 * console you are driving in front of thirty people. What the console needs is
 * to say whether a set is loaded, which the Preflight Checklist also says and
 * this repeats where a host looking at Trivia will see it.
 */
const triviaSet = h("p", { class: "pb-note t-set" });

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

const triviaActions = h("div", { class: "field-actions" }, [triviaPractice.el]);

const triviaLoad = h("div", { class: "t-load" }, [
  h("label", { class: "label", text: "Question set" }),
  triviaSet,
]);

const bodyTrivia = h("section", { class: "pb pb-trivia" }, [
  triviaActions,
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
 * somebody clicked a radio would be a round nobody meant to start. The five
 * built rounds are selectable; Gganbu is listed and disabled, so the
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
  recruitment: "Two emoji, one product name. Type it. Six items, nobody is knocked out.",
  plan_apply: "Tap fast while the light is green. Stop the moment it turns. Tapping on red knocks you out.",
  unseal: "Pick a shape, then tap the scrambled letters in order. One wrong tap and you are out.",
  tug_of_raft: "Tug of war. Two teams, one rope. Tap on the beat, and nobody is knocked out.",
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
  unseal: true,
  tug_of_raft: true,
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

/**
 * Whether the round in front of the room is being played as practice, latched
 * while the card is up and while it runs.
 *
 * This is not the same thing as `s.practice` at the reveal, which is what the
 * mark below used to read, and reading it there is the bug a host hits the
 * first time they use practice properly. The engine allows the flag to move at
 * the reveal, and moving it is the very next thing the host does — the whole
 * point of a practice run is the scored run after it. So turning practice off
 * at the reveal re-ran the mark with the flag already cleared, the practice
 * round was struck off the running order at that instant, and the console
 * offered the next game instead of the re-run the host had just asked for.
 *
 * The card and the round decide it, the reveal only reads what was decided.
 * Persisted with the played set, because a console reloaded between the end of
 * a round and its reveal would otherwise come back believing the round it is
 * about to bank was a scored one.
 */
let arcadePractising = false;

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
      title: built ? "" : "Designed, not built yet. You cannot start this one",
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
    text: "At 120 taps about half the room finishes. The light changes every 2 to 6 seconds, and the Desktop warns just before it turns.",
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

/**
 * Unseal's one setting: how long the Floor runs.
 *
 * The nine tins are not a host setting and are not on the wire, for the
 * reason the bridge's eighteen panes are not: an `UnsealItem` carries the
 * word and the reveal note, so a console that could choose them would be a
 * console the answer key travels through.
 */
const arcadeUnsealSeconds = h("input", {
  class: "field field-num",
  type: "number",
  value: "60",
  attrs: { min: "15", max: "300", "aria-label": "Seconds of play" },
}) as HTMLInputElement;

const arcadeUnsealCfg = h("div", { class: "a-cfg" }, [
  h("label", { class: "field-row" }, [
    h("span", { class: "label", text: "Seconds of play" }),
    arcadeUnsealSeconds,
  ]),
  h("p", {
    class: "pb-note",
    text: "Everyone picks a shape first. The shape decides how long their word is, and how much it scores.",
  }),
]);

/**
 * Tug of Raft's three numbers.
 *
 * The **seed is not one of them**. Sides are reshuffled before each pull and
 * the seed is drawn on the server, exactly as Plan / Apply's light durations
 * are: a seed a console could choose is a console that can deal itself the
 * sides.
 */
const arcadeTugPulls = h("input", {
  class: "field field-num",
  type: "number",
  value: "3",
  attrs: { min: "1", max: "9", "aria-label": "Number of pulls" },
}) as HTMLInputElement;
const arcadeTugSeconds = h("input", {
  class: "field field-num",
  type: "number",
  value: "25",
  attrs: { min: "5", max: "120", "aria-label": "Seconds a pull" },
}) as HTMLInputElement;
const arcadeTugBpm = h("input", {
  class: "field field-num",
  type: "number",
  value: "100",
  attrs: { min: "40", max: "200", "aria-label": "Heartbeat, beats per minute" },
}) as HTMLInputElement;

const arcadeTugCfg = h("div", { class: "a-cfg" }, [
  h("div", { class: "a-cfg-row" }, [
    h("label", { class: "a-cfg-cell" }, [
      h("span", { class: "label", text: "Pulls" }),
      arcadeTugPulls,
    ]),
    h("label", { class: "a-cfg-cell" }, [
      h("span", { class: "label", text: "Seconds a pull" }),
      arcadeTugSeconds,
    ]),
    h("label", { class: "a-cfg-cell" }, [
      h("span", { class: "label", text: "Beats a minute" }),
      arcadeTugBpm,
    ]),
  ]),
  h("p", {
    class: "pb-note",
    text: "Two teams pull a rope by tapping on a steady beat; tapping off the beat does nothing. Nobody is knocked out.",
  }),
]);

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
    text: "Six steps, two panes at each. The room crosses in three groups by player number, and each step runs on its own clock. The buttons below cut one short.",
  }),
]);

/* ---- the running order, set before the session ---------------------- */

/** Which settings belong to which round, so the order can carry them. */
const ARCADE_CFG: Readonly<Record<ArcadePick, HTMLElement>> = {
  recruitment: arcadeRecruitCfg,
  plan_apply: arcadePlanCfg,
  unseal: arcadeUnsealCfg,
  tug_of_raft: arcadeTugCfg,
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
  [arcadeUnsealSeconds, "unsealSeconds"],
  [arcadeTugPulls, "tugPulls"],
  [arcadeTugSeconds, "tugPullSeconds"],
  [arcadeTugBpm, "tugBpm"],
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

/**

 * Apply the setup staged with the session, the first time this console opens
 * it.
 *
 * Holding cards, the runbook order and the arcade running order are decided
 * before the room arrives and, until now, lived only in one browser's
 * `localStorage`. Clear your site data, or open the console in a second
 * profile, and the console had forgotten them — which is a poor way to find
 * out at 1:55pm. Staging writes them onto the session; this reads them back.
 *
 * **Once per session id, and then never again.** The first version of this
 * only filled keys that were empty, which sounded safer and did not work: the
 * console writes its own default runbook at startup, so by the time the staged
 * copy arrived the key was occupied by a default nobody had chosen, and the
 * staged order was skipped in favour of it. The rule that does work follows
 * from what the setup *is* — it belongs to the session, so opening a session
 * this console has not seen applies it, and every edit the host makes
 * afterwards is theirs and survives every reload. A host who staged one
 * session and hand-built another does not have the two bleed together.
 *
 * Everything else is unchanged and load-bearing. It writes the raw text and
 * re-runs the existing loaders rather than parsing the staged shape itself, so
 * there is one parser per format and a staged file the loader would reject
 * fails the way a corrupt stored value does — by being ignored. And it cannot
 * fail loudly: no network, no storage, a 401, malformed JSON, an older server
 * with no such endpoint all leave the console exactly as it was without it.
 */
const STAGED_KEYS: Readonly<Record<string, string>> = {
  cards: CARDS_KEY,
  runbook: RUNBOOK_KEY,
  arcade: SETUP_KEY,
};

/** Session ids whose staged setup this browser has already applied. */
const STAGED_SEEN_KEY = "quorum.host.staged.v1";
let stagedAskedFor: string | null = null;

function stagedAlreadyApplied(sid: string): boolean {
  try {
    const raw = localStorage.getItem(STAGED_SEEN_KEY);
    if (raw === null) return false;
    const seen: unknown = JSON.parse(raw);
    return Array.isArray(seen) && seen.includes(sid);
  } catch {
    // Unreadable storage means we cannot prove it was applied. Applying twice
    // to the same session is a smaller harm than never applying at all: the
    // second time round it writes the same bytes.
    return false;
  }
}

function markStagedApplied(sid: string): void {
  try {
    const raw = localStorage.getItem(STAGED_SEEN_KEY);
    const seen: unknown = raw === null ? [] : JSON.parse(raw);
    const list = Array.isArray(seen) ? seen.filter((x) => typeof x === "string") : [];
    if (!list.includes(sid)) list.push(sid);
    // Keep the last few. This list exists to answer one question about the
    // session in front of you, not to be a history.
    localStorage.setItem(STAGED_SEEN_KEY, JSON.stringify(list.slice(-8)));
  } catch {
    /* storage off: the setup still applied, it may simply apply again */
  }
}

function seedStagedSetup(sid: string): void {
  if (stagedAskedFor === sid) return;
  stagedAskedFor = sid;
  if (stagedAlreadyApplied(sid)) return;
  void fetch(`/api/sessions/${encodeURIComponent(sid)}/setup`, {
    headers: { authorization: `Bearer ${hostToken}` },
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((staged: unknown) => {
      if (staged === null || typeof staged !== "object" || Array.isArray(staged)) return;
      let applied = false;
      for (const [name, key] of Object.entries(STAGED_KEYS)) {
        const value = (staged as Record<string, unknown>)[name];
        if (value === undefined || value === null) continue;
        try {
          localStorage.setItem(key, JSON.stringify(value));
          applied = true;
        } catch {
          // Storage off or full. Nothing staged applies, and the console is
          // exactly as usable as it was a moment ago.
          return;
        }
      }
      if (!applied) return;
      markStagedApplied(sid);
      loadDeck();
      loadRunbook();
      loadSetup();
      // The runbook's holding steps name cards by id; a staged pair is already
      // consistent, but a staged runbook with a card the staged deck does not
      // have would leave a step pointing at nothing. Anchor to the first card,
      // which is what a runbook from before named cards gets.
      const first = deck[0];
      if (first !== undefined) runbook = anchorHoldingCards(runbook, first.id);
      // The same five calls the console makes at startup, in the same order.
      // `render` alone is not enough: the setup panels and the rail are built
      // from the deck and the runbook rather than from the session state, so
      // without these the staged cards were in storage and on screen nowhere,
      // which reads exactly like staging having silently failed.
      renderCardsSetup();
      renderHoldingPanel();
      renderArcadeSetup();
      renderRunbookSetup();
      renderRail();
      if (lastState) render(lastState);
    })
    .catch(() => {
      // Offline, or an older server with no such endpoint. Both mean "nothing
      // was staged", which is how the console has always behaved.
    });
}

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
    const o = v as { sid?: unknown; played?: unknown; practising?: unknown };
    if (o.sid !== sid || !Array.isArray(o.played)) return;
    for (const k of o.played as unknown[]) {
      if (typeof k !== "string") continue;
      if (!(ARCADE_PLAYABLE as readonly string[]).includes(k)) continue;
      arcadePlayed.add(k as ArcadePick);
    }
    // Missing in anything written before practice existed, which reads as the
    // round in progress being a scored one — the answer that was always right
    // until there was a flag to be wrong about.
    arcadePractising = o.practising === true;
  } catch {
    // Nothing usable stored. The order starts from the top, which is visible
    // on the button rather than silent.
  }
}

function savePlayed(sid: string): void {
  try {
    localStorage.setItem(
      PLAYED_KEY,
      JSON.stringify({ sid, played: [...arcadePlayed], practising: arcadePractising }),
    );
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
    text: "Set this before you start. Once the session is running, the main button announces these rounds in order.",
  }),
  arcadeSetupRows,
  arcadeSetupNote,
  h("p", {
    class: "pb-note",
    text: "Gganbu is designed but not built, so it is not in the order.",
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
            ? "Keep at least one round. The arcade has to have something to announce."
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
    text: "Pick a round here to run it next instead of the one in the order. Use it to skip ahead or to run one again.",
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
    "The Glass Bridge only. Ends the current step: anyone who has not picked is out, the broken pane shows, the next step opens. The clock does this anyway.",
  onFire: (c) => issue({ name: "arcade.nextStep" }, c),
});
const arcadeNextWave = control({
  label: "Send the next wave",
  className: "ctl-secondary",
  title:
    "The Glass Bridge only. Ends this group's step and sends the next group onto the bridge. Use it when everyone still going is out.",
  onFire: (c) => issue({ name: "arcade.nextWave" }, c),
});

const arcadeNextPull = control({
  label: "Start the next pull",
  className: "ctl-secondary",
  title:
    "Tug of Raft only. Ends this pull, pays the winning side, reshuffles the teams and starts the next one. The clock does this anyway.",
  onFire: (c) => issue({ name: "arcade.nextPull" }, c),
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
    arcadePractice.el,
    arcadeEnd.el,
    arcadeNext.el,
    arcadeNextPull.el,
    arcadeNextStep.el,
    arcadeNextWave.el,
  ]),
  h("p", {
    class: "label",
    text: "Backing: players who are out pick someone to root for",
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
  if (pick === "unseal") {
    return {
      name: "arcade.round",
      kind: "unseal",
      seconds: int(arcadeUnsealSeconds, 60),
    };
  }
  if (pick === "tug_of_raft") {
    return {
      name: "arcade.round",
      kind: "tug_of_raft",
      pulls: int(arcadeTugPulls, 3),
      pullSeconds: int(arcadeTugSeconds, 25),
      bpm: int(arcadeTugBpm, 100),
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
  //
  // Unless it was practice, when revealing puts nothing on the board — the
  // sentence above is the whole reason, and in practice it is false. A
  // practice round that counted as played left the room having learned the
  // game and the console refusing to offer it again, which is the opposite of
  // the point.
  //
  // The flag the *round* was played under, latched while it was still the
  // round's to decide, and not the flag as it stands right now: see
  // `arcadePractising`.
  if (a !== undefined && (a.phase === "card" || a.phase === "running")) {
    if (arcadePractising !== s.practice) {
      arcadePractising = s.practice;
      savePlayed(s.sid);
    }
  }
  if (
    a !== undefined &&
    a.phase === "reveal" &&
    a.round !== null &&
    !arcadePractising &&
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
    arcadeNextPull.setDisabled(true);
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
  const un = a.unseal;
  const tu = a.tug;
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
      `Item ${r.at + 1} of ${r.of}${itemLeft === null ? "" : ` · ${formatCountdown(itemLeft)}`} · ${r.cue ?? ""} → ${r.answer ?? "?"}  (${r.solved ?? 0} solved, ${r.answered ?? 0} of ${r.eligible ?? 0} answered)`,
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
          ? "GREEN (PLAN): taps count"
          : "RED (APPLY): tapping knocks you out",
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
  } else if (un) {
    // The console is the one surface that may hold the words while the round
    // is running, because the host is the one who reads them out at the
    // reveal — the same rule Recruitment's answer and the bridge's key
    // follow, and for the same reason: it is the only surface in the
    // building that is not in the room.
    const unsealLeft = remainingMs(a.endsAt, client?.now() ?? Date.now());
    setText(
      arcadeItem,
      [
        `${un.unsealed} of ${un.picked} tins open`,
        unsealLeft === null ? null : formatCountdown(unsealLeft),
        ...un.shapes
          .filter((sh) => sh.available)
          .map(
            (sh) =>
              `${UNSEAL_FACE[sh.shape].glyph} ${sh.unsealed}/${sh.picked}${
                sh.fastest === undefined ? "" : ` fastest ${playerTag(sh.fastest)}`
              }`,
          ),
      ]
        .filter((x) => x !== null)
        .join(" · "),
    );
    // Who read the docs, which is the one thing the host can see and nobody
    // else can — the phone says "Nobody will know", and on every surface but
    // this one that is true.
    const readers = un.docs ?? [];
    arcadeNote.hidden = false;
    setText(
      arcadeNote,
      [
        un.recap === undefined
          ? ""
          : `Words: ${un.recap.map((t) => t.answer).join(" · ")}`,
        readers.length === 0
          ? "Nobody has read the docs."
          : `Read the docs: ${readers.map((n) => playerTag(n)).join(" ")} — scores halved.`,
      ]
        .filter((x) => x !== "")
        .join("  |  "),
    );
  } else if (tu) {
    const pullLeft = remainingMs(tu.pullEndsAt ?? null, client?.now() ?? Date.now());
    const leaders = tu.leaders ?? [null, null];
    setText(
      arcadeItem,
      [
        `PULL ${tu.pull + 1} OF ${tu.pulls}`,
        `${Math.round(60_000 / tu.beatMs)} bpm`,
        pullLeft === null ? null : formatCountdown(pullLeft),
        `rope ${tu.totals[0]}–${tu.totals[1]}`,
        `pulls won ${tu.wins[0]}–${tu.wins[1]}`,
      ]
        .filter((x) => x !== null)
        .join(" · "),
    );
    arcadeNote.hidden = false;
    setText(
      arcadeNote,
      // The leaders are the +5 a side, win or lose, and the host reads them
      // out at the end of each pull. Nobody drains in this round, so the
      // Floor/Lounge split below stays where it was — which is the one thing
      // a host new to this round will ask about.
      `Leaders: A ${leaders[0] === null ? "—" : playerTag(leaders[0])} · B ${
        leaders[1] === null ? "—" : playerTag(leaders[1])
      }. Nobody is knocked out in this round.`,
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
  // "Start the next pull" is refused on the last pull — there is no next one
  // — and says so by being unpressable rather than by being pressed.
  const tugging = a.phase === "running" && a.round === "tug_of_raft";
  const tg = a.tug;
  arcadeNextPull.setDisabled(
    !tugging || tg === undefined || tg.pull + 1 >= tg.pulls,
  );
}

const bodies: Record<string, HTMLElement> = {
  lobby: bodyLobby,
  holding: bodyHolding,
  standings: bodyStandings,
  final: bodyStandings,
  trivia: bodyTrivia,
  arcade: bodyArcade,
  sendoff: bodySendoff,
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

/** What the button says about arriving at each segment. Unchanged wording. */
const SEGMENT_ADVANCE_LABEL: Readonly<Record<Segment, string>> = {
  lobby: "Show the lobby",
  holding: "Show the holding card",
  sendoff: "Start the send-off",
  trivia: "Open trivia",
  arcade: "Open the arcade",
  standings: "Show standings",
  final: "Show the final",
};

/**
 * What the primary button says, and what it does when it is pressed.
 *
 * It carries a function rather than a command because arriving at a holding
 * step is two commands — the card, then the segment — and because the
 * console has a cursor to move as well. One press, one plan, whatever it
 * takes underneath.
 */
interface Plan {
  readonly label: string;
  /** `null` is a button with nothing to do, which the label says in words. */
  readonly fire: ((c: Control) => void) | null;
}

function cmdPlan(label: string, cmd: HostCommand): Plan {
  return { label, fire: (c) => issue(cmd, c) };
}

/**
 * The next step in the host's runbook, as a button label and a press.
 *
 * This is the one place the run of show is read, and it is read out of the
 * runbook rather than out of a constant — so a host who took trivia out, or
 * put the standings before the arcade, gets a space bar that agrees with the
 * plan they wrote. `null` is the end of the runbook, which the button says in
 * words rather than by doing nothing.
 *
 * A holding step is named by the card it shows, so the button reads "Show
 * Coffee break" rather than "Show the holding card" — which is the whole
 * reason the cards have names. A step whose card has been deleted keeps the
 * generic wording: it still walks, and what it puts up is the standby card.
 */
function advanceFrom(from: string | null): Plan {
  const next = nextEntryAfter(runbook, from);
  if (next === null) return { label: "Nothing queued", fire: null };
  const card = next.kind === "holding" ? cardForEntry(next) : null;
  const named = card !== null && card.title.trim() !== "";
  return {
    label: named ? `Show ${cardName(card)}` : SEGMENT_ADVANCE_LABEL[next.kind],
    fire: (c) => goToEntry(next, c),
  };
}

/** Where the space bar walks from, for a session that is already running. */
function advanceFromHere(s: RenderState): Plan {
  return advanceFrom(currentEntry(s)?.id ?? null);
}

/**
 * The next round in the order the host set during setup — or, when they have
 * all been played, the next thing in the runbook. The button never says
 * "choose something": the choosing was done before the room arrived.
 */
function announceNext(s: RenderState): Plan {
  const pick = currentPick();
  if (pick === null) return advanceFromHere(s);
  return cmdPlan(`Announce ${ARCADE_ROUND_LABEL[pick]}`, arcadeRoundCommand(pick));
}

function primaryPlan(): Plan {
  const s = lastState;
  if (s === null) return { label: "Connecting", fire: null };
  if (s.phase === "closed") return { label: "Session closed", fire: null };
  // draft -> lobby -> running is two presses, and the button says which.
  if (s.phase === "draft") {
    return cmdPlan("Open the lobby", { name: "open" });
  }
  if (s.phase === "lobby") {
    return cmdPlan("Start the session", { name: "start" });
  }
  // Inside trivia the primary button walks the question rather than the run of
  // show: open, close, reveal, next. That is the whole activity on the space
  // bar, which is what the host is holding while they read the question out.
  if (s.segment === "trivia" && s.trivia !== undefined) {
    const t = s.trivia;
    switch (t.phase) {
      case "idle":
        return cmdPlan(
          `Open ${questionLabel(t)}${suddenDeathArmed ? " · sudden death" : ""}`,
          { name: "trivia.open", suddenDeath: suddenDeathArmed },
        );
      case "open":
        return cmdPlan("Close the question", { name: "trivia.close" });
      case "closed":
        return cmdPlan("Reveal the answer", { name: "trivia.reveal" });
      case "revealed":
        return t.index + 1 < t.of
          ? cmdPlan("Next question", { name: "trivia.next" })
          : advanceFromHere(s);
    }
  }
  // Inside the send-off the primary button walks the send-off: the Farewell
  // card, then the run of photographs and messages a slide at a time, then
  // the closing card. Same key as every other segment, which is the decision
  // the design note calls the most important one in it — an auto-advancing
  // montage walks past the message that makes the room go quiet, with the
  // person it is about sitting there watching it happen. Auto exists for the
  // photographs and hands the key straight back: space steps on early from
  // inside it, and the two cards at either end never move on their own.
  if (s.segment === "sendoff") {
    const so = s.sendoff;
    // No send-off staged. The space bar goes back to walking the runbook
    // rather than pressing a button that can only be refused.
    if (so === undefined) return advanceFromHere(s);
    switch (so.phase) {
      case "title":
        return cmdPlan(so.total > 0 ? "Start the send-off" : "Finish the send-off", {
          name: "sendoff.next",
        });
      case "run":
        return cmdPlan(
          so.parts > 1 && so.part < so.parts
            ? `Continue message ${so.index}`
            : so.index < so.total
              ? `Next — message ${so.index + 1} of ${so.total}`
              : "End the run",
          { name: "sendoff.next" },
        );
      case "closing":
        return cmdPlan("Finish the send-off", { name: "sendoff.next" });
      case "done":
        // A resting frame, and the run of show carries on from here.
        return advanceFromHere(s);
    }
  }
  // Inside the arcade the primary button walks the round the same way it
  // walks a question: enter, card, Floor, end, reveal. One activity, one key.
  if (s.segment === "arcade") {
    const a = s.arcade;
    if (a === undefined) {
      return cmdPlan("Enter the arcade", { name: "arcade.enter" });
    }
    switch (a.phase) {
      case "card":
        return cmdPlan("Start the round", { name: "arcade.begin" });
      case "running":
        return cmdPlan("End the round", { name: "arcade.end" });
      case "idle":
        // A round that has been played and not revealed. Revealing it is what
        // puts the points on the board, so it is never skipped by accident.
        if (a.round !== null) {
          return cmdPlan(`Show the results — ${ARCADE_ROUND_LABEL[a.round]}`, {
            name: "arcade.reveal",
          });
        }
        return announceNext(s);
      case "reveal":
        return announceNext(s);
    }
  }

  return advanceFromHere(s);
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

function render(s: RenderState): void {
  lastState = s;
  loadPlayed(s.sid);
  seedStagedSetup(s.sid);
  loadAt(s.sid);
  forgetPlayedIfStartingOver(s);

  // Where the console thinks it is, checked against where the room is. The
  // cursor is the only thing that can tell two holding steps apart, and a
  // cursor left pointing at a step that has gone, or at a segment the room
  // has left, would put the space bar on the wrong row.
  const here = currentEntry(s);
  if (here !== null && here.id !== atId) {
    atId = here.id;
    saveAt();
  }
  // Which card is in front of the room, so the Holding panel can mark it and
  // so SHIFT+H after a reload reaches for the right one.
  const upNow = cardMatching(deck, s.holding?.title, s.holding?.line);
  if (upNow !== null) lastShownCardId = upNow.id;

  /* status bar */
  setText(elTitle, s.title);
  const code = s.hostExtras?.joinCode ?? "————";
  setText(elScoreboard, SCOREBOARD_STATE[s.seal]);
  setAttr(elScoreboard, "data-seal", s.seal);
  // Hidden is loud: the whole bar carries it, so the host never has to wonder
  // whether the room can see the scoreboard.
  statusBar.classList.toggle("sealed", s.seal === "sealed");

  /* rail — the mark sits on the *step* the console is on, which is the only
     row that can be right when two of them are holding cards */
  for (const [id, row] of railRows) {
    const current = here !== null && here.id === id;
    row.button.classList.toggle("current", current);
    setText(row.mark, current ? "●" : "○");
    row.button.disabled = s.phase !== "running";
  }
  setText(railCount, `${s.roster.length}`);
  roster.update(s.roster);

  /* always-there controls */
  lockControl.setLabel(s.joinsLocked ? "Unlock joining" : "Lock joining");
  lockControl.el.classList.toggle("on", s.joinsLocked);
  for (const c of practiceControls) {
    c.setLabel(`Practice: ${s.practice ? "on" : "off"}`);
    c.el.classList.toggle("on", s.practice);
    // The engine refuses to change it under a live question or a running
    // round, so the button says so by being unpressable rather than by being
    // refused. The round card is not live: it is the briefing, and it is the
    // moment the host decides to practise this one, so the button is pressable
    // there.
    c.setDisabled(
      (s.trivia !== undefined && s.trivia.phase !== "idle" && s.trivia.phase !== "revealed") ||
        (s.arcade !== undefined && s.arcade.phase === "running"),
    );
  }
  sealControl.setLabel(
    s.seal === "live" ? "Hide the scoreboard" : "Reveal the winners, 5 to 1",
  );
  sealControl.setDisabled(s.seal === "revealed");
  unsealControl.el.hidden = s.seal === "live";
  closeControl.setDisabled(s.phase === "closed" || s.phase === "draft");
  // There is nothing to reopen unless it is shut, and a permanently greyed
  // button is a button the eye stops reading.
  reopenControl.el.hidden = s.phase !== "closed";
  if (s.phase !== "closed") reopenControl.disarm();

  /* starting over — armable in every phase the session has actually run in,
     including closed, which is the phase a host most often wants it from */
  restartArm.disabled = s.phase === "draft";
  if (s.phase === "draft" && restartArmed) setRestartArmed(false);
  syncRestartGo();
  // What it does, and nothing about what it spares. The long version listed
  // everything that survives — the room, the code, the questions — which read
  // as reassurance at the exact moment a host should be reading the warning.
  setText(restartKeeps, "Clears every score. Nobody has to rejoin.");

  /* panel */
  const bodyKey = s.phase === "draft" ? "lobby" : s.segment;
  const body = bodies[bodyKey] ?? bodyLobby;
  if (panelBody.firstElementChild !== body) replace(panelBody, [body]);
  // The status, and not the segment's name with it.
  //
  // The head used to read `LOBBY · not open yet`, and the rail two inches to
  // the left already read `● Lobby`. The name was the same word twice on one
  // screen, in every segment — and with holding cards named after the
  // activity they hold, the two halves had started to disagree about what to
  // call the same thing. The status half is the part nothing else says.
  //
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

  if (body === bodyHolding) {
    // Which card the room is looking at, said with a dot and a word. Worked
    // out from the two strings on the wire, because that is all the engine
    // holds — and a card the host edited after showing it stops matching,
    // which is honest: those are not the words on the screen any more.
    for (const [id, pair] of holdingMarks) {
      const now = upNow !== null && upNow.id === id;
      pair.mark.hidden = !now;
      pair.word.hidden = !now;
    }
    holdingClear.setDisabled(
      (s.holding?.title ?? "") === "" && (s.holding?.line ?? "") === "",
    );
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

  if (body === bodySendoff) renderSendoff(s);

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
  placeHolding(s);

  /* primary */
  const plan = primaryPlan();
  primary.setLabel(plan.label);
  primary.setDisabled(plan.fire === null);
  placePrimary();
  // Said by name, because the button saying it is in the other column.
  setText(
    footNote,
    `Not started yet. Space presses \u201c${plan.label}\u201d \u2014 it is the green button at the top of Session controls, on the right.`,
  );

  /* preview — what the room sees, not what the console sees */
  preview.update(roomView(s), null);

  /* driving mode, when it is on. The console above is rendered either way. */
  if (driving) renderDriving(s);
}

/**
 * A session in a lobby with no arcade register has not played an arcade round,
 * whatever this browser remembers.
 *
 * Which rounds have been played is kept in `localStorage`, so that a console
 * reloaded in the middle of the afternoon comes back offering the right one.
 * That memory is per *session id*, and a restart keeps the session id — so
 * without this, a host who does a dry run in the morning and then wipes it
 * finds the button offering round three of three to a room that has played
 * nothing. It is the exact workflow the wipe exists for.
 *
 * The condition is exact rather than a guess at "was that a restart": the
 * session is back in `lobby`, and `arcade` is absent, which together are only
 * true before the arcade has ever been entered — at the top of a session, and
 * after a restart. Once `enterArcade` has happened `arcade` is present for the
 * rest of the session, so this cannot fire mid-afternoon and hand the host
 * back a round they have already run.
 */
function forgetPlayedIfStartingOver(s: RenderState): void {
  if (s.phase !== "lobby" || s.arcade !== undefined) return;
  if (arcadePlayed.size === 0 && arcadeOverride === null && !arcadePractising) return;
  arcadePlayed.clear();
  arcadeOverride = null;
  // A restart turns practice off in the engine, so a latch left on would be a
  // stale answer to a question nobody has asked yet.
  arcadePractising = false;
  savePlayed(s.sid);
}

/**
 * The checklist, filled in. Four things, three of which the console can see
 * for itself.
 */
function renderPreflight(s: RenderState): void {
  const setup = s.phase === "draft" || s.phase === "lobby";
  preflight.hidden = !setup;
  // The runbook is set before the room arrives, for the same reason the
  // arcade's running order is: it is knowable at 9am, and a run of show that
  // can be rewritten mid-session is a run of show that gets rewritten by
  // accident. The rail is still the way to deviate once the session is live.
  runbookSetup.hidden = !setup;
  // Setup gets the whole panel; see `.panel.is-setup` in host.css.
  panel.classList.toggle("is-setup", setup);
  if (!setup) return;

  /* The holding steps, and whether each of them has a card to show. This is
     the one thing on the list the console can be certain about, and it is the
     one a host can break from the editor above by deleting a card two steps
     were using. */
  const steps = holdingSteps(runbook).filter((e) => e.included);
  const dangling = steps.filter((e) => cardForEntry(e) === null);
  const blank = steps.filter((e) => {
    const card = cardForEntry(e);
    return card !== null && card.title.trim() === "" && card.line.trim() === "";
  });
  if (dangling.length > 0) {
    pfCards.set(
      "not",
      dangling.length === 1
        ? "One step in the runbook shows a card that has been deleted. Pick another card for it on its row, or take the step out. Until you do it shows \u201cBack shortly\u201d."
        : `${dangling.length} steps in the runbook show a card that has been deleted. Pick another card for each on its row, or take them out. Until you do they show \u201cBack shortly\u201d.`,
    );
  } else if (steps.length === 0) {
    pfCards.set(
      "ready",
      "No holding step in the runbook. SHIFT+H still puts a card up whenever you need one.",
    );
  } else if (blank.length === steps.length) {
    pfCards.set(
      "ask",
      "Nothing written on the holding card yet. It will show \u201cBack shortly\u201d, which works but is not what the room is there for.",
    );
  } else {
    const names = steps.map((e) => entryFullName(e)).join(", ");
    pfCards.set(
      "ready",
      steps.length === 1
        ? `Holding card: ${names}.`
        : `${steps.length} holding steps: ${names}.`,
    );
  }

  const loaded = s.hostExtras?.trivia?.loaded ?? 0;
  pfQuestions.set(
    loaded > 0 ? "ready" : "not",
    loaded > 0
      ? `${loaded} trivia question${loaded === 1 ? "" : "s"} loaded.`
      : "No trivia questions loaded. Upload the event's trivia-questions.json, using the command in its runbook, or trivia opens empty in front of the room.",
  );

  const order = planIncluded(arcadePlan);
  pfArcade.set(
    order.length > 0 ? "ready" : "not",
    order.length > 0
      ? `Arcade rounds: ${planSummary(arcadePlan, ARCADE_ROUND_LABEL)}.`
      : "No arcade rounds chosen.",
  );

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
 * The card editor is a setup block, like the runbook and the arcade's running
 * order, and it hides itself the same way they do.
 *
 * The lobby panel is also what a *running* session shows while the segment is
 * the lobby, which is why this is a phase test and not a panel test: a host
 * who walks back to the lobby mid-afternoon must not find the card editor
 * there, because editing a card at that point is editing something thirty
 * people may be looking at in a minute.
 */
function placeHolding(s: RenderState): void {
  cardsSetup.hidden = !(s.phase === "draft" || s.phase === "lobby");
}

/**
 * Where the one primary button is mounted right now.
 *
 * Three homes and one button, in priority order:
 *
 *   driving mode    the whole console is put away, so it goes with the host
 *   draft / lobby   the control panel's Session group: the next thing to
 *                   press is Open the lobby, then Start the session, and
 *                   both are lifecycle rather than run of show
 *   running         the panel foot, where the run of show is driven from
 *
 * Moved, never copied, for the reason driving mode gives: two copies of the
 * most important string in the product is one copy that can be wrong, and a
 * refusal has to land in the button the host is looking at. The space bar is
 * unaffected — `bindSpace` holds the {@link Control}, not its parent — so
 * space still starts the session from anywhere on the page, and `spaceVerdict`
 * is untouched, which is what keeps the wipe off the space bar.
 */
function placePrimary(): void {
  const phase = lastState?.phase;
  const home = driving
    ? dvPrimary
    : phase === "draft" || phase === "lobby"
      ? cpLifecycle
      : panelFoot;
  if (primary.el.parentElement !== home) {
    home.appendChild(primary.el);
    // The button just moved out from under the cursor; space must still work.
    releaseFocus();
  }
  const borrowed = primary.el.parentElement === cpLifecycle;
  cpLifecycle.hidden = !borrowed;
  footNote.hidden = !borrowed;
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
  if (s.phase === "running") {
    if (s.segment === "trivia" && s.trivia !== undefined) {
      return triviaHead.textContent ?? "";
    }
    if (s.segment === "arcade" && s.arcade !== undefined) {
      return arcadeState.textContent ?? "";
    }
  }
  // Named by the step, not by the segment: a host in driving mode during the
  // TTX should read AGENTIC SECURITY TTX, which is what the room is looking
  // at, rather than HOLDING CARD, which is what the console calls it.
  const here = currentEntry(s);
  const name = here === null ? SEGMENT_LABEL[s.segment] : entryFullName(here);
  return `${name.toUpperCase()} · ${s.phase.toUpperCase()}`;
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
  const loaded = s.hostExtras?.trivia?.loaded ?? 0;
  setText(
    triviaSet,
    loaded > 0
      ? `${loaded} question${loaded === 1 ? "" : "s"} loaded, from this event's trivia-questions.json.`
      : "Nothing loaded. Upload the event's trivia-questions.json, using the command in its runbook.",
  );
  if (t === undefined) {
    setText(triviaHead, "NO QUESTIONS LOADED");
    setText(
      triviaQuestion,
      "This session has no questions. Upload the event's trivia-questions.json before you open trivia. The command is in that event's runbook.",
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
  const { hostExtras: _hostExtras, own: _own, trivia, arcade, sendoff, ...rest } = s;
  // The send-off's `next` is the host's alone — the whole point of the panel
  // — and the preview is a picture of a phone. Removed rather than blanked,
  // so the preview is fed the shape a participant actually gets.
  let roomSendoff: SendoffView | undefined;
  if (sendoff !== undefined) {
    const { next: _next, ...shared } = sendoff;
    roomSendoff = shared;
  }
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
    ...(roomSendoff !== undefined ? { sendoff: roomSendoff } : {}),
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
 * A holding card, in one key — and *which* one, now that there are several.
 *
 * Recovery used to be three actions at the moment a host least wants three:
 * switch to Holding, type a title, type a line, press the button. It is one
 * key, and with a deck of cards behind it the only new question is which card
 * the key reaches for. In order:
 *
 *   1. **the card for the step the host is standing on.** If the cursor is on
 *      a holding step, that step's card is by definition the one that belongs
 *      here. Walking into the coffee break and pressing SHIFT+H has to put
 *      the coffee break up, not whatever was up before it.
 *   2. **the one most recently shown.** Anywhere else — mid-trivia, mid-round
 *      — SHIFT+H is the rescue key, not a navigation key: something has gone
 *      wrong and the room needs to be looking at something other than this.
 *      The right answer there is the card they were just on, which is also
 *      exactly what this key did when there was only one card.
 *   3. **the first card**, for a console that has shown nothing yet.
 *   4. **the standby card**, for a deck with nothing written in it at all.
 *
 * Step 2 survives a reload: `render` recognises the card the room is looking
 * at by its two strings and picks the deck back up from there.
 *
 * Shift is deliberate. A bare letter is a key a hand resting on a laptop can
 * find by accident, and this one puts a new slide in front of thirty people.
 * H for holding: it collides with nothing — space advances, G is the scoring
 * grid, Escape disarms — and it is printed in the rail and in driving mode,
 * because a host will not guess a shortcut.
 */
function showHoldingNow(): void {
  const s = lastState;
  if (s === null) return;
  if (s.phase !== "running") {
    primary.flash("nothing is in front of the room yet");
    return;
  }
  const here = currentEntry(s);
  const card =
    (here !== null && here.kind === "holding" ? cardForEntry(here) : null) ??
    cardById(deck, lastShownCardId) ??
    deck[0] ??
    null;
  showCard(card, primary);
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
  // Driving mode hides the whole console, and a half-armed wipe that is
  // off-screen is a half-armed wipe nobody can see to cancel.
  setRestartArmed(false);
  document.body.classList.toggle("driving", on);
  // The control panel's own copy of the toggle. Off-screen while driving mode
  // is on — the tray is hidden with the rest of the console — but it has to be
  // right the moment the host comes back to it.
  setAttr(cpDriving, "aria-pressed", on ? "true" : "false");
  cpDriving.classList.toggle("on", on);
  drivingView.hidden = !on;
  placePrimary();
  // The button may have moved out from under the cursor; space must still work.
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
renderCardsSetup();
renderHoldingPanel();
renderArcadeSetup();
renderRunbookSetup();
renderRail();

bindSpace(primary);
bindEscape(() => [
  sendoffBackControl,
  sendoffSkipControl,
  lockControl,
  arcadePractice,
  triviaPractice,
  sealControl,
  unsealControl,
  reopenControl,
  closeControl,
  primary,
]);

/**
 * Escape abandons the wipe too.
 *
 * `bindEscape` only knows about {@link Control}s, and the restart panel is
 * deliberately not one — it has a text field in it. Its own listener, so the
 * promise the rail makes ("ESC cancel") is true of every half-pressed thing on
 * this page and not only of the ones that happen to be controls. It fires
 * whatever has focus, including the field itself.
 */
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  setRestartArmed(false);
});

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

client.start();
