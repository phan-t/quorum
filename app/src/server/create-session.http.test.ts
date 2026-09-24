/**
 * `POST /api/sessions`, over real HTTP against the real process — specifically
 * what the new session ends up scoring.
 *
 * The activity list is per-event configuration: it arrives in the create call
 * from the event's `session.json`, it becomes engine state, and nothing can
 * change it afterwards short of creating a second session, which loses the
 * join code and the tokens. So the tests that matter are the ones that pin the
 * default down and the ones that prove a bad list is refused *before* a
 * session exists.
 *
 * Its own file rather than an addition to server.test.ts, for the promo and
 * send-off tests' reason: `main.ts` listens on import, node's test runner
 * gives each file its own process, and this route is rate-limited to ten an
 * hour per process — which is why there are few tests here and why the
 * exhaustive validation lives in `src/activities/import.test.ts`.
 *
 * Every fixture below is invented. `config/events/` is gitignored and this
 * repository is public; no real event's list appears here.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { DEFAULT_ACTIVITIES } from "./runtime.ts";

const ADMIN_KEY = "test-admin-" + Math.random().toString(36).slice(2);
process.env["PORT"] = "0";
process.env["QUORUM_ADMIN_KEY"] = ADMIN_KEY;

const { server, registry, persister } = await import("./main.ts");

let port = 0;

before(async () => {
  if (!server.listening) await once(server, "listening");
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  await persister.drain();
  server.close();
});

const create = (body: unknown, token: string | null = ADMIN_KEY) =>
  fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

async function created(body: unknown) {
  const res = await create(body);
  const text = await res.text();
  assert.equal(res.status, 201, text);
  const { sid } = JSON.parse(text) as { sid: string };
  const runtime = registry.bySessionId(sid);
  assert.ok(runtime, "the session should be in the registry");
  return runtime.state;
}

describe("the default set", () => {
  /**
   * The one that must never move. Every session created before `activities`
   * existed was created without it, and "absent means the default" is the
   * promise that made adding the key safe.
   */
  it("is exactly DEFAULT_ACTIVITIES when the key is absent", async () => {
    const state = await created({ title: "No activities key" });
    assert.deepEqual(state.activities, DEFAULT_ACTIVITIES);
    assert.deepEqual(state.tiebreakOrder, ["trivia", "arcade"]);
    assert.deepEqual(Object.keys(state.scores), ["trivia", "arcade"]);
  });

  it("is the default for an explicit null, not a rejection", async () => {
    const state = await created({ title: "Null activities", activities: null });
    assert.deepEqual(state.activities, DEFAULT_ACTIVITIES);
  });
});

describe("an event's own list", () => {
  it("is what the session scores, in the file's order", async () => {
    const state = await created({
      title: "Three activities",
      activities: [
        { id: "trivia", title: "Trivia", kind: "trivia" },
        { id: "arcade", title: "Hashi Arcade", kind: "arcade" },
        { id: "ttx", title: "Security TTX", kind: "manual", spotCap: 2 },
      ],
    });
    assert.deepEqual(state.activities, [
      { id: "trivia", title: "Trivia", kind: "trivia", spotCap: 2 },
      { id: "arcade", title: "Hashi Arcade", kind: "arcade", spotCap: 2 },
      { id: "ttx", title: "Security TTX", kind: "manual", spotCap: 2 },
    ]);
    // A score bucket per activity, and the list's order is the tiebreak order:
    // the file says which activity settles a tie by saying which comes first.
    assert.deepEqual(Object.keys(state.scores), ["trivia", "arcade", "ttx"]);
    assert.deepEqual(state.tiebreakOrder, ["trivia", "arcade", "ttx"]);
  });

  it("can score one thing and nothing else", async () => {
    const state = await created({
      title: "Arcade only",
      activities: [{ id: "arcade", title: "Hashi Arcade", kind: "arcade", spotCap: 0 }],
    });
    assert.deepEqual(state.activities, [
      { id: "arcade", title: "Hashi Arcade", kind: "arcade", spotCap: 0 },
    ]);
    assert.deepEqual(state.tiebreakOrder, ["arcade"]);
  });
});

describe("a list that is wrong", () => {
  /** No half-made session: the 400 has to happen before anything is created. */
  async function refused(title: string, activities: unknown): Promise<string[]> {
    const res = await create({ title, activities });
    const text = await res.text();
    assert.equal(res.status, 400, text);
    const body = JSON.parse(text) as { error: string; errors: string[] };
    assert.equal(body.error, "invalid_activities");
    assert.ok(
      registry.all().every((r) => r.state.title !== title),
      "no session should have been created",
    );
    return body.errors;
  }

  it("is refused with an error addressed to the entry", async () => {
    const errors = await refused("Bad kind", [
      { id: "trivia", title: "Trivia", kind: "trivia" },
      { id: "arcade", title: "Hashi Arcade", kind: "arcede" },
    ]);
    assert.deepEqual(errors, [
      'Activity 2, kind: "arcede" is not an activity kind. Use trivia, arcade, manual.',
    ]);
  });

  it("is refused when two activities share an id", async () => {
    const errors = await refused("Repeated id", [
      { id: "ttx", title: "Security TTX", kind: "manual" },
      { id: "ttx", title: "Bake Off", kind: "manual" },
    ]);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /already activity 1/);
  });

  it("is refused when it is empty", async () => {
    const errors = await refused("Empty list", []);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /at least one activity/);
  });
});
