/**
 * The round cards count what was dealt (#46).
 *
 * Gganbu's card said "Six over-or-under questions" over a staged bank of
 * eight, and the Bridge's said "Twelve panes" while its reveal said eighteen.
 * The counts now come from the frame, and the tables are what a frame
 * without one falls back to — so each table line has to be what the counted
 * line says for the launch content, or the fallback disagrees with itself.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ArcadeGganbuView, ArcadeGlassView } from "../../protocol.ts";
import {
  ARCADE_ROUND_CARD,
  HOW_TO_PLAY,
  glassRevealHead,
  howToPlayLines,
  roundCardLines,
} from "./view.ts";

const glass = (of: number) => ({ of }) as unknown as ArcadeGlassView;
const gganbu = (of: number) => ({ of }) as unknown as ArcadeGganbuView;

describe("the round cards count what was dealt", () => {
  it("the Bridge card counts its panes", () => {
    const lines = roundCardLines({ round: "glass_bridge", glass: glass(9) });
    assert.equal(lines[1], "Eighteen panes. Nine are tempered. The tempered ones are real.");
    assert.equal(lines[0], ARCADE_ROUND_CARD.glass_bridge[0]);
  });

  it("and its how-to-play counts its steps", () => {
    const lines = howToPlayLines({ round: "glass_bridge", glass: glass(4) });
    assert.match(lines[0] ?? "", /^Four steps\. /);
  });

  it("Gganbu counts its prompts", () => {
    const lines = howToPlayLines({ round: "gganbu", gganbu: gganbu(8) });
    assert.equal(lines[1], "Eight over-or-under questions. Bet tokens on your answer.");
  });

  it("the Bridge reveal head counts the same board", () => {
    assert.equal(glassRevealHead(6), "TWELVE PANES. SIX ARE TEMPERED.");
    assert.equal(glassRevealHead(9), "EIGHTEEN PANES. NINE ARE TEMPERED.");
  });

  it("the tables are the counted lines for the launch content", () => {
    assert.deepEqual(
      roundCardLines({ round: "glass_bridge", glass: glass(6) }),
      ARCADE_ROUND_CARD.glass_bridge,
    );
    assert.deepEqual(
      howToPlayLines({ round: "glass_bridge", glass: glass(6) }),
      HOW_TO_PLAY.glass_bridge,
    );
    assert.deepEqual(
      howToPlayLines({ round: "gganbu", gganbu: gganbu(6) }),
      HOW_TO_PLAY.gganbu,
    );
  });

  it("a frame without a count gets the table", () => {
    assert.deepEqual(
      roundCardLines({ round: "glass_bridge" }),
      ARCADE_ROUND_CARD.glass_bridge,
    );
    assert.deepEqual(
      roundCardLines({ round: null }),
      ARCADE_ROUND_CARD.recruitment,
    );
    assert.deepEqual(howToPlayLines({ round: null }), []);
  });
});
