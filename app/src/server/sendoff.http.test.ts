/**
 * The send-off endpoints, over real HTTP against the real process.
 *
 * Three endpoints with deliberately different auth: the file and the asset
 * upload are host-token-only and answer a wrong token exactly as they answer
 * an unknown session; the asset read has no token at all, because an `<img>`
 * and an `<audio>` cannot carry a header. The tests that matter are the ones
 * pinning those decisions down, plus the promise that bytes never reach the
 * engine — the whole reason photos are keys.
 *
 * Its own file rather than an addition to server.test.ts: `main.ts` listens on
 * import, and node's test runner gives each file its own process.
 *
 * Every fixture here is invented. The real event's send-off is messages real
 * colleagues wrote about a real person, `config/events/` is gitignored for
 * that reason, and this repository is public.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { newSession } from "../engine/reducer.ts";
import { DEFAULT_ACTIVITIES } from "./runtime.ts";
import { MAX_ASSET_BYTES } from "./store/types.ts";

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
      sid: `ses_sendoff_${n}`,
      title: `Send-off ${n}`,
      joinCode: `hvs.httpsendoff${String(n).padStart(3, "0")}xxxxxx`,
      activities: DEFAULT_ACTIVITIES,
    }),
  );
  created.runtime.apply({ type: "open" }, Date.now());
  return created;
}

const FILE = {
  for: { name: "Alex Rivera", subtitle: "Last day 30 September 2026" },
  opening: { photos: ["photos/a.jpg", "photos/b.jpg"], music: "send-off.mp3", seconds: 40 },
  kudos: [{ from: "Sam", message: "Thanks for every review you left on my first PRs." }],
  closing: { photos: [], line: "See you around." },
};

/** Something that is bytes and is not text: a one-pixel PNG's opening bytes. */
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0xff, 0xfe, 0xfd, 0x00, 0x01, 0x80, 0x7f,
]);

const post = (path: string, body: string | Buffer, token?: string, type = "application/json") =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "content-type": type,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body as BodyInit,
  });

const get = (path: string, method = "GET") =>
  fetch(`http://127.0.0.1:${port}${path}`, { method });

const file = (patch: Record<string, unknown> = {}) => JSON.stringify({ ...FILE, ...patch });

describe("POST /api/sessions/:sid/content/sendoff", () => {
  it("loads the send-off and reports what it will need", async () => {
    const s = makeSession();
    const sid = s.runtime.state.sid;
    const res = await post(`/api/sessions/${sid}/content/sendoff`, file(), s.hostToken);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      kudos: 1,
      photos: 2,
      music: "send-off.mp3",
      assets: ["photos/a.jpg", "photos/b.jpg", "send-off.mp3"],
    });
    assert.equal(s.runtime.state.sendoff?.content.name, "Alex Rivera");
  });

  it("puts keys into the state and nothing that could be bytes", async () => {
    const s = makeSession();
    await post(`/api/sessions/${s.runtime.state.sid}/content/sendoff`, file(), s.hostToken);
    assert.deepEqual(s.runtime.state.sendoff?.content.opening.photos, [
      "photos/a.jpg",
      "photos/b.jpg",
    ]);
  });

  it("refuses with no token, and with the screen token", async () => {
    const s = makeSession();
    const sid = s.runtime.state.sid;
    assert.equal((await post(`/api/sessions/${sid}/content/sendoff`, file())).status, 401);
    assert.equal(
      (await post(`/api/sessions/${sid}/content/sendoff`, file(), s.screenToken)).status,
      401,
    );
  });

  it("answers an unknown session exactly as it answers a wrong token", async () => {
    const s = makeSession();
    const other = makeSession();
    const unknown = await post("/api/sessions/ses_nope/content/sendoff", file(), s.hostToken);
    const wrong = await post(
      `/api/sessions/${s.runtime.state.sid}/content/sendoff`,
      file(),
      other.hostToken,
    );
    assert.equal(unknown.status, wrong.status);
    assert.deepEqual(await unknown.json(), await wrong.json());
  });

  it("refuses a body that is not JSON by its declared type", async () => {
    const s = makeSession();
    const res = await post(
      `/api/sessions/${s.runtime.state.sid}/content/sendoff`,
      file(),
      s.hostToken,
      "text/html",
    );
    assert.equal(res.status, 415);
  });

  it("rejects the whole file, with errors addressed by position", async () => {
    const s = makeSession();
    const sid = s.runtime.state.sid;
    const res = await post(
      `/api/sessions/${sid}/content/sendoff`,
      file({ kudos: [{ from: "Sam", message: "Thanks." }, { from: "Jo" }] }),
      s.hostToken,
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; errors: string[] };
    assert.equal(body.error, "invalid_sendoff");
    assert.match(body.errors[0] ?? "", /^Kudo 2, message:/);
    // All or nothing: the one good message is not loaded either.
    assert.equal(s.runtime.state.sendoff, null);
  });

  it("replaces, so a fixed file can be re-uploaded", async () => {
    const s = makeSession();
    const sid = s.runtime.state.sid;
    await post(`/api/sessions/${sid}/content/sendoff`, file(), s.hostToken);
    await post(
      `/api/sessions/${sid}/content/sendoff`,
      file({ for: { name: "Alex Rivera", subtitle: "Second pass" } }),
      s.hostToken,
    );
    assert.equal(s.runtime.state.sendoff?.content.subtitle, "Second pass");
  });

  it("passes the engine's own refusal through as a conflict", async () => {
    const s = makeSession();
    const sid = s.runtime.state.sid;
    await post(`/api/sessions/${sid}/content/sendoff`, file(), s.hostToken);
    // Walk it past the opening montage: the content is now what the room saw.
    s.runtime.apply({ type: "sendoffNext" }, Date.now());
    const res = await post(`/api/sessions/${sid}/content/sendoff`, file(), s.hostToken);
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { error: string }).error, "wrong_phase");
  });
});

