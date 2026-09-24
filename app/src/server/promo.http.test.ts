/**
 * The promo card endpoints, over real HTTP against the real process.
 *
 * Two endpoints with deliberately opposite auth: the upload is host-token-only
 * and answers a wrong token exactly as it answers an unknown session, and the
 * read has no token at all because an iframe cannot carry a header. The tests
 * that matter are the ones that pin those two decisions down, plus the promise
 * that the card never reaches the engine.
 *
 * Its own file rather than an addition to server.test.ts: `main.ts` listens on
 * import, and node's test runner gives each file its own process.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { newSession } from "../engine/reducer.ts";
import { DEFAULT_ACTIVITIES } from "./runtime.ts";
import { MAX_PROMO_CHARS } from "./store/types.ts";

process.env["PORT"] = "0";
process.env["QUORUM_ADMIN_KEY"] = "test-admin-" + Math.random().toString(36).slice(2);

const { server, registry, store, persister } = await import("./main.ts");

let port = 0;
let n = 0;

before(async () => {
  if (!server.listening) await once(server, "listening");
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  await persister.drain();
  server.close();
});

function makeSession() {
  n += 1;
  const created = registry.add(
    newSession({
      sid: `ses_promo_${n}`,
      title: `Promo ${n}`,
      joinCode: `hvs.httppromo${String(n).padStart(3, "0")}xxxxxxxxx`,
      activities: DEFAULT_ACTIVITIES,
    }),
  );
  created.runtime.apply({ type: "open" }, Date.now());
  return created;
}

/**
 * A stand-in card. Nothing here is the real event's poster and nothing should
 * ever be: `config/events/` is gitignored because its content is about the
 * people in the room, and this repository is public.
 */
const CARD = "<!doctype html><title>Poster</title><h1>Two o'clock, level 4</h1>";

const post = (path: string, body: string, token?: string, type = "text/html") =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "content-type": type,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body,
  });

const get = (path: string, method = "GET") =>
  fetch(`http://127.0.0.1:${port}${path}`, { method });

describe("POST /api/sessions/:sid/content/promo", () => {
  it("stores the card for the host", async () => {
    const s = makeSession();
    const sid = s.runtime.state.sid;
    const res = await post(`/api/sessions/${sid}/content/promo`, CARD, s.hostToken);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { chars: CARD.length });
    assert.equal(await store.getPromo(sid), CARD);
  });

  it("refuses with no token", async () => {
    const s = makeSession();
    const res = await post(`/api/sessions/${s.runtime.state.sid}/content/promo`, CARD);
    assert.equal(res.status, 401);
  });

  it("refuses the screen token — view-only means view-only", async () => {
    const s = makeSession();
    const res = await post(
      `/api/sessions/${s.runtime.state.sid}/content/promo`,
      CARD,
      s.screenToken,
    );
    assert.equal(res.status, 401);
  });

  it("answers an unknown session exactly as it answers a wrong token", async () => {
    const s = makeSession();
    const other = makeSession();
    const unknown = await post("/api/sessions/ses_nope/content/promo", CARD, s.hostToken);
    const wrong = await post(
      `/api/sessions/${s.runtime.state.sid}/content/promo`,
      CARD,
      other.hostToken,
    );
    assert.equal(unknown.status, wrong.status);
    assert.deepEqual(await unknown.json(), await wrong.json());
  });

  it("refuses a body that is not HTML", async () => {
    const s = makeSession();
    const res = await post(
      `/api/sessions/${s.runtime.state.sid}/content/promo`,
      "{}",
      s.hostToken,
      "application/json",
    );
    assert.equal(res.status, 415);
  });

  it("refuses a card over the cap rather than truncating it", async () => {
    const s = makeSession();
    const sid = s.runtime.state.sid;
    const huge = "<p>x</p>".repeat(Math.ceil((MAX_PROMO_CHARS + 100) / 8));
    const res = await post(`/api/sessions/${sid}/content/promo`, huge, s.hostToken);
    assert.equal(res.status, 413);
    // Nothing half-stored: a poster missing its bottom third is worse than none.
    assert.equal(await store.getPromo(sid), null);
  });

  it("replaces, so a fixed card can be re-uploaded", async () => {
    const s = makeSession();
    const sid = s.runtime.state.sid;
    await post(`/api/sessions/${sid}/content/promo`, CARD, s.hostToken);
    await post(`/api/sessions/${sid}/content/promo`, "<p>second</p>", s.hostToken);
    assert.equal(await store.getPromo(sid), "<p>second</p>");
  });

  it("never reaches the engine", async () => {
    const s = makeSession();
    const sid = s.runtime.state.sid;
    const before = s.runtime.state.seq;
    const logBefore = s.runtime.log.length;
    await post(`/api/sessions/${sid}/content/promo`, CARD, s.hostToken);
    assert.equal(s.runtime.state.seq, before);
    assert.equal(s.runtime.log.length, logBefore);
    // And nothing of it is anywhere in the state the reducer replays.
    assert.ok(!JSON.stringify(s.runtime.state).includes("Two o'clock"));
  });
});

describe("GET /api/sessions/:sid/promo", () => {
  it("serves the card with no token, locked down", async () => {
    const s = makeSession();
    const sid = s.runtime.state.sid;
    await post(`/api/sessions/${sid}/content/promo`, CARD, s.hostToken);

    const res = await get(`/api/sessions/${sid}/promo`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    const csp = res.headers.get("content-security-policy") ?? "";
    // The embedded page must not be able to tell anyone it is being looked at.
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, /frame-ancestors 'self'/);
    assert.equal(await res.text(), CARD);
  });

  it("404s a session with no card, and an unknown session, alike", async () => {
    const s = makeSession();
    const none = await get(`/api/sessions/${s.runtime.state.sid}/promo`);
    const unknown = await get("/api/sessions/ses_nope/promo");
    assert.equal(none.status, 404);
    assert.equal(unknown.status, 404);
    assert.deepEqual(await none.json(), await unknown.json());
  });

  it("answers HEAD, which is how the Desktop asks whether there is a card", async () => {
    const s = makeSession();
    const sid = s.runtime.state.sid;
    const before = await get(`/api/sessions/${sid}/promo`, "HEAD");
    assert.equal(before.status, 404);

    await post(`/api/sessions/${sid}/content/promo`, CARD, s.hostToken);
    const after = await get(`/api/sessions/${sid}/promo`, "HEAD");
    assert.equal(after.status, 200);
    assert.equal(after.headers.get("content-length"), String(CARD.length));
    assert.equal(await after.text(), "");
  });
});
