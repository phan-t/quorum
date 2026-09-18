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

import type { OwnPoints, RenderState } from "../../protocol.ts";
import { append, h, replace, setText } from "../shared/dom.ts";
import { pointsStrip, resolveView, type ViewKind } from "../shared/view.ts";

export interface ParticipantView {
  readonly root: HTMLElement;
  update(state: RenderState | null, nickname: string | null): void;
  setBanner(text: string | null): void;
}

interface Scene {
  node: HTMLElement;
  update(state: RenderState, nickname: string | null): void;
}

export function createParticipantView(opts: { compact?: boolean } = {}): ParticipantView {
  const banner = h("div", {
    class: "p-banner",
    attrs: { hidden: true, role: "status", "aria-live": "polite" },
  });
  const stage = h("main", { class: "p-stage" });
  const strip = h("div", { class: "p-strip mono" });
  const root = h("div", { class: opts.compact ? "p-root compact" : "p-root" }, [
    banner,
    stage,
    strip,
  ]);

  let kind: ViewKind | null = null;
  let scene: Scene | null = null;
  /** The last points seen before the seal. It freezes; it never disappears. */
  let lastOwn: OwnPoints | null = null;

  const renderStrip = (state: RenderState): void => {
    const sealed = state.seal === "sealed";
    if (state.own) lastOwn = state.own;
    replace(strip, [
      h("span", { class: "strip-points", text: pointsStrip(sealed ? lastOwn : state.own ?? null) }),
      sealed ? lockGlyph("strip-lock") : null,
      sealed ? h("span", { class: "strip-sealed label", text: "sealed" }) : null,
    ]);
    strip.classList.toggle("frozen", sealed);
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

    update(state, nickname) {
      if (state === null) return;
      const next = resolveView(state);
      if (next !== kind) {
        kind = next;
        scene = buildScene(next);
        replace(stage, [scene.node]);
        stage.dataset["view"] = next;
      }
      scene?.update(state, nickname);
      renderStrip(state);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Scenes                                                              */
/* ------------------------------------------------------------------ */

function buildScene(kind: ViewKind): Scene {
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
      return scenePending("Trivia", "The host is setting up.");
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
