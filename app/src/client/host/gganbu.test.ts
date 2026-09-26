/**
 * The console's Gganbu decisions.
 *
 * Three rules, all of them things the facilitator acts on while the room
 * watches: whether the settle button can be pressed, whether both halves of
 * every pair have locked in, and which of the six notes has to be re-checked
 * before it is read out loud. The markup around them is a widget; these are
 * worth tests for the reason plan.ts is.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { ArcadeGganbuRecap } from "../../protocol.ts";
import {
  canSettlePrompt,
  gganbuLockNote,
  gganbuLockedIn,
  gganbuRecapRows,
  gganbuVerifyNotice,
} from "./gganbu.ts";

/** Three of six carry the flag, exactly as the shipped bank does. */
const RECAP: readonly ArcadeGganbuRecap[] = [
  {
    cue: "Terraform's default parallelism",
    threshold: "15",
    answer: "under",
    note: "10 — concurrent resource operations.",
  },
  {
    cue: "Vault's default max lease TTL, in hours",
    threshold: "720",
    answer: "over",
    note: "768 — thirty-two days.",
    verify: true,
  },
  {
    cue: "Consul's maximum KV value size, in kilobytes",
    threshold: "1024",
    answer: "under",
    note: "512 — Raft's suggested maximum.",
    verify: true,
  },
  {
    cue: "Nomad's first public release",
    threshold: "2016",
    answer: "under",
    note: "2015 — announced in September.",
  },
  {
    cue: "The year Terraform 0.12 shipped",
    threshold: "2018",
    answer: "over",
    note: "2019 — May.",
    verify: true,
  },
  {
    cue: "The year Vault reached 1.0",
    threshold: "2017",
    answer: "over",
    note: "2018 — December.",
  },
];

describe("settling a prompt", () => {
  it("is pressable while a prompt other than the last one is open", () => {
    assert.equal(
      canSettlePrompt({ phase: "running", round: "gganbu", at: 0, of: 6 }),
      true,
    );
    assert.equal(
      canSettlePrompt({ phase: "running", round: "gganbu", at: 4, of: 6 }),
      true,
    );
  });

  it("is refused on the last prompt, because endRound settles that one", () => {
    assert.equal(
      canSettlePrompt({ phase: "running", round: "gganbu", at: 5, of: 6 }),
      false,
    );
  });

  it("is refused outside a running Gganbu round", () => {
    for (const phase of ["idle", "card", "reveal"] as const) {
      assert.equal(
        canSettlePrompt({ phase, round: "gganbu", at: 0, of: 6 }),
        false,
        phase,
      );
    }
    assert.equal(
      canSettlePrompt({ phase: "running", round: "tug_of_raft", at: 0, of: 6 }),
      false,
    );
    assert.equal(
      canSettlePrompt({ phase: "running", round: null, at: 0, of: 6 }),
      false,
    );
  });

  it("is refused on a board with no prompts on it", () => {
    assert.equal(
      canSettlePrompt({ phase: "running", round: "gganbu", at: 0, of: 0 }),
      false,
    );
  });
});

describe("who has locked in", () => {
  it("counts the Floor, and says when everybody has", () => {
    assert.deepEqual(gganbuLockedIn(["a", "b", "c"], ["a", "b"]), {
      staked: 2,
      onFloor: 3,
      all: false,
    });
    assert.deepEqual(gganbuLockedIn(["a", "b", "c"], ["c", "a", "b"]), {
      staked: 3,
      onFloor: 3,
      all: true,
    });
  });

  it("ignores a staker who has since been revoked", () => {
    // `d` staked, the stake took them to zero, and they are in the Lounge. The
    // prompt is fully staked even though the Floor is now three.
    assert.deepEqual(gganbuLockedIn(["a", "b", "c"], ["a", "b", "c", "d"]), {
      staked: 3,
      onFloor: 3,
      all: true,
    });
  });

  it("is never 'all' on an empty Floor", () => {
    assert.deepEqual(gganbuLockedIn([], []), { staked: 0, onFloor: 0, all: false });
  });
});

describe("the line under the prompt", () => {
  it("points at the settle button while prompts remain", () => {
    assert.equal(
      gganbuLockNote(gganbuLockedIn(["a", "b"], ["a", "b"]), false),
      "All 2 have locked in. Settle the prompt to move the tokens.",
    );
    assert.equal(
      gganbuLockNote(gganbuLockedIn(["a", "b"], ["a"]), false),
      "1 of 2 have locked in. Settle the prompt to move the tokens.",
    );
  });

  it("points at End the round on the last prompt, which has no next one", () => {
    assert.equal(
      gganbuLockNote(gganbuLockedIn(["a", "b"], ["a", "b"]), true),
      "All 2 have locked in. End the round to settle it.",
    );
  });

  it("says what to do when the round has revoked everybody", () => {
    assert.equal(
      gganbuLockNote(gganbuLockedIn([], ["a"]), false),
      "Nobody is holding tokens. End the round.",
    );
  });
});

describe("the recap the console gets and nobody else does", () => {
  it("numbers the prompts from one and marks the open one", () => {
    const rows = gganbuRecapRows(RECAP, 1);
    assert.equal(rows.length, 6);
    assert.equal(rows[0]?.n, 1);
    assert.equal(rows[0]?.open, false);
    assert.equal(rows[1]?.n, 2);
    assert.equal(rows[1]?.open, true);
    assert.equal(rows[1]?.answer, "over");
    assert.equal(rows[1]?.threshold, "720");
  });

  it("reads an absent flag as false rather than as missing", () => {
    // `verify` is omitted rather than falsed on every role but the host, so a
    // row without it must not draw a chip.
    const rows = gganbuRecapRows(RECAP, 0);
    assert.equal(rows[0]?.verify, false);
    assert.equal(rows[1]?.verify, true);
    assert.deepEqual(
      rows.filter((r) => r.verify).map((r) => r.n),
      [2, 3, 5],
    );
  });

  it("is empty for a surface that was never sent the recap", () => {
    assert.deepEqual(gganbuRecapRows(undefined, 0), []);
    assert.equal(gganbuVerifyNotice(undefined), "");
  });

  it("names the flagged prompts by number, and only those", () => {
    assert.equal(
      gganbuVerifyNotice(RECAP),
      "Check prompts 2, 3 and 5 against the source before you read the note out: those answers can move.",
    );
  });

  it("says nothing at all when no answer can move", () => {
    assert.equal(
      gganbuVerifyNotice(RECAP.map((r) => ({ ...r, verify: false }))),
      "",
    );
  });

  it("reads in the singular for one flagged prompt", () => {
    assert.equal(
      gganbuVerifyNotice([RECAP[1] as ArcadeGganbuRecap]),
      "Check prompt 1 against the source before you read the note out: those answers can move.",
    );
  });
});
