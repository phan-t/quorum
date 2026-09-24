/**
 * The two export endpoints, over real HTTP against the real process.
 *
 * ARCHITECTURE.md's REST table: `GET /api/sessions/:sid/export.csv` and
 * `GET /api/sessions/:sid/events.jsonl`, both host-only. The auth model is one
 * bearer token per session compared by hash, so the interesting cases are the
 * ones where the wrong token, or the screen's token, is presented.
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

process.env["PORT"] = "0";
process.env["QUORUM_ADMIN_KEY"] = "test-admin-" + Math.random().toString(36).slice(2);

const { server, registry, persister } = await import("./main.ts");

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
      sid: `ses_http_${n}`,
      title: `Export ${n}`,
      joinCode: `hvs.httpexport${String(n).padStart(3, "0")}xxxxxxxx`,
      activities: DEFAULT_ACTIVITIES,
    }),
  );
  const now = Date.now();
  created.runtime.apply({ type: "open" }, now);
  created.runtime.apply({ type: "start" }, now);
  created.runtime.apply({ type: "join", pid: "p1", nickname: "Priya" }, now);
  created.runtime.apply({ type: "join", pid: "p2", nickname: "Lee, the host" }, now);
  created.runtime.apply(
    { type: "setScore", activityId: "trivia", pid: "p1", raw: 18400 },
    now,
  );
  created.runtime.apply(
    { type: "setScore", activityId: "trivia", pid: "p2", raw: 9200 },
    now,
  );
  created.runtime.apply(
    { type: "grantSpot", pid: "p2", activityId: "trivia", reason: "best question" },
    now,
  );
  return created;
}

const get = (path: string, token?: string): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

describe("GET /api/sessions/:sid/export.csv", () => {
  it("returns the scoresheet to the host", async () => {
    const s = makeSession();
    const res = await get(`/api/sessions/${s.runtime.state.sid}/export.csv`, s.hostToken);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/csv/);
    assert.match(
      res.headers.get("content-disposition") ?? "",
      /attachment; filename="export-\d+-scores\.csv"/,
    );

    const lines = (await res.text()).trimEnd().split("\r\n");
    assert.equal(
      lines[0],
      "Name,Trivia Raw,Trivia Pts,Hashi Arcade Raw,Hashi Arcade Pts,Spot Awards,TOTAL",
    );
    assert.equal(lines[1], "Priya,18400,100,,,0,100");
    // A comma in a nickname is quoted rather than shifting every column right.
    assert.equal(lines[2], '"Lee, the host",9200,50,,,10,60');
  });

  it("refuses with no token", async () => {
    const s = makeSession();
    const res = await get(`/api/sessions/${s.runtime.state.sid}/export.csv`);
    assert.equal(res.status, 401);
  });

  it("refuses the wrong session's host token", async () => {
    const a = makeSession();
    const b = makeSession();
    const res = await get(`/api/sessions/${a.runtime.state.sid}/export.csv`, b.hostToken);
    assert.equal(res.status, 401);
  });

  it("refuses the screen token — view-only means view-only", async () => {
    const s = makeSession();
    const res = await get(
      `/api/sessions/${s.runtime.state.sid}/export.csv`,
      s.screenToken,
    );
    assert.equal(res.status, 401);
  });

  it("answers an unknown session the same way as a bad token", async () => {
    const res = await get("/api/sessions/ses_nope/export.csv", "not-a-token");
    assert.equal(res.status, 401);
  });

  it("exports a session that has been closed", async () => {
    const s = makeSession();
    s.runtime.apply({ type: "close" }, Date.now());
    const res = await get(`/api/sessions/${s.runtime.state.sid}/export.csv`, s.hostToken);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Priya/);
  });
});

describe("GET /api/sessions/:sid/events.jsonl", () => {
  it("returns the log, one object per line, in seq order", async () => {
    const s = makeSession();
    await persister.drain();
    const res = await get(
      `/api/sessions/${s.runtime.state.sid}/events.jsonl`,
      s.hostToken,
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /ndjson/);

    const lines = (await res.text()).trimEnd().split("\n");
    const parsed = lines.map((l) => JSON.parse(l));
    assert.deepEqual(
      parsed.map((p) => p.seq),
      parsed.map((_, i) => i + 1),
    );
    assert.deepEqual(
      parsed.map((p) => p.type),
      ["open", "start", "join", "join", "setScore", "setScore", "grantSpot"],
    );
    // The detail a dispute is actually settled on.
    const spot = parsed.find((p) => p.type === "grantSpot");
    assert.equal(spot.event.reason, "best question");
    assert.equal(spot.event.pid, "p2");
  });

  it("is host-only too", async () => {
    const s = makeSession();
    const res = await get(`/api/sessions/${s.runtime.state.sid}/events.jsonl`);
    assert.equal(res.status, 401);
  });
});