describe("POST /api/sessions/:sid/assets/:key", () => {
  it("stores the bytes under the key, byte-identical", async () => {
    const s = makeSession();
    const sid = s.runtime.state.sid;
    const res = await post(`/api/sessions/${sid}/assets/photos%2Fp01.jpg`, PNG, s.hostToken, "image/png");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      key: "photos/p01.jpg",
      bytes: PNG.length,
      contentType: "image/png",
    });
    const stored = await store.getAsset(sid, "photos/p01.jpg");
    assert.deepEqual(Buffer.from(stored?.bytes ?? new Uint8Array()), PNG);
  });

  it("takes the key unencoded too, because a hand-written src is not encoded", async () => {
    const s = makeSession();
    const sid = s.runtime.state.sid;
    await post(`/api/sessions/${sid}/assets/photos/p02.jpg`, PNG, s.hostToken, "image/png");
    assert.notEqual(await store.getAsset(sid, "photos/p02.jpg"), null);
  });

  it("refuses with no token, and with the screen token", async () => {
    const s = makeSession();
    const sid = s.runtime.state.sid;
    assert.equal((await post(`/api/sessions/${sid}/assets/a.jpg`, PNG)).status, 401);
    assert.equal((await post(`/api/sessions/${sid}/assets/a.jpg`, PNG, s.screenToken)).status, 401);
  });

  it("answers an unknown session exactly as it answers a wrong token", async () => {
    const s = makeSession();
    const other = makeSession();
    const unknown = await post("/api/sessions/ses_nope/assets/a.jpg", PNG, s.hostToken);
    const wrong = await post(
      `/api/sessions/${s.runtime.state.sid}/assets/a.jpg`,
      PNG,
      other.hostToken,
    );
    assert.equal(unknown.status, wrong.status);
    assert.deepEqual(await unknown.json(), await wrong.json());
  });

  it("refuses a key that climbs out of the event directory", async () => {
    const s = makeSession();
    const res = await post(
      `/api/sessions/${s.runtime.state.sid}/assets/..%2F..%2Fetc%2Fpasswd`,
      PNG,
      s.hostToken,
    );
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "bad_key");
  });

  it("refuses an asset over the cap rather than truncating it", async () => {
    const s = makeSession();
    const sid = s.runtime.state.sid;
    const huge = Buffer.alloc(MAX_ASSET_BYTES + 1, 0x41);
    const res = await post(`/api/sessions/${sid}/assets/big.jpg`, huge, s.hostToken, "image/jpeg");
    assert.equal(res.status, 413);
    // Nothing half-stored: a JPEG missing its last third is a grey band.
    assert.equal(await store.getAsset(sid, "big.jpg"), null);
  });

  it("takes one right on the cap", async () => {
    const s = makeSession();
    const sid = s.runtime.state.sid;
    const exact = Buffer.alloc(MAX_ASSET_BYTES, 0x42);
    const res = await post(`/api/sessions/${sid}/assets/edge.jpg`, exact, s.hostToken, "image/jpeg");
    assert.equal(res.status, 200);
    assert.equal((await store.getAsset(sid, "edge.jpg"))?.bytes.byteLength, MAX_ASSET_BYTES);
  });

  it("refuses an empty body", async () => {
    const s = makeSession();
    const res = await post(
      `/api/sessions/${s.runtime.state.sid}/assets/empty.jpg`,
      Buffer.alloc(0),
      s.hostToken,
      "image/jpeg",
    );
    assert.equal(res.status, 400);
  });

  it("never reaches the engine", async () => {
    const s = makeSession();
    const sid = s.runtime.state.sid;
    const before = s.runtime.state.seq;
    const logBefore = s.runtime.log.length;
    await post(`/api/sessions/${sid}/assets/photos%2Fq.jpg`, PNG, s.hostToken, "image/png");
    assert.equal(s.runtime.state.seq, before);
    assert.equal(s.runtime.log.length, logBefore);
  });
});

