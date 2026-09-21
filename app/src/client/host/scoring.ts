/**
 * The console's scoring panel: the grid, and the Spot Award box.
 *
 * This is used with thirty people watching, so it is keyboard-first and it
 * never opens anything:
 *
 * - **Tab moves along a row.** The small per-cell buttons are `tabindex="-1"`
 *   so the tab order is exactly the row, left to right. Nothing else is in it.
 * - **Type a number, press Enter.** Enter commits and drops to the same column
 *   of the next row, which is how a facilitator's sheet is actually read out:
 *   one activity, down the list. Shift+Enter goes back up. Leaving a cell with
 *   an uncommitted number commits it too — a score the host typed and tabbed
 *   past is a score they entered.
 * - **Alt+B benches the cell, Alt+U clears it**, from the keyboard, without
 *   leaving the field. The same two actions are small buttons for the mouse.
 * - **Escape puts the cell back** to what the server last said.
 * - **Refusals appear in the cell or the button that caused them**, for three
 *   seconds, and nothing steals focus. There are no dialogs in this file.
 *
 * What it does not do: any arithmetic. Normalisation, Bench Credit, the spot
 * total and the rank all arrive in `hostExtras.scores`. The grid is a view of
 * that, plus the raw numbers the host is typing into it.
 */

import type {
  ActivitySummary,
  HostCommand,
  RenderState,
  ScoreRow,
} from "../../protocol.ts";
import type { ScoreStatus } from "../../engine/types.ts";
import {
  h,
  keyedList,
  replace,
  setAttr,
  setText,
  type KeyedList,
} from "../shared/dom.ts";
import { activityHue } from "../shared/view.ts";
import { control, type Control } from "./controls.ts";

const FLASH_MS = 3_000;

export interface ScoringPanel {
  readonly el: HTMLElement;
  update(state: RenderState): void;
  /** Put the cursor in the first cell. The console binds a key to this. */
  focusFirst(): void;
}

interface Opts {
  /** Sends the command and routes the refusal back to `from`. */
  issue: (cmd: HostCommand, from: Control | null) => void;
}

interface CellRefs {
  td: HTMLTableCellElement;
  input: HTMLInputElement;
  points: HTMLElement;
  flash: HTMLElement;
  benchButton: HTMLButtonElement;
  control: Control;
  timer: ReturnType<typeof setTimeout> | null;
}

interface RowRefs {
  tr: HTMLTableRowElement;
  num: HTMLElement;
  name: HTMLElement;
  cells: Map<string, CellRefs>;
  spot: HTMLElement;
  total: HTMLElement;
  rank: HTMLElement;
}

/**
 * A `Control` that is a table cell.
 *
 * The console routes every refusal to the `Control` that issued the command;
 * a cell is not a button, but it is the thing the host is looking at, so it
 * implements the same three-second inline flash and ignores the rest.
 */
function cellControl(refs: () => CellRefs): Control {
  return {
    get el(): HTMLElement {
      return refs().td;
    },
    flash(message) {
      const c = refs();
      if (c.timer !== null) clearTimeout(c.timer);
      setText(c.flash, message);
      c.flash.hidden = false;
      c.td.classList.add("sc-refused");
      c.timer = setTimeout(() => {
        c.timer = null;
        c.flash.hidden = true;
        c.td.classList.remove("sc-refused");
      }, FLASH_MS);
    },
    setLabel() {},
    setDisabled() {},
    disarm() {},
  };
}

