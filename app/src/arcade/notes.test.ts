/**
 * The reveal notes, as facts rather than as copy.
 *
 * Every round's note is read out to the room by the House, which makes each one
 * a claim about a HashiCorp product made in front of people who use these
 * products for a living. A wrong note is worse than no note: the round is
 * teaching, briefly, and the one thing it cannot afford is to be confidently
 * wrong in the register the rest of the product earns its credibility with.
 *
 * Three notes were wrong at one point, and all three read perfectly well aloud,
 * which is why they are asserted here rather than remembered. What each test
 * guards is the *shape* of the mistake, not the wording of the fix:
 *
 * - **A product's shape can go stale while its name does not.** Waypoint's
 *   notes described build, deploy and release from one command. That is
 *   Waypoint Community Edition, a repository archived in January 2024 whose own
 *   README says it is no longer actively maintained; HCP Waypoint is templates,
 *   add-on definitions and actions. Nothing about the *name* rotted, so nothing
 *   about the name would have caught it.
 * - **A note can be true of half a product.** Boundary's said nothing is handed
 *   out and no key changes hands, which is credential injection — where "the
 *   user never sees the credential required to authenticate to the target" —
 *   and not credential brokering, which fetches a credential and returns it to
 *   the user. Boundary does both.
 * - **A real pane can be embellished.** Consul Autopilot's note said new
 *   servers are introduced one at a time. What the page documents is a
 *   stabilization period a new server must stay healthy through before it
 *   becomes a voter. On the Glass Bridge the real pane is the one the room is
 *   told is the fact, so an invention on the true pane costs what a wrong pane
 *   costs.
 *
 * These live in `arcade/` beside the content, not in `engine/`: they are
 * properties of the words, and the engine neither reads a note nor cares what
 * is in one.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { GLASS_BRIDGE_STEPS } from "./glass-bridge.ts";
import { RECRUITMENT_ITEMS } from "./recruitment.ts";
import { UNSEAL_ITEMS } from "./unseal.ts";

/** Every note the House can read out, labelled by where it came from. */
const NOTES: readonly { readonly where: string; readonly note: string }[] = [
  ...RECRUITMENT_ITEMS.map((i) => ({ where: `Recruitment ${i.answer}`, note: i.note })),
  ...UNSEAL_ITEMS.map((i) => ({ where: `Unseal ${i.answer}`, note: i.note })),
  ...GLASS_BRIDGE_STEPS.flatMap((s) =>
    s.panes.map((p) => ({ where: `Glass Bridge ${p.label}`, note: p.note })),
  ),
];

describe("the arcade's reveal notes", () => {
  test("there is a note behind every answer, and the House can say it", () => {
    // The count is here so that a round losing its notes is a failure rather
    // than a shorter loop: seven emoji, seventeen tins, twelve panes.
    assert.equal(NOTES.length, 7 + 17 + 12);
    for (const { where, note } of NOTES) {
      assert.ok(note.trim() !== "", `${where} has no note`);
      // DESIGN.md: "no exclamation marks, ever". The Front-End Man does not
      // raise his voice and a note that needs one is a note explaining a gag.
      assert.ok(!note.includes("!"), `${where}'s note has an exclamation mark`);
    }
  });

  test("no note describes Waypoint Community Edition, which is archived", () => {
    const waypoint = NOTES.filter((n) => /waypoint/i.test(n.where));
    assert.equal(waypoint.length, 2, "Waypoint is an emoji item and a tin");
    for (const { where, note } of waypoint) {
      assert.ok(
        !/one command|build,? deploy,? and release|running url/i.test(note),
        `${where} describes the archived Community Edition's one-command workflow`,
      );
      // And it says what HCP Waypoint is instead, so that the test fails on a
      // note gone vague as well as on one gone stale.
      assert.ok(
        /template|add-on|action/i.test(note),
        `${where} does not say what HCP Waypoint actually is`,
      );
    }
  });

  test("no note claims Boundary hands nothing over, because brokering does", () => {
    for (const { where, note } of NOTES.filter((n) => /boundary/i.test(n.where))) {
      assert.ok(
        !/nothing is handed out|nothing to rotate|no key changes hands/i.test(note),
        `${where} claims of all of Boundary what is only true of credential injection`,
      );
    }
  });

  test("Consul Autopilot's note says only what its page says", () => {
    const autopilot = NOTES.find((n) => n.where === "Glass Bridge Consul Autopilot");
    assert.ok(autopilot, "the Consul step's real pane is Autopilot");
    assert.ok(
      !/one at a time/i.test(autopilot.note),
      "the autopilot page documents a stabilization period, not one-at-a-time introduction",
    );
    assert.ok(
      /stabiliz|stabilis/i.test(autopilot.note),
      "the real pane's note should name the thing the page actually documents",
    );
  });

  test("no note names a version number", () => {
    // The discipline glass-bridge.ts sets out, applied to every round: a
    // release number is a second fact to be wrong about, read out as
    // confidently as the first, and no note needs one to be funny.
    for (const { where, note } of NOTES) {
      assert.ok(
        !/\bv?\d+\.\d+/i.test(note),
        `${where}'s note names a version: ${note}`,
      );
    }
  });
});
