/**
 * The console's scoring panel: the grid.
 *
 * It was the grid *and* the Spot Award box — an activity picker, a person
 * picker, a required-reason field, a Grant button, a per-activity "2 left"
 * counter and a revocable list of what had been granted — plus a bench line
 * under the grid naming everybody credited rather than scored. Both features
 * came out; see SCORING.md's "Removed" section. What is left is the thing a host
 * actually used.
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
 * - **Alt+U clears the cell**, from the keyboard, without leaving the field. The
 *   same action is a small button for the mouse. There was an Alt+B beside it
 *   that benched the cell, and it went with Bench Credit.
 * - **Escape puts the cell back** to what the server last said.
 * - **Refusals appear in the cell or the button that caused them**, for three
 *   seconds, and nothing steals focus. There are no dialogs in this file.
 *
 * What it does not do: any arithmetic. The normalised points, the total and the
 * rank all arrive in `hostExtras.scores`. The grid is a view of that, plus the
 * raw numbers the host is typing into it.
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
import { activityHue, stackedBar } from "../shared/view.ts";
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
  control: Control;
  timer: ReturnType<typeof setTimeout> | null;
}

interface RowRefs {
  tr: HTMLTableRowElement;
  num: HTMLElement;
  name: HTMLElement;
  cells: Map<string, CellRefs>;
  mix: HTMLElement;
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
    setOn() {},
    disarm() {},
  };
}

export function createScoringPanel(opts: Opts): ScoringPanel {
  /* ---------------------------------------------------------------- */
  /* Chrome                                                            */
  /* ---------------------------------------------------------------- */

  const hint = h("span", {
    class: "mono sc-hint",
    text: "G jumps here · Tab along the row · Enter saves and drops a row · Alt+U clear · Esc undo",
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

  const el = h("section", { class: "scoring" }, [head, gridWrap, gridEmpty]);

  /* ---------------------------------------------------------------- */
  /* State                                                             */
  /* ---------------------------------------------------------------- */

  let activities: readonly ActivitySummary[] = [];
  let columns = "";
  const refsFor = new WeakMap<HTMLElement, RowRefs>();
  /** Last value the server told us, per `pid|activityId`. Escape restores it. */
  const serverRaw = new Map<string, string>();

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
      h("th", { class: "sc-th sc-th-mix", text: "Mix" }),
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
    const clearButton = h("button", {
      class: "sc-mini",
      type: "button",
      text: "×",
      title: "Clear this cell back to empty, with no score entered (Alt+U)",
      attrs: { tabindex: "-1" },
    });
    const td = h("td", { class: "sc-cell" }, [
      input,
      points,
      h("span", { class: "sc-acts" }, [clearButton]),
      flash,
    ]);

    const cell: CellRefs = {
      td,
      input,
      points,
      flash,
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
      if (ev.altKey && (key === "u" || key === "U")) {
        ev.preventDefault();
        setStatus(pid, id, "unset", cell);
      }
    });
    // A number typed and tabbed past is a number the host entered.
    input.addEventListener("blur", () => commit(pid, id, cell));

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
    // No cell is ever disabled now. A benched one was — the raw was meaningless
    // and the server refused a score for it — and with the status gone every
    // cell in the grid is typeable.
    setText(cell.points, points === null ? "—" : String(points));
    cell.points.classList.toggle("sc-pts-top", points === 100 && status === "played");
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
      const mix = h("div", { class: "sc-bar" });
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
        // Not focusable, so the tab order along the row is still exactly the
        // editable cells and nothing else.
        h("td", { class: "sc-cell-mix" }, [mix]),
        h("td", { class: "sc-cell-total" }, [total]),
        h("td", { class: "sc-cell-rank" }, [rank]),
      ]);
      const refs: RowRefs = { tr, num, name, cells, mix, total, rank };
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
      // Where the total came from, drawn by the same function the Desktop
      // uses. The numbers are already along this row; the bar is what makes a
      // row readable at a glance and comparable to the one under it, which is
      // the question a host is actually asked — not "what did they score in
      // trivia" but "why are they third".
      replace(
        refs.mix,
        stackedBar({ perActivity: r.points }, activities, barScale).map((seg) =>
          h("div", {
            class: "sc-seg",
            attrs: {
              style: `flex-basis:${seg.percent}%;background-color:${seg.hue}`,
              "data-activity": seg.key,
              title: `${seg.label}: ${seg.points}`,
            },
          }),
        ),
      );
      setText(refs.total, String(r.total));
      setText(refs.rank, String(r.rank));
    },
  );

  let rows = makeRowList();

  let lastRows: readonly ScoreRow[] = [];
  /**
   * The biggest total on the board, so every row's bar is drawn against the
   * same width and two rows can be compared by eye.
   *
   * Set before the rows are reconciled, because the reconciler's update
   * callback reads it. Zero while nobody has scored, which `stackedBar`
   * already treats as "draw nothing".
   */
  let barScale = 0;

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
      barScale = Math.max(0, ...lastRows.map((r) => r.total));
      rows.update(lastRows);

      gridWrap.hidden = lastRows.length === 0;
      gridEmpty.hidden = lastRows.length > 0;
    },

    focusFirst() {
      const first = tbody.querySelector<HTMLInputElement>("input.sc-raw");
      first?.focus();
      first?.select();
    },
  };
}
