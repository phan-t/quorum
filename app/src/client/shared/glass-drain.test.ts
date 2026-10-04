/**
 * The Desktop's drain line on the bridge (#44).
 *
 * It guessed the reason from the frame's own `step`. A host's "next wave"
 * resets that to 0, so a player cut at step 1 read as a fall, and the frame
 * that ends the round carries no `step` or `position`, so every last-step
 * drain read "Pane 1". These are the paths a Fable repro walked on a real
 * server.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { glassDrainLine, type GlassMoment } from "./view.ts";

const at = (wave: number, step: number | undefined, position: Record<string, number>, running = true): GlassMoment =>
  ({ running, wave, step, position });

describe("glassDrainLine", () => {
  it("a fall is a drain with the step still open", () => {
    assert.equal(
      glassDrainLine(at(1, 1, { p: 1 }), at(1, 1, { p: 1 }), "p", 1),
      "Pane 2 was not tempered. Player 001 drained.",
    );
  });

  it("not stepping is a drain on the frame that opened the next step", () => {
    assert.equal(
      glassDrainLine(at(1, 2, { p: 2 }), at(1, 3, { p: 2 }), "p", 2),
      "Pane 3 was not chosen. Player 002 drained.",
    );
  });

  it("a host's next wave at step 1 is not a fall, though step resets to 0", () => {
    assert.equal(
      glassDrainLine(at(2, 0, { p: 0 }), at(3, 0, { p: 0 }), "p", 3),
      "Pane 1 was not chosen. Player 003 drained.",
    );
  });

  it("the round's end names the last pane, though that frame drops position", () => {
    assert.equal(
      glassDrainLine(at(3, 5, { p: 5 }), at(3, undefined, {}, false), "p", 4),
      "Pane 6 was not chosen. Player 004 drained.",
    );
  });

  it("with no previous frame it does not claim a fall", () => {
    assert.match(glassDrainLine(null, at(1, 0, { p: 0 }), "p", 1), /was not chosen/);
  });
});