export function createScoringPanel(opts: Opts): ScoringPanel {
  /* ---------------------------------------------------------------- */
  /* Chrome                                                            */
  /* ---------------------------------------------------------------- */

  const hint = h("span", {
    class: "mono sc-hint",
    text: "G jumps here · Tab along the row · Enter saves and drops a row · Alt+B bench · Alt+U clear · Esc undo",
  });
  const head = h("div", { class: "sc-head" }, [
    h("span", { class: "label", text: "Scoring" }),
    hint,
  ]);

  const headRow = h("tr");
  const thead = h("thead", {}, [headRow]);
  const tbody = h("tbody");
  const table = h("table", { class: "sc-grid" }, [thead, tbody]);
  const gridWrap = h("div", { class: "sc-grid-wrap" }, [table]);
  const gridEmpty = h("p", {
    class: "pb-note",
    text: "Nobody has joined yet. The grid fills as people arrive.",
  });

  const benchLine = h("p", { class: "mono sc-bench-line" });

  /* ---- the Spot Award box ---- */

  const spotActivity = h("select", {
    class: "sc-select mono",
    attrs: { "aria-label": "Spot Award activity" },
  });
  const spotPerson = h("select", {
    class: "sc-select sc-select-person mono",
    attrs: { "aria-label": "Spot Award recipient" },
  });
  const spotReason = h("input", {
    class: "field sc-reason",
    type: "text",
    placeholder: "Reason — it gets read out to the room",
    attrs: { maxlength: "120", "aria-label": "Spot Award reason" },
  });
  const spotNote = h("span", { class: "mono sc-spot-note" });
  const spotLeft = h("span", { class: "mono sc-spot-left" });

  /**
   * The reason is mandatory. The server refuses an empty one, so this never
   * sends it: the button is disabled until there is something to read out,
   * and the note says why rather than leaving a dead button on screen.
   */
  const grant = control({
    label: "Grant award",
    className: "ctl-secondary ctl-spot",
    onFire: (c) => {
      const pid = spotPerson.value;
      const activityId = spotActivity.value;
      const reason = spotReason.value.trim();
      if (reason === "") {
        c.flash("A spot award needs a reason — it gets read out.");
        spotReason.focus();
        return;
      }
      if (pid === "" || activityId === "") {
        c.flash("Pick a person and an activity.");
        return;
      }
      opts.issue({ name: "spot.grant", pid, activityId, reason }, c);
      spotReason.value = "";
      syncGrant();
    },
  });

  const spotList = h("ul", { class: "sc-spot-list" });

  const spotBox = h("section", { class: "sc-spot" }, [
    h("div", { class: "sc-spot-form" }, [
      h("span", { class: "label", text: "Spot award" }),
      spotActivity,
      spotPerson,
      spotReason,
      grant.el,
      spotLeft,
    ]),
    spotNote,
    spotList,
  ]);

  const el = h("section", { class: "scoring" }, [
    head,
    gridWrap,
    gridEmpty,
    benchLine,
    spotBox,
  ]);

  /* ---------------------------------------------------------------- */
  /* State                                                             */
  /* ---------------------------------------------------------------- */

  let activities: readonly ActivitySummary[] = [];
  let columns = "";
  const refsFor = new WeakMap<HTMLElement, RowRefs>();
  /** Last value the server told us, per `pid|activityId`. Escape restores it. */
  const serverRaw = new Map<string, string>();
  let personOptions = "";

  function syncGrant(): void {
    const empty = spotReason.value.trim() === "";
    grant.setDisabled(empty || spotPerson.value === "" || spotActivity.value === "");
    setText(
      spotNote,
      empty
        ? "A reason is required — it is read out to the room."
        : "Worth 10 points. Two per activity by default.",
    );
    spotNote.classList.toggle("sc-spot-note-warn", empty);
  }

  spotReason.addEventListener("input", syncGrant);
  spotReason.addEventListener("keydown", (ev) => {
    if ((ev as KeyboardEvent).key !== "Enter") return;
    ev.preventDefault();
    grant.el.querySelector("button")?.click();
  });
  spotActivity.addEventListener("change", () => {
    renderPeople(lastRows, true);
    syncGrant();
  });
  spotPerson.addEventListener("change", syncGrant);
  syncGrant();

  /* ---------------------------------------------------------------- */
  /* The grid                                                          */
  /* ---------------------------------------------------------------- */

  function buildHeader(): void {
    replace(headRow, [
      h("th", { class: "sc-th sc-th-num", text: "#" }),
      h("th", { class: "sc-th sc-th-name", text: "Name" }),
      ...activities.map((a, i) =>
        h("th", { class: "sc-th sc-th-activity" }, [
          h("span", {
            class: "sc-th-swatch",
            attrs: { style: `background:${activityHue(a, i)}`, "aria-hidden": "true" },
          }),
          h("span", { class: "sc-th-title", text: a.title }),
        ]),
      ),
      h("th", { class: "sc-th sc-th-spot", text: "Spot" }),
      h("th", { class: "sc-th sc-th-total", text: "Total" }),
      h("th", { class: "sc-th sc-th-rank", text: "Rank" }),
    ]);
  }

  function cellKey(pid: string, activityId: string): string {
    return `${pid}|${activityId}`;
  }

  /** Every raw input in the grid for one activity, in row order. */
  function columnInputs(activityId: string): HTMLInputElement[] {
    // `Array.from`, not a spread: the typecheck config gives the clients `DOM`
    // without `DOM.Iterable`, and a NodeList is only array-like there.
    return Array.from(
      tbody.querySelectorAll<HTMLInputElement>("input.sc-raw"),
    ).filter((input) => input.dataset["activity"] === activityId);
  }

  function commit(pid: string, activityId: string, cell: CellRefs): void {
    const typed = cell.input.value.trim();
    if (typed === "") return; // nothing typed; clearing is Alt+U, deliberately
    const raw = Number(typed);
    if (!Number.isFinite(raw) || raw < 0) {
      // Not a rule being enforced twice: this is a number that cannot be put
      // on the wire at all. The server's own refusals still come back inline.
      cell.control.flash("A number, zero or above.");
      cell.input.select();
      return;
    }
    if (typed === (serverRaw.get(cellKey(pid, activityId)) ?? "")) return;
    opts.issue({ name: "score.set", activityId, pid, raw }, cell.control);
  }

  function setStatus(
    pid: string,
    activityId: string,
    status: ScoreStatus,
    cell: CellRefs,
  ): void {
    opts.issue({ name: "score.status", activityId, pid, status }, cell.control);
  }

  function makeCell(row: ScoreRow, activity: ActivitySummary): CellRefs {
    const input = h("input", {
      class: "sc-raw mono",
      type: "text",
      attrs: {
        inputmode: "numeric",
        autocomplete: "off",
        spellcheck: "false",
        "data-activity": activity.id,
        "aria-label": `${activity.title} raw score`,
      },
    });
    const points = h("span", { class: "sc-pts mono" });
    const flash = h("span", { class: "sc-flash mono", attrs: { hidden: true, role: "status" } });
    const benchButton = h("button", {
      class: "sc-mini",
      type: "button",
      text: "B",
      title:
        "Bench — they sat this one out. They are credited their own average instead of a zero, so missing an activity does not sink them. (Alt+B)",
      attrs: { tabindex: "-1" },
    });
    const clearButton = h("button", {
      class: "sc-mini",
      type: "button",
      text: "×",
      title: "Clear this cell back to empty — no score entered (Alt+U)",
      attrs: { tabindex: "-1" },
    });
    const td = h("td", { class: "sc-cell" }, [
      input,
      points,
      h("span", { class: "sc-acts" }, [benchButton, clearButton]),
      flash,
    ]);

    const cell: CellRefs = {
      td,
      input,
      points,
      flash,
      benchButton,
      control: null as unknown as Control,
      timer: null,
    };
    cell.control = cellControl(() => cell);

    const pid = row.pid;
    const id = activity.id;

    input.addEventListener("keydown", (ev) => {
      const key = ev.key;
      if (key === "Enter") {
        ev.preventDefault();
        commit(pid, id, cell);
        // Down the column: one activity, down the list, which is how a
        // facilitator reads their sheet out.
        const inputs = columnInputs(id);
        const at = inputs.indexOf(input);
        const next = inputs[at + (ev.shiftKey ? -1 : 1)];
        if (next) {
          next.focus();
          next.select();
        }
        return;
      }
      if (key === "Escape") {
        input.value = serverRaw.get(cellKey(pid, id)) ?? "";
        return;
      }
      if (ev.altKey && (key === "b" || key === "B")) {
        ev.preventDefault();
        setStatus(
          pid,
          id,
          td.dataset["status"] === "bench" ? "played" : "bench",
          cell,
        );
        return;
      }
      if (ev.altKey && (key === "u" || key === "U")) {
        ev.preventDefault();
        setStatus(pid, id, "unset", cell);
      }
    });
    // A number typed and tabbed past is a number the host entered.
    input.addEventListener("blur", () => commit(pid, id, cell));

    benchButton.addEventListener("click", () => {
      setStatus(pid, id, td.dataset["status"] === "bench" ? "played" : "bench", cell);
    });
    clearButton.addEventListener("click", () => setStatus(pid, id, "unset", cell));

    return cell;
  }

  function updateCell(cell: CellRefs, row: ScoreRow, activity: ActivitySummary): void {
    const status: ScoreStatus = row.status[activity.id] ?? "unset";
    const raw = row.raw[activity.id];
    const points = row.points[activity.id] ?? null;
    const key = cellKey(row.pid, activity.id);
    const asTyped = raw === null || raw === undefined ? "" : String(raw);
    serverRaw.set(key, asTyped);

    // Never eat what the host is in the middle of typing.
    if (document.activeElement !== cell.input) cell.input.value = asTyped;

    setAttr(cell.td, "data-status", status);
    cell.input.disabled = status === "bench";
    cell.benchButton.setAttribute("aria-pressed", status === "bench" ? "true" : "false");
    cell.benchButton.classList.toggle("on", status === "bench");

    // A benched cell shows what it is worth. The whole point of Bench Credit
    // is that it is a number, not a blank — and "—" only until they have
    // played something for the mean to be taken of.
    setText(cell.points, points === null ? "—" : String(points));
    cell.points.classList.toggle("sc-pts-top", points === 100 && status === "played");
    cell.points.classList.toggle("sc-pts-bench", status === "bench");
  }

  /**
   * A fresh reconciler whenever the columns change: the rows it is holding
   * are the wrong shape, and a list that re-inserted them would put a stale
   * grid back on screen.
   */
  const makeRowList = (): KeyedList<ScoreRow> => keyedList<ScoreRow>(
    tbody,
    (r) => r.pid,
    (r) => {
      const num = h("span", { class: "mono sc-num" });
      const name = h("span", { class: "sc-name" });
      const cells = new Map<string, CellRefs>();
      const spot = h("span", { class: "mono sc-spot-cell" });
      const total = h("span", { class: "mono sc-total" });
      const rank = h("span", { class: "mono sc-rank" });
      const tr = h("tr", { class: "sc-row" }, [
        h("td", { class: "sc-cell-num" }, [num]),
        h("td", { class: "sc-cell-name" }, [name]),
        ...activities.map((a) => {
          const cell = makeCell(r, a);
          cells.set(a.id, cell);
          return cell.td;
        }),
        h("td", { class: "sc-cell-spot" }, [spot]),
        h("td", { class: "sc-cell-total" }, [total]),
        h("td", { class: "sc-cell-rank" }, [rank]),
      ]);
      const refs: RowRefs = { tr, num, name, cells, spot, total, rank };
      refsFor.set(tr, refs);
      return tr;
    },
    (tr, r) => {
      const refs = refsFor.get(tr);
      if (!refs) return;
      setText(refs.num, String(r.playerNumber).padStart(3, "0"));
      // textContent, always. A nickname is whatever somebody typed.
      setText(refs.name, r.nickname);
      for (const a of activities) {
        const cell = refs.cells.get(a.id);
        if (cell) updateCell(cell, r, a);
      }
      setText(refs.spot, r.spot === 0 ? "—" : String(r.spot));
      refs.spot.classList.toggle("sc-has-spot", r.spot > 0);
      setText(refs.total, String(r.total));
      setText(refs.rank, String(r.rank));
    },
  );

  let rows = makeRowList();

  /* ---------------------------------------------------------------- */
  /* The Spot Award box                                                */
  /* ---------------------------------------------------------------- */

  let lastRows: readonly ScoreRow[] = [];
  let spotListSig = "";

  function renderActivities(): void {
    const wanted = activities.map((a) => `${a.id}:${a.spotsLeft}`).join(",");
    if (spotActivity.dataset["sig"] === wanted) return;
    spotActivity.dataset["sig"] = wanted;
    const keep = spotActivity.value;
    replace(
      spotActivity,
      activities.map((a) =>
        h("option", { text: a.title, attrs: { value: a.id } }),
      ),
    );
    if (activities.some((a) => a.id === keep)) spotActivity.value = keep;
    else spotActivity.value = activities[0]?.id ?? "";
  }

  /**
   * Who can receive one. A participant on bench for the chosen activity is not
   * offered — SCORING.md says they cannot receive that activity's awards, and
   * the server refuses it, so putting them in the list is only a trap.
   */
  function renderPeople(source: readonly ScoreRow[], force: boolean): void {
    const activityId = spotActivity.value;
    const eligible = source.filter((r) => r.status[activityId] !== "bench");
    const sig = `${activityId}|${eligible.map((r) => `${r.pid}:${r.nickname}`).join(",")}`;
    if (!force && sig === personOptions) return;
    personOptions = sig;
    const keep = spotPerson.value;
    replace(
      spotPerson,
      eligible.map((r) =>
        h("option", {
          // Never innerHTML: the nickname is text on an option, like anywhere.
          text: `${String(r.playerNumber).padStart(3, "0")}  ${r.nickname}`,
          attrs: { value: r.pid },
        }),
      ),
    );
    if (eligible.some((r) => r.pid === keep)) spotPerson.value = keep;
    else spotPerson.value = eligible[0]?.pid ?? "";
  }

  function renderSpots(state: RenderState): void {
    const extras = state.hostExtras;
    const granted = extras?.spots ?? [];
    const nameOf = new Map((extras?.scores ?? []).map((r) => [r.pid, r.nickname]));
    const titleOf = new Map(state.activities.map((a) => [a.id, a.title]));

    setText(
      spotLeft,
      activities
        .map((a) => `${a.title.split(" ")[0] ?? a.id}: ${a.spotsLeft} left`)
        .join(" · "),
    );

    // Only when the awards themselves change. A state arrives on every score
    // the host types, and rebuilding this list would disarm a half-pressed
    // "Revoke?" under their finger.
    const sig = granted.map((sp) => `${sp.seq}:${sp.pid}:${sp.reason}`).join("|");
    if (sig === spotListSig) return;
    spotListSig = sig;

    replace(
      spotList,
      [...granted].reverse().map((sp) => {
        const revoke = control({
          label: "revoke",
          className: "ctl-row ctl-danger",
          question: "Revoke?",
          onFire: (c) => opts.issue({ name: "spot.revoke", seq: sp.seq }, c),
        });
        return h("li", { class: "sc-spot-row" }, [
          h("span", {
            class: "mono sc-spot-activity",
            text: titleOf.get(sp.activityId) ?? sp.activityId,
          }),
          h("span", { class: "sc-spot-who", text: nameOf.get(sp.pid) ?? sp.pid }),
          h("span", { class: "sc-spot-reason", text: sp.reason }),
          revoke.el,
        ]);
      }),
    );
  }

  /** `Ade (Agentic Security TTX) · Grace (Trivia)`, from the grid. */
  function renderBench(source: readonly ScoreRow[]): void {
    const titleOf = new Map(activities.map((a) => [a.id, a.title]));
    const parts: string[] = [];
    for (const r of source) {
      for (const a of activities) {
        if (r.status[a.id] === "bench") {
          parts.push(`${r.nickname} (${titleOf.get(a.id) ?? a.id})`);
        }
      }
    }
    setText(benchLine, parts.length === 0 ? "Bench — nobody" : `Bench — ${parts.join(" · ")}`);
  }

  /* ---------------------------------------------------------------- */

  return {
    el,

    update(state) {
      const next = state.activities;
      const sig = next.map((a) => a.id).join(",");
      activities = next;
      if (sig !== columns) {
        columns = sig;
        buildHeader();
        // The columns changed under the rows: start the body again rather
        // than reconcile two different shapes of row.
        replace(tbody, []);
        rows = makeRowList();
      }

      const scores = state.hostExtras?.scores ?? [];
      // Display order only: join order, so a row never moves out from under
      // the cursor while the host is typing into it. Nothing is filtered —
      // the rank the server computed is a column.
      lastRows = [...scores].sort((a, b) => a.playerNumber - b.playerNumber);
      rows.update(lastRows);

      gridWrap.hidden = lastRows.length === 0;
      gridEmpty.hidden = lastRows.length > 0;

      renderActivities();
      renderPeople(lastRows, false);
      renderSpots(state);
      renderBench(lastRows);
      syncGrant();
    },

    focusFirst() {
      const first = tbody.querySelector<HTMLInputElement>("input.sc-raw");
      first?.focus();
      first?.select();
    },
  };
}
