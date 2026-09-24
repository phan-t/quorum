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
  TRAY_MAX,
  TRAY_MIN,
  clampTray,
  defaultRunbook,
  dropRunbook,
  isLastIncludedSegment,
  moveRunbook,
  nextInRunbook,
  parseRunbook,
  parseTrayWidth,
  runbookIncluded,
  runbookRail,
  toggleRunbook,
  type Runbook,
} from "./runbook.ts";
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

/**
 * Four things and a switch.
 *
 * The bar used to open with a red DO NOT SHARE chip and then the join code.
 * Both are gone from here and neither is lost. The warning is in the tab
 * title, which is the one place it does any work — the screen-share picker
 * lists tab titles, and a title is legible while the console is behind
 * another window, which a bar inside it is not. The join code is in the lobby
 * panel beside the join link, with a copy button on each, which is where a
 * host gets at it. What is left is what the bar is for: whose session, who is in it,
 * what phase it is in, and whether the room can see the scores.
 */
const statusBar = h("header", { class: "statusbar" }, [
  elTitle,
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
    h("p", { class: "label", text: "Runbook" }),
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
const panelFoot = h("div", { class: "panel-foot" }, [primary.el]);

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
    title: "Drag to resize the preview \u2014 or focus it and use \u2190 \u2192",
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
    "Puts the session back to running with every score intact. The segment and the scoreboard stay where the close left them; move them with the rail and the scoreboard button.",
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
 *   1. press **Start the session over…**, which only opens a panel;
 *   2. **type the word** into a field — the console will not accept anything
 *      else, and a field is the one widget on this page that a stray keypress
 *      cannot turn into an action;
 *   3. press **Wipe the scores and start over**, which is disabled until the
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
    text: "Start the session over…",
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
  text: "Wipe the scores and start over",
  disabled: true,
}) as HTMLButtonElement;

const restartCancel = handsBackSpace(
  h("button", { class: "rs-cancel", type: "button", text: "Cancel" }),
) as HTMLButtonElement;

