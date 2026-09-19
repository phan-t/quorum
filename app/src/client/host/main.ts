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

import type { HostCommand, RenderState, RosterEntry } from "../../protocol.ts";
import { initTheme, themeToggle } from "../shared/theme.ts";
import type { Segment } from "../../engine/types.ts";
import { h, keyedList, qs, replace, setAttr, setText } from "../shared/dom.ts";
import { QuorumClient } from "../shared/net.ts";
import { mockBadge, mockTransport, readMockConfig } from "../shared/mock.ts";
import {
  SEGMENTS,
  SEGMENT_LABEL,
  SEGMENT_PHASE,
  nextSegment,
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
        text: "Open it as /host#<host token>. The token goes in the fragment so it never reaches a server log. Add ?mock=1 to drive a fake session instead.",
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
const elSeal = h("span", { class: "sb-seal mono" });
const elPhase = h("span", { class: "sb-phase mono" });

const elConn = h("span", { class: "sb-conn mono", attrs: { hidden: true } });

const elTheme = themeToggle();

const statusBar = h("header", { class: "statusbar" }, [
  h("span", { class: "sb-warn mono", text: "⚠ DO NOT SHARE" }),
  elTitle,
  elCode,
  elCounts,
  elPhase,
  elConn,
  elSeal,
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

const preview = createParticipantView({ compact: true });
const toastList = h("ul", { class: "toasts" });
const tray = h("aside", { class: "tray" }, [
  h("div", { class: "tray-preview" }, [
    h("p", { class: "label", text: "Phone preview" }),
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

const sealControl = control({
  label: "Seal standings",
  className: "ctl-secondary ctl-seal",
  question: "Really seal?",
  onFire: (c) => {
    const seal = lastState?.seal ?? "live";
    issue({ name: "seal", state: seal === "live" ? "sealed" : "revealed" }, c);
  },
});

const unsealControl = control({
  label: "Back to live",
  className: "ctl-secondary",
  question: "Show standings again?",
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
    SEGMENT_PHASE[seg] > 1
      ? h("span", { class: "seg-phase mono", text: `P${SEGMENT_PHASE[seg]}` })
      : null,
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
      label: "release",
      className: "ctl-row",
      question: "Release name?",
      title: "Frees the nickname so the same person can rejoin on another device",
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
  attrs: { maxlength: "140", "aria-label": "Holding card line" },
});
const holdingApply = control({
  label: "Apply to the room",
  className: "ctl-secondary",
  onFire: (c) =>
    issue(
      { name: "holding", title: holdingTitle.value.trim(), line: holdingLine.value.trim() },
      c,
    ),
});
const holdingClear = control({
  label: "Clear card",
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
    h("span", { class: "label", text: "Line" }),
    holdingLine,
  ]),
  h("div", { class: "field-actions" }, [holdingApply.el, holdingClear.el]),
  h("p", {
    class: "pb-note",
    text: "The room sees this the moment it is applied. The phone preview on the right is what they see.",
  }),
]);

const standingsRows = h("ol", { class: "h-rows" });
const standingsNote = h("p", { class: "pb-note" });
const bodyStandings = h("section", { class: "pb" }, [standingsRows, standingsNote]);

const bodyPending = h("section", { class: "pb" }, [
  h("p", { class: "pb-note pb-warn" }),
]);

const bodies: Record<string, HTMLElement> = {
  lobby: bodyLobby,
  holding: bodyHolding,
  standings: bodyStandings,
  final: bodyStandings,
  trivia: bodyPending,
  arcade: bodyPending,
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
  setText(elSeal, s.seal === "sealed" ? "■ SEALED" : `● ${s.seal.toUpperCase()}`);
  setAttr(elSeal, "data-seal", s.seal);
  // Sealed is loud: the whole bar carries it, so the host never has to wonder
  // whether the room can see the standings.
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
  sealControl.setLabel(s.seal === "live" ? "Seal standings" : "Reveal standings");
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
          ? "Sealed: the console still shows this. No other surface does."
          : "The room sees exactly this.",
    );
    standingsNote.classList.toggle("pb-warn", s.seal === "sealed");
  }

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
 * The console is shown everything; the room is not. The preview has to be the
 * room's view or it is worse than no preview at all.
 */
function roomView(s: RenderState): RenderState {
  const { hostExtras: _hostExtras, own: _own, ...rest } = s;
  return { ...rest, standings: s.seal === "sealed" ? [] : s.standings };
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
