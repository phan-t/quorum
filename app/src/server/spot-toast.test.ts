/**
 * What a Spot Award says when it reaches the room.
 *
 * SPEC.md, "Spot Awards": "10 points each, granted from the console with a
 * **required reason**, which the Desktop shows as a toast: *Spot Award —
 * Kenji — best recovery of the afternoon*." Three parts, from three places:
 * the **Spot Award** label is the Desktop's, drawn in its own `.label` span by
 * `showToast` in client/screen/main.ts; the reason is the host's, carried as
 * the effect's `detail`; and the name is the boundary's, looked up here from
 * the effect's `subject` pid.
 *
 * #31, split out of #29. The toast named nobody: `grantSpot` emitted the bare
 * reason and runtime.ts put `effect.detail ?? ""` on the wire, so a room read
 * "Spot Award  best recovery of the afternoon" and the person it was for was
 * on no surface at the moment it landed. #29 found client/shared/mock.ts
 * naming them and matched the mock *down* to the server, which was right for
 * the mock — it is an oracle for the server, not a wish about it — and left
 * the server's half as this issue. The spec settles it: the example names
 * Kenji, so the nameless toast was a gap and the mock had it right.
 *
 * Why the pid rather than the name in `detail`, which would have been one
 * line in the reducer: a rendered name is a name as of the grant. `kick` frees
 * a nickname for the next person through the door and `setNickname` moves it,
 * and an effect — which is also what an event log replays — would keep saying
 * the old one. The engine is also pure and has no roster lookups in it by
 * design. So the pid travels and this layer resolves it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { newSession, reduce, replay } from "../engine/reducer.ts";
import type { Activity, Effect, Event, SessionState } from "../engine/types.ts";
import { SessionRegistry, spotToastText, type Client } from "./runtime.ts";

const ACTIVITIES: readonly Activity[] = [
  { id: "ttx", title: "The TTX", kind: "manual", spotCap: 2 },
  { id: "trivia", title: "Trivia", kind: "trivia", spotCap: 2 },
];

const T0 = 1_700_000_000_000;

/** A running session with `Kenji` at p1 and `Mira` at p2. */
function running(): SessionState {
  const events: Event[] = [
    { type: "open" },
    { type: "join", pid: "p1", nickname: "Kenji" },
    { type: "join", pid: "p2", nickname: "Mira" },
    { type: "start" },
  ];
  return replay(
    newSession({
      sid: "ses_spot_toast",
      title: "Divergence",
      joinCode: "hvs.aaaaaaaaaaaaaaaaaaaaaaaa",
      activities: ACTIVITIES,
    }),
    events.map((event) => ({ event, at: T0 })),
  );
}

interface Heard {
  /** Every `toast` frame's `text`, in order. */
  readonly texts: string[];
}

function listener(
  runtime: ReturnType<SessionRegistry["add"]>["runtime"],
  role: "participant" | "host" | "screen",
  pid?: string,
): Heard {
  const texts: string[] = [];
  const socket = {
    readyState: 1,
    send(frame: string) {
      const msg = JSON.parse(frame) as { t: string; text?: string };
      if (msg.t === "toast") texts.push(msg.text ?? "");
    },
  } as unknown as Client["socket"];
  runtime.clients.add({
    socket,
    role,
    ...(pid ? { pid } : {}),
    lastSeen: T0,
    seq: 0,
    rtt: [],
    pingSentAt: null,
  });
  return { texts };
}

function room(state = running()) {
  const registry = new SessionRegistry();
  const { runtime } = registry.add(state, T0);
  return {
    runtime,
    host: listener(runtime, "host"),
    screen: listener(runtime, "screen"),
    kenji: listener(runtime, "participant", "p1"),
    mira: listener(runtime, "participant", "p2"),
  };
}

const GRANT: Event = {
  type: "grantSpot",
  activityId: "ttx",
  pid: "p1",
  reason: "  best recovery of the afternoon  ",
};

/* ------------------------------------------------------------------ */
/* 1. The line itself                                                   */
/* ------------------------------------------------------------------ */

