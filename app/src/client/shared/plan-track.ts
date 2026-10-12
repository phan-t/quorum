/**
 * The Plan / Apply race track: every player's position against the finish
 * line, drawn on the phone, in the Lounge and on the Desktop.
 *
 * One lane per player, in player-number order so nobody's lane moves between
 * frames. A runner slides along its lane as its count rises — the slide is a
 * CSS transition on `left`, so the server can send the race at its own pace
 * and the motion between frames is still smooth. A runner the lock caught
 * explodes once, where it stood, and stays there as a wreck: the count froze
 * at that point, and the wreck is the room's record of who went down where.
 *
 * Built once and updated in place. Rebuilding lanes on every frame would
 * restart every transition and replay every explosion, eight times a second.
 *
 * Reduced motion: no slide, and the explosion is a single still frame — the
 * wreck appears where the runner stood. See tokens.css.
 */

import type { ArcadePlanApplyTrackRunner } from "../../protocol.ts";
import { h, setAttr, setText } from "./dom.ts";

export interface PlanTrack {
  readonly root: HTMLElement;
  /**
   * @param you the viewer's own player number, highlighted; null on the Desktop
   */
  update(
    runners: readonly ArcadePlanApplyTrackRunner[],
    target: number,
    checkpoints: readonly number[],
    you: number | null,
  ): void;
  /** A new round: forget every lane, so a wreck does not survive into it. */
  reset(): void;
}

/** How long the explosion plays before the runner settles into its wreck. */
const BOOM_MS = 700;

/** Lanes past this count draw dots without player tags, so they stay legible. */
const DENSE_AT = 16;

interface Lane {
  readonly node: HTMLElement;
  readonly runner: HTMLElement;
  readonly tag: HTMLElement;
  out: boolean;
  boomTimer: ReturnType<typeof setTimeout> | null;
}

const tag3 = (n: number): string => String(n).padStart(3, "0");

export function createPlanTrack(): PlanTrack {
  const marks = h("div", {
    class: "pt-marks",
    attrs: { "aria-hidden": "true" },
  });
  const lanesNode = h("div", { class: "pt-lanes" });
  const root = h("div", { class: "pt", attrs: { role: "img" } }, [
    marks,
    lanesNode,
  ]);
  const lanes = new Map<number, Lane>();
  let marksFor = "";

  const lane = (playerNumber: number): Lane => {
    const existing = lanes.get(playerNumber);
    if (existing) return existing;
    const tag = h("span", { class: "mono pt-tag", text: tag3(playerNumber) });
    const runner = h("span", { class: "pt-runner" }, [
      h("span", { class: "pt-dot", attrs: { "aria-hidden": "true" } }),
      tag,
    ]);
    const node = h("div", { class: "pt-lane" }, [
      h("span", { class: "pt-rail", attrs: { "aria-hidden": "true" } }),
      runner,
    ]);
    const made: Lane = { node, runner, tag, out: false, boomTimer: null };
    lanes.set(playerNumber, made);
    return made;
  };

  const settle = (l: Lane): void => {
    if (l.boomTimer !== null) clearTimeout(l.boomTimer);
    l.boomTimer = null;
    setAttr(l.runner, "data-state", "wreck");
  };

  return {
    root,
    reset() {
      for (const l of lanes.values()) {
        if (l.boomTimer !== null) clearTimeout(l.boomTimer);
      }
      lanes.clear();
      lanesNode.replaceChildren();
      marksFor = "";
    },
    update(runners, target, checkpoints, you) {
      // The checkpoint lines and the finish line, drawn across every lane.
      const markSig = `${target}:${checkpoints.join(",")}`;
      if (markSig !== marksFor) {
        marksFor = markSig;
        marks.replaceChildren(
          ...checkpoints.map((c) =>
            h("span", {
              class: "pt-mark",
              attrs: { style: `--x:${target > 0 ? c / target : 0}` },
            }),
          ),
          h("span", { class: "pt-finish", attrs: { style: "--x:1" } }),
        );
      }

      const seen = new Set<number>();
      let order = 0;
      for (const r of runners) {
        seen.add(r.playerNumber);
        const l = lane(r.playerNumber);
        // Kept in player-number order without moving a node that is already
        // where it belongs: moving it would restart its transition.
        if (lanesNode.children[order] !== l.node) {
          lanesNode.insertBefore(l.node, lanesNode.children[order] ?? null);
        }
        order += 1;

        const x =
          target > 0 ? Math.min(1, Math.max(0, r.resources / target)) : 0;
        l.runner.style.setProperty("--x", x.toFixed(4));
        setAttr(l.node, "data-you", r.playerNumber === you ? "yes" : "no");
        setAttr(l.node, "data-struck", r.struck ? "yes" : "no");
        setText(l.tag, r.playerNumber === you ? "YOU" : tag3(r.playerNumber));

        if (r.out && !l.out) {
          l.out = true;
          // A wreck that arrives with the lane — a page opened mid-round, a
          // phone that reconnected — never saw the runner alive, so it does
          // not see it explode either.
          if (l.runner.dataset["state"] === undefined) {
            settle(l);
          } else {
            setAttr(l.runner, "data-state", "boom");
            l.boomTimer = setTimeout(() => settle(l), BOOM_MS);
          }
        } else if (!r.out) {
          l.out = false;
          setAttr(l.runner, "data-state", r.across ? "crossed" : "running");
        }
      }
      for (const [n, l] of lanes) {
        if (seen.has(n)) continue;
        if (l.boomTimer !== null) clearTimeout(l.boomTimer);
        l.node.remove();
        lanes.delete(n);
      }

      setAttr(root, "data-dense", runners.length > DENSE_AT ? "yes" : "no");
      root.style.setProperty("--pt-lanes", String(Math.max(1, runners.length)));
      const out = runners.filter((r) => r.out).length;
      const crossed = runners.filter((r) => r.across).length;
      const mine =
        you === null ? undefined : runners.find((r) => r.playerNumber === you);
      setAttr(
        root,
        "aria-label",
        `Race to ${target}: ${runners.length - out - crossed} running, ${crossed} across, ${out} caught by the lock` +
          (mine ? `. You are on ${mine.resources}.` : "."),
      );
    },
  };
}
