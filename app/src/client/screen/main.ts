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

import type { ActivitySummary, RenderState, StandingRow } from "../../protocol.ts";
import { h, qs, replace, setText } from "../shared/dom.ts";
import { QuorumClient } from "../shared/net.ts";
import { mockBadge, mockTransport, readMockConfig } from "../shared/mock.ts";
import { activityHue, resolveView, stackedBar, type ViewKind } from "../shared/view.ts";
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
      return sceneCard("Trivia", "Coming up.");
    case "arcade":
      return sceneCard("Hashi Arcade", "Coming up.");
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
    h("h1", { class: "display s-title s-title-huge", text: "Standings are sealed" }),
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
}

const client = new QuorumClient({
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