const restartPanel = h(
  "section",
  { class: "rs-panel", attrs: { id: "restart-panel", hidden: true } },
  [
    h("p", { class: "label rs-label", text: "Start the session over" }),
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
  setText(restartArm, on ? "Never mind" : "Start the session over…");
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
    primary.flash("not connected — nothing was changed");
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
 *   Session     lock and unlock joining, close, reopen, and the wipe
 *   Scoreboard  hide it, show it again, run the 5-to-1 reveal
 *   Shortcuts   the three keys, as buttons, each labelled with its key
 *
 * The keys are unchanged and every one of them still works from everywhere it
 * worked before; the rail still prints the whole list. These buttons are a
 * second path to three of them, and the key on the face of each is the point:
 * a host who presses "Driving mode SHIFT+D" twice has learned SHIFT+D.
 *
 * The two that cannot be undone are not merely moved, they are walled off —
 * their own bordered block, in the danger colour, under a heading that says
 * so. Close session and Start the session over… must not read as the same
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

try {
  runbook = parseRunbook(localStorage.getItem(RUNBOOK_KEY)) ?? defaultRunbook();
} catch {
  // Storage off, or blocked. The default runbook is the shipped run of show.
}

function saveRunbook(): void {
  try {
    localStorage.setItem(RUNBOOK_KEY, JSON.stringify(runbook));
  } catch {
    // See above: it still works, it just will not survive a reload, and
    // nothing about that is worth an error in front of a room.
  }
}

const segmentRows = new Map<
  Segment,
  { li: HTMLLIElement; button: HTMLButtonElement; tag: HTMLElement }
>();
for (const seg of SEGMENTS) {
  const tag = h("span", { class: "seg-phase mono", attrs: { hidden: true } });
  const button = h("button", { class: "seg", type: "button" }, [
    h("span", { class: "seg-mark", text: "○" }),
    h("span", { class: "seg-name", text: SEGMENT_LABEL[seg] }),
    SEGMENT_BUILT[seg]
      ? tag
      : h("span", { class: "seg-phase mono", text: `P${SEGMENT_PHASE[seg]}` }),
  ]);
  handsBackSpace(button);
  button.addEventListener("click", () => issue({ name: "segment", kind: seg }, null));
  const li = h("li", {}, [button]);
  railSegments.appendChild(li);
  segmentRows.set(seg, { li, button, tag });
}

/**
 * The rail, in the host's order.
 *
 * Every segment is listed, including the ones taken out of the runbook —
 * marked, and still one click away. Out of the runbook means "not on the
 * space bar", never "not at all": the rail is also the way off the plan when
 * the room runs long, and a console that could not jump to trivia because
 * trivia was not in the plan would be a console that had lost a feature at
 * 2:45pm. The rows are moved rather than rebuilt, so nothing the host is
 * pointing at changes identity underneath them.
 */
function renderRail(): void {
  for (const entry of runbookRail(runbook)) {
    const row = segmentRows.get(entry.kind);
    if (row === undefined) continue;
    railSegments.appendChild(row.li);
    row.button.classList.toggle("is-out", !entry.included);
    row.tag.hidden = entry.included;
    setText(row.tag, entry.included ? "" : "out");
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

function copyButton(what: string, source: HTMLElement): HTMLButtonElement {
  const button = handsBackSpace(
    h("button", {
      class: "copy-btn",
      type: "button",
      text: "Copy",
      attrs: { "aria-label": `Copy the ${what}` },
    }),
  ) as HTMLButtonElement;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const say = (word: string, ok: boolean): void => {
    setText(button, word);
    button.classList.toggle("is-done", ok);
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      setText(button, "Copy");
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
      say(ok ? "Copied" : "Select it, then ⌘C", ok);
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
const runbookRows = h("div", { class: "a-setup-rows" });
const runbookNote = h("p", { class: "pb-note a-setup-note", attrs: { hidden: true } });

const runbookSetup = h("section", { class: "a-setup" }, [
  h("p", { class: "label", text: "Runbook" }),
  h("p", {
    class: "pb-note",
    text: "Set this before you start. The main button walks these in this order, and it always says which one is next. Anything you take out stays in the rail on the left and is still one click away, so you can go there by hand if the afternoon changes shape.",
  }),
  runbookRows,
  runbookNote,
  h("p", {
    class: "pb-note",
    text: "Move a row with its arrow buttons, or with Alt+\u2191 and Alt+\u2193 from anywhere in the row \u2014 or drag it. The lobby and the final are fixed: the session opens in one and ends in the other.",
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
  readonly kind: Segment;
  readonly role: string;
}

function focusRunbookRow(want: RunbookFocus): void {
  const row = runbookRows.querySelector(`[data-kind="${want.kind}"]`);
  if (!(row instanceof HTMLElement)) return;
  const exact = row.querySelector(`button[data-role="${want.role}"]`);
  if (exact instanceof HTMLButtonElement && !exact.disabled) {
    exact.focus();
    return;
  }
  // The control it was on is disabled now — it moved to an end. Anything in
  // the same row beats losing the cursor to the top of the document.
  const any = Array.from(row.querySelectorAll("button")).find((b) => !b.disabled);
  any?.focus();
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

/** The row being dragged, for the pointer path. */
let runbookDrag: Segment | null = null;

const RUNBOOK_FULL =
  "Keep at least one segment \u2014 the runbook has to have something between the lobby and the final.";

function renderRunbookSetup(): void {
  const included = runbookIncluded(runbook);
  replace(
    runbookRows,
    runbook.map((entry, i) => {
      const kind = entry.kind;
      const name = SEGMENT_LABEL[kind];
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
          changeRunbook(moveRunbook(runbook, kind, delta), "", { kind, role }),
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
          toggleRunbook(runbook, kind),
          isLastIncludedSegment(runbook, kind) ? RUNBOOK_FULL : "",
          { kind, role: "inout" },
        ),
      );

      const row = h(
        "div",
        {
          class: entry.included ? "a-setup-row rb-row" : "a-setup-row rb-row is-out",
          attrs: { draggable: "true", "data-kind": kind },
        },
        [
          h("span", {
            class: "mono rb-grip",
            text: "\u2807",
            attrs: { "aria-hidden": "true" },
          }),
          h("span", {
            class: "mono a-setup-pos",
            text: entry.included ? String(included.indexOf(kind) + 1) : "\u2013",
          }),
          h("div", { class: "a-setup-main" }, [
            h("span", { class: "a-setup-name", text: name }),
          ]),
          h("div", { class: "a-setup-acts" }, [
            move("up", -1),
            move("down", 1),
            inOut,
          ]),
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
          moveRunbook(runbook, kind, e.key === "ArrowUp" ? -1 : 1),
          "",
          { kind, role },
        );
      });

      /* ---- the pointer path ---- */
      row.addEventListener("dragstart", (ev) => {
        runbookDrag = kind;
        row.classList.add("is-dragging");
        const dt = (ev as DragEvent).dataTransfer;
        if (dt) {
          dt.effectAllowed = "move";
          dt.setData("text/plain", kind);
        }
      });
      row.addEventListener("dragend", () => {
        runbookDrag = null;
        row.classList.remove("is-dragging");
      });
      row.addEventListener("dragover", (ev) => {
        if (runbookDrag === null || runbookDrag === kind) return;
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
        if (moved === null || moved === kind) return;
        changeRunbook(dropRunbook(runbook, moved, i), "");
      });

      return row;
    }),
  );
}

/** Where the arcade running order sits while the session has not started. */
const lobbySetupSlot = h("div", { class: "lobby-setup" });

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

/** What the button says about arriving at each segment. Unchanged wording. */
const SEGMENT_ADVANCE_LABEL: Readonly<Record<Segment, string>> = {
  lobby: "Show the lobby",
  holding: "Show the holding card",
  trivia: "Open trivia",
  arcade: "Open the arcade",
  standings: "Show standings",
  final: "Show the final",
};

/**
 * The next segment in the host's runbook, as a button label and a command.
 *
 * This is the one place the run of show is read, and it is read out of the
 * runbook rather than out of a constant — so a host who took trivia out, or
 * put the standings before the arcade, gets a space bar that agrees with the
 * plan they wrote. `null` is the end of the runbook, which the button says in
 * words rather than by doing nothing.
 */
function advanceFrom(seg: Segment): { label: string; cmd: HostCommand | null } {
  const next = nextInRunbook(runbook, seg);
  if (next === null) return { label: "Nothing queued", cmd: null };
  return {
    label: SEGMENT_ADVANCE_LABEL[next],
    cmd: { name: "segment", kind: next },
  };
}

/**
 * The next round in the order the host set during setup — or, when they have
 * all been played, the next thing in the runbook. The button never says
 * "choose something": the choosing was done before the room arrived.
 */
function announceNext(): { label: string; cmd: HostCommand | null } {
  const pick = currentPick();
  if (pick === null) return advanceFrom("arcade");
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
          : advanceFrom("trivia");
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

  return advanceFrom(s.segment);
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

function render(s: RenderState): void {
  lastState = s;
  loadPlayed(s.sid);
  forgetPlayedIfStartingOver(s);

  /* status bar */
  setText(elTitle, s.title);
  const code = s.hostExtras?.joinCode ?? "————";
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
  // There is nothing to reopen unless it is shut, and a permanently greyed
  // button is a button the eye stops reading.
  reopenControl.el.hidden = s.phase !== "closed";
  if (s.phase !== "closed") reopenControl.disarm();

  /* starting over — armable in every phase the session has actually run in,
     including closed, which is the phase a host most often wants it from */
  restartArm.disabled = s.phase === "draft";
  if (s.phase === "draft" && restartArmed) setRestartArmed(false);
  syncRestartGo();
  const loaded = s.hostExtras?.trivia?.loaded ?? 0;
  setText(
    restartKeeps,
    `${s.roster.length} ${s.roster.length === 1 ? "person stays" : "people stay"} in the room with the same nickname, the join code does not change, and ` +
      (loaded > 0
        ? `the ${loaded} trivia question${loaded === 1 ? "" : "s"} stay loaded. `
        : "anything you have uploaded stays loaded. ") +
      "Nobody has to rejoin and nothing has to be uploaded again.",
  );

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
  if (arcadePlayed.size === 0 && arcadeOverride === null) return;
  arcadePlayed.clear();
  arcadeOverride = null;
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
renderRunbookSetup();
renderRail();

bindSpace(primary);
bindEscape(() => [
  lockControl,
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

// The holding fields stop being "dirty" once the host applies or leaves them.
document.addEventListener("click", (ev) => {
  const t = ev.target;
  if (t instanceof HTMLElement && t.closest(".field-actions")) holdingDirty = false;
});

client.start();