describe("GET /api/sessions/:sid/assets/:key", () => {
  it("serves the bytes with no token, and byte-identical", async () => {
    const s = makeSession();
    const sid = s.runtime.state.sid;
    await post(`/api/sessions/${sid}/assets/photos%2Fp01.jpg`, PNG, s.hostToken, "image/png");

    const res = await get(`/api/sessions/${sid}/assets/photos%2Fp01.jpg`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    // The bytes under a key never change, and a montage re-fetching forty
    // photos a frame is a montage that stutters.
    assert.match(res.headers.get("cache-control") ?? "", /max-age=31536000/);
    assert.match(res.headers.get("cache-control") ?? "", /immutable/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  });

  it("serves an unencoded key the same way", async () => {
    const s = makeSession();
    const sid = s.runtime.state.sid;
    await post(`/api/sessions/${sid}/assets/photos%2Fp01.jpg`, PNG, s.hostToken, "image/png");
    const res = await get(`/api/sessions/${sid}/assets/photos/p01.jpg`);
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  });

  it("serves the type it was given, whatever that is", async () => {
    const s = makeSession();
    const sid = s.runtime.state.sid;
    await post(`/api/sessions/${sid}/assets/song.mp3`, PNG, s.hostToken, "audio/mpeg");
    const res = await get(`/api/sessions/${sid}/assets/song.mp3`);
    assert.equal(res.headers.get("content-type"), "audio/mpeg");
  });

  it("404s an unknown key, an unknown session and a bad key alike", async () => {
    const s = makeSession();
    const sid = s.runtime.state.sid;
    const missing = await get(`/api/sessions/${sid}/assets/nothing.jpg`);
    const unknown = await get("/api/sessions/ses_nope/assets/nothing.jpg");
    const bad = await get(`/api/sessions/${sid}/assets/..%2F..%2Fetc%2Fpasswd`);
    assert.equal(missing.status, 404);
    assert.equal(unknown.status, 404);
    assert.equal(bad.status, 404);
    assert.deepEqual(await missing.json(), await unknown.json());
  });

  it("keeps one session's assets out of another's", async () => {
    const a = makeSession();
    const b = makeSession();
    await post(`/api/sessions/${a.runtime.state.sid}/assets/x.jpg`, PNG, a.hostToken, "image/png");
    assert.equal((await get(`/api/sessions/${b.runtime.state.sid}/assets/x.jpg`)).status, 404);
  });
});

describe("the store's own listing", () => {
  it("names every asset with its size and type, and no bytes", async () => {
    const s = makeSession();
    const sid = s.runtime.state.sid;
    await post(`/api/sessions/${sid}/assets/photos%2Fb.jpg`, PNG, s.hostToken, "image/png");
    await post(`/api/sessions/${sid}/assets/photos%2Fa.jpg`, PNG, s.hostToken, "image/png");
    assert.deepEqual(
      (await store.listAssets(sid)).map((a) => ({ key: a.key, size: a.size, contentType: a.contentType })),
      [
        { key: "photos/a.jpg", size: PNG.length, contentType: "image/png" },
        { key: "photos/b.jpg", size: PNG.length, contentType: "image/png" },
      ],
    );
  });

  it("is empty for a session that never staged one", async () => {
    assert.deepEqual(await store.listAssets(makeSession().runtime.state.sid), []);
  });
});