describe("the Spot Award toast names its recipient", () => {
  it("puts `<nickname> — <reason>` on the wire, and the label nowhere", () => {
    const { runtime, host } = room();
    assert.equal(runtime.apply(GRANT, T0 + 1_000).applied, true);
    assert.deepEqual(host.texts, ["Kenji — best recovery of the afternoon"]);
    // The Desktop draws "Spot Award" itself. If the boundary sent it too the
    // big screen would read it twice, which is exactly the bug #29 took *out*
    // of the mock — so it must not come back in on the server's side.
    assert.ok(
      !(host.texts[0] ?? "").includes("Spot Award"),
      "the boundary is drawing the Desktop's label as well",
    );
    // And the reason is still trimmed: that is the reducer's, not this layer's,
    // but the whole line is what the room hears.
    assert.ok(
      !(host.texts[0] ?? "").endsWith(" "),
      "the reason reached the wire untrimmed",
    );
  });

  it("names the person it was granted to, not the first person in the room", () => {
    const { runtime, host } = room();
    assert.equal(
      runtime.apply({ ...GRANT, pid: "p2", reason: "asked the hard one" }, T0 + 1_000)
        .applied,
      true,
    );
    assert.deepEqual(host.texts, ["Mira — asked the hard one"]);
  });

  it("uses the name as of the toast, not a name copied at the grant", () => {
    // The point of carrying a pid, and the path is a real one rather than a
    // hypothetical. A kicked participant who comes back takes a *new* nickname
    // on the *same* pid — `join` in reducer.ts rewrites `nickname` when
    // `existing.kicked`, and SPEC.md requires the new name to be different.
    // So two awards to one pid, either side of that, have to read as the two
    // different names the room saw. A nickname frozen into the effect at
    // `grantSpot` would make the second toast say the name of somebody who no
    // longer answers to it — and worse, a name `kick` has already freed for
    // another person to join under.
    const { runtime, host } = room();
    assert.equal(runtime.apply({ ...GRANT, reason: "first" }, T0 + 1_000).applied, true);
    assert.equal(runtime.apply({ type: "kick", pid: "p1" }, T0 + 2_000).applied, true);
    assert.equal(
      runtime.apply({ type: "join", pid: "p1", nickname: "Kenji B" }, T0 + 3_000).applied,
      true,
    );
    assert.equal(runtime.state.participants["p1"]?.nickname, "Kenji B");
    assert.equal(runtime.apply({ ...GRANT, reason: "second" }, T0 + 4_000).applied, true);
    assert.deepEqual(host.texts, ["Kenji — first", "Kenji B — second"]);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Who hears it                                                      */
/* ------------------------------------------------------------------ */

describe("the toast is addressed to the whole room", () => {
  it("reaches the console, the big screen and every phone alike", () => {
    const { runtime, host, screen, kenji, mira } = room();
    runtime.apply(GRANT, T0 + 1_000);
    const expected = ["Kenji — best recovery of the afternoon"];
    assert.deepEqual(host.texts, expected, "the console");
    assert.deepEqual(screen.texts, expected, "the big screen");
    // Both phones, and the same text on each: the effect is `to: "all"` and the
    // boundary fans it with `sendAll`, so a phone gets the toast about somebody
    // else too. Nothing on a phone renders it today — client/participant/main.ts
    // passes no `onToast`, so net.ts's optional call drops it — but the frame is
    // on the wire either way, and it must not become per-recipient by accident.
    assert.deepEqual(kenji.texts, expected, "the recipient's phone");
    assert.deepEqual(mira.texts, expected, "a bystander's phone");
  });
});

/* ------------------------------------------------------------------ */
/* 3. A pid that does not resolve                                       */
/* ------------------------------------------------------------------ */

describe("a toast whose subject cannot be found", () => {
  /**
   * Unreachable through `grantSpot`, which refuses `unknown_participant` for a
   * pid that is absent or kicked, and participants are never spliced out of
   * the record. Tested against the projection function directly, because the
   * decision is about what the room hears if the pid ever stops resolving —
   * after a future rule, a hand-edited snapshot, a second toast emitter — and
   * "it cannot happen" is not a rendering.
   *
   * The answer is the **bare reason**: exactly what the wire carried before
   * #31. Not `undefined — <reason>`, and not a leading dash over a hole. A
   * toast is read out in front of the room, and a missing name should cost the
   * room the name and nothing else.
   */
  const toast = (detail: string | undefined, subject: string | undefined): Effect => ({
    kind: "broadcast",
    to: "all",
    what: "toast",
    ...(detail === undefined ? {} : { detail }),
    ...(subject === undefined ? {} : { subject }),
  });

  it("falls back to the reason alone rather than naming nobody loudly", () => {
    const s = running();
    assert.equal(spotToastText(s, toast("best recovery", "p_ghost")), "best recovery");
    assert.ok(
      !spotToastText(s, toast("best recovery", "p_ghost")).includes("undefined"),
      "an unresolvable pid reached the wire as the word `undefined`",
    );
    assert.ok(
      !spotToastText(s, toast("best recovery", "p_ghost")).startsWith("—"),
      "an unresolvable pid left a dash with nothing in front of it",
    );
  });

  it("falls back the same way for a toast that carries no subject at all", () => {
    // What any future non-Spot toast would look like: `subject` is optional
    // because a toast about the room has nobody to name.
    assert.equal(spotToastText(running(), toast("the doors are closing", undefined)), "the doors are closing");
  });

  it("does not leave a dangling dash when there is a name and no reason", () => {
    // `grantSpot` refuses an empty reason, so this too is a guard rather than a
    // path — but `detail` is optional on the effect, and "Kenji — " is a worse
    // thing to put on a wall than "Kenji".
    assert.equal(spotToastText(running(), toast(undefined, "p1")), "Kenji");
    assert.equal(spotToastText(running(), toast("", "p1")), "Kenji");
  });

  it("composes the name and the reason when both are there", () => {
    // The positive case against the same function the negatives use, so the
    // fallbacks above are not passing by returning the fallback always.
    assert.equal(
      spotToastText(running(), toast("best recovery", "p2")),
      "Mira — best recovery",
    );
  });
});

/* ------------------------------------------------------------------ */
/* 4. The engine's half                                                 */
/* ------------------------------------------------------------------ */

describe("the effect the boundary is reading", () => {
  it("carries the pid and the reason, and leaves the rendering here", () => {
    const result = reduce(running(), GRANT, T0 + 1_000);
    const effect = result.effects.find((e) => e.kind === "broadcast" && e.what === "toast");
    assert.ok(effect !== undefined && effect.kind === "broadcast", "a toast effect");
    assert.equal(effect.to, "all");
    assert.equal(effect.subject, "p1");
    assert.equal(effect.detail, "best recovery of the afternoon");
  });
});
