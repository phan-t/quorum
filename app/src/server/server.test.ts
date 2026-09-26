/**
 * Server integration tests: the real HTTP + WebSocket process, driven over
 * real sockets, asserted on the raw JSON that crosses the wire.
 *
 * Expected behaviour comes from ARCHITECTURE.md ("WebSocket protocol", "REST
 * endpoints") and SPEC.md ("The three surfaces", "Identity", "Session
 * lifecycle", "Seal and reveal", "What participants see of the standings",
 * "Failure modes that matter at a live event") — not from the server source.
 * Where a test fails, the server is wrong or the spec is ambiguous; the test
 * is left failing and the case is reported, never patched around.
 *
 * The server is started in-process on an ephemeral port (`PORT=0`) so nothing
 * here depends on a fixed port or leaves a process behind. Sessions are mostly
 * created through the exported registry (the REST route is rate-limited to
 * ten an hour, which is fewer than these tests need); the REST route is
 * exercised directly where auth is the thing under test.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";

import { newSession } from "../engine/reducer.ts";
import type { Event, ParticipantId, Question } from "../engine/types.ts";
import { DEFAULT_ACTIVITIES, type SessionRuntime } from "./runtime.ts";
import { HELLO_FAIL_LIMIT } from "./limits.ts";

const ADMIN_KEY = "test-admin-key-" + Math.random().toString(36).slice(2);
process.env["PORT"] = "0";
process.env["QUORUM_TRUST_PROXY"] = "1"; // the suite simulates being behind the ALB
process.env["QUORUM_ADMIN_KEY"] = ADMIN_KEY;

// main.ts listens on import, so the environment above has to be set first.
const { server, registry } = await import("./main.ts");

/* ------------------------------------------------------------------ */
/* Harness                                                              */
/* ------------------------------------------------------------------ */

let port = 0;
let ipCounter = 0;
let codeCounter = 0;

/** Refused reasons the protocol documents for `hello`. */
const DOCUMENTED_REFUSALS = ["nickname_taken", "invalid_nickname", "lobby_locked", "no_such_code", "kicked", "not_joinable"];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Frame {
  readonly raw: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly msg: any;
}

const openConns = new Set<Conn>();

/**
 * One client socket. Every frame that arrives is kept verbatim so a test can
 * assert on exactly what crossed the wire, not on a parsed projection.
 */
class Conn {
  readonly frames: Frame[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  /** Frames below `floor`, and those in `consumed`, have been returned by `next` or skipped by `mark`. */
  private floor = 0;
  private readonly consumed = new Set<number>();
  private wakers: Array<() => void> = [];
  isClosed = false;

  readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      const raw = String(data);
      let msg: unknown = undefined;
      try {
        msg = JSON.parse(raw);
      } catch {
        msg = undefined;
      }
      this.frames.push({ raw, msg });
      const w = this.wakers;
      this.wakers = [];
      for (const fn of w) fn();
    });
    this.closed = new Promise((resolve) => {
      ws.on("close", (code, reason) => {
        this.isClosed = true;
        openConns.delete(this);
        const w = this.wakers;
        this.wakers = [];
        for (const fn of w) fn();
        resolve({ code, reason: reason.toString() });
      });
    });
    ws.on("error", () => {
      /* surfaced through close */
    });
  }

  /**
   * The hello rate limit is per IP and this whole file is one IP, so each
   * socket presents its own address unless a test wants otherwise.
   */
  static async open(ip?: string): Promise<Conn> {
    ipCounter += 1;
    const addr =
      ip ?? `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { "x-forwarded-for": addr },
    });
    const conn = new Conn(ws);
    openConns.add(conn);
    await once(ws, "open");
    return conn;
  }

  sendRaw(data: string | Buffer): void {
    this.ws.send(data);
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Index of the next frame to arrive; use with `since`. Everything already
   * received is treated as consumed, so a following `next`/`expect` only
   * returns frames that arrive after this point.
   */
  mark(): number {
    this.floor = this.frames.length;
    this.consumed.clear();
    return this.frames.length;
  }

  since(mark: number): Frame[] {
    return this.frames.slice(mark);
  }

  /** Every frame received so far of the given type. */
  all(t: string): Frame[] {
    return this.frames.filter((f) => f.msg?.t === t);
  }

  latest(t: string): Frame | undefined {
    for (let i = this.frames.length - 1; i >= 0; i -= 1) {
      const f = this.frames[i];
      if (f && f.msg?.t === t) return f;
    }
    return undefined;
  }

  /**
   * The earliest unconsumed frame matching `pred`. Only the returned frame is
   * consumed: frames skipped over stay available to a later `next`, because
   * the server may broadcast a `state` before it sends the `ack` for the
   * command that caused it, and a test wants both.
   */
  async next(pred: (f: Frame) => boolean, ms = 2000): Promise<Frame> {
    const deadline = Date.now() + ms;
    for (;;) {
      for (let i = this.floor; i < this.frames.length; i += 1) {
        if (this.consumed.has(i)) continue;
        const f = this.frames[i]!;
        if (pred(f)) {
          this.consumed.add(i);
          return f;
        }
      }
      if (this.isClosed) {
        throw new Error(`socket closed before a matching frame arrived`);
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        const seen = this.frames
          .slice(this.floor)
          .filter((_, i) => !this.consumed.has(i + this.floor))
          .map((f) => f.msg?.t ?? f.raw);
        throw new Error(`timed out waiting for frame; unconsumed: ${JSON.stringify(seen)}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.wakers.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  expect(t: string, ms?: number): Promise<Frame> {
    return this.next((f) => f.msg?.t === t, ms);
  }

  /** True when a frame of type `t` arrives within `ms`, false otherwise. */
  async arrives(t: string, ms = 500): Promise<boolean> {
    try {
      await this.next((f) => f.msg?.t === t, ms);
      return true;
    } catch {
      return false;
    }
  }

  async waitClosed(ms = 2000): Promise<{ code: number; reason: string } | null> {
    const result = await Promise.race([this.closed, sleep(ms).then(() => null)]);
    return result;
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.ws.close();
    await this.waitClosed(1000);
    if (!this.isClosed) this.ws.terminate();
  }
}

interface TestSession {
  readonly runtime: SessionRuntime;
  readonly hostToken: string;
  readonly screenToken: string;
  readonly joinCode: string;
}

function makeSession(phase: "draft" | "lobby" | "running" = "running"): TestSession {
  codeCounter += 1;
  const joinCode = `T${String(codeCounter).padStart(3, "0")}`;
  const created = registry.add(
    newSession({
      sid: `ses_test_${codeCounter}`,
      title: `Test ${codeCounter}`,
      joinCode,
      activities: DEFAULT_ACTIVITIES,
    }),
  );
  if (phase !== "draft") created.runtime.apply({ type: "open" }, Date.now());
  if (phase === "running") created.runtime.apply({ type: "start" }, Date.now());
  return { ...created, joinCode };
}

/** Apply an engine event directly, for scores and other setup the Phase 1 protocol has no command for. */
function applyEvent(s: TestSession, event: Event): void {
  const out = s.runtime.apply(event, Date.now());
  assert.equal(out.rejection, undefined, `setup event rejected: ${JSON.stringify(out)}`);
}

interface Joined {
  readonly conn: Conn;
  readonly pid: ParticipantId;
  readonly rejoinToken: string;
  readonly welcome: Frame;
  readonly state: Frame;
}

/** Send a participant hello and return whichever of welcome/refused comes back. */
async function hello(
  joinCode: string,
  nickname: string,
  rejoinToken?: string,
  ip?: string,
): Promise<{ conn: Conn; reply: Frame }> {
  const conn = await Conn.open(ip);
  conn.send({
    t: "hello",
    role: "participant",
    joinCode,
    nickname,
    ...(rejoinToken ? { rejoinToken } : {}),
  });
  const reply = await conn.next((f) => f.msg?.t === "welcome" || f.msg?.t === "refused");
  return { conn, reply };
}

async function join(joinCode: string, nickname: string, rejoinToken?: string): Promise<Joined> {
  const { conn, reply } = await hello(joinCode, nickname, rejoinToken);
  assert.equal(reply.msg.t, "welcome", `expected welcome for ${JSON.stringify(nickname)}, got ${reply.raw}`);
  const state = await conn.expect("state");
  return {
    conn,
    pid: reply.msg.pid,
    rejoinToken: reply.msg.rejoinToken,
    welcome: reply,
    state,
  };
}

async function refusedJoin(joinCode: string, nickname: string, rejoinToken?: string): Promise<Frame> {
  const { conn, reply } = await hello(joinCode, nickname, rejoinToken);
  assert.equal(reply.msg.t, "refused", `expected refusal for ${JSON.stringify(nickname)}, got ${reply.raw}`);
  await conn.waitClosed(1000);
  return reply;
}

async function connectHost(s: TestSession): Promise<Conn> {
  const conn = await Conn.open();
  conn.send({ t: "hello", role: "host", hostToken: s.hostToken });
  const w = await conn.expect("welcome");
  assert.equal(w.msg.role, "host");
  await conn.expect("state");
  return conn;
}

async function connectScreen(s: TestSession): Promise<Conn> {
  const conn = await Conn.open();
  conn.send({ t: "hello", role: "screen", screenToken: s.screenToken });
  const w = await conn.expect("welcome");
  assert.equal(w.msg.role, "screen");
  await conn.expect("state");
  return conn;
}

let cidCounter = 0;

/** Send a host command and wait for the ack or refusal that carries its cid. */
async function cmd(host: Conn, command: Record<string, unknown>, ms = 2000): Promise<Frame> {
  cidCounter += 1;
  const cid = `c${cidCounter}`;
  host.send({ t: "host.cmd", cid, cmd: command });
  return host.next((f) => (f.msg?.t === "ack" || f.msg?.t === "refusedCmd") && f.msg.cid === cid, ms);
}

async function ackOk(host: Conn, command: Record<string, unknown>): Promise<Frame> {
  const f = await cmd(host, command);
  assert.equal(f.msg.t, "ack", `expected ack for ${JSON.stringify(command)}, got ${f.raw}`);
  return f;
}

/** Every key name appearing anywhere in a JSON value. */
function keysDeep(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) {
    for (const x of v) keysDeep(x, out);
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out.add(k);
      keysDeep(x, out);
    }
  }
  return out;
}

/** What a participant-facing frame must never carry while sealed. */
function sealLeaks(f: Frame): string[] {
  const leaks: string[] = [];
  const keys = keysDeep(f.msg);
  if (keys.has("own")) leaks.push("carries `own`");
  if (keys.has("total")) leaks.push("carries a `total`");
  if (Array.isArray(f.msg?.state?.standings) && f.msg.state.standings.length > 0) {
    leaks.push(`state.standings has ${f.msg.state.standings.length} rows`);
  }
  if (Array.isArray(f.msg?.standings) && f.msg.standings.length > 0) {
    leaks.push(`standings has ${f.msg.standings.length} rows`);
  }
  if (f.msg?.state?.seal !== undefined && f.msg.state.seal !== "sealed") {
    leaks.push(`state.seal is ${f.msg.state.seal}`);
  }
  return leaks;
}

function assertNoSealLeak(frames: Frame[], who: string): void {
  const bad = frames
    .map((f) => ({ f, leaks: sealLeaks(f) }))
    .filter((x) => x.leaks.length > 0);
  assert.equal(
    bad.length,
    0,
    `${who} received ${bad.length} frame(s) leaking standings while sealed:\n` +
      bad.map((x) => `  ${x.leaks.join(", ")}: ${x.f.raw}`).join("\n"),
  );
}

async function post(path: string, body: unknown, bearer?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer !== undefined ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------------------ */
/* Lifecycle of the server itself                                       */
/* ------------------------------------------------------------------ */

before(async () => {
  if (!server.listening) await once(server, "listening");
  port = (server.address() as AddressInfo).port;
  assert.ok(port > 0, "server should be on an ephemeral port");
});

after(async () => {
  for (const c of [...openConns]) c.ws.terminate();
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/* ------------------------------------------------------------------ */
/* Connection and identity                                              */
/* ------------------------------------------------------------------ */

describe("connection and identity", () => {
  it("participant hello with a good code gets welcome (pid, rejoinToken, sid, serverTime) then a full state", async () => {
    const s = makeSession("lobby");
    const p = await join(s.joinCode, "Kenji");
    assert.equal(p.welcome.msg.sid, s.runtime.state.sid);
    assert.equal(typeof p.welcome.msg.pid, "string");
    assert.equal(typeof p.welcome.msg.rejoinToken, "string");
    assert.equal(typeof p.welcome.msg.serverTime, "number");
    assert.equal(p.state.msg.state.phase, "lobby");
    assert.equal(p.state.msg.state.segment, "lobby");
    assert.equal(typeof p.state.msg.seq, "number");
    const me = p.state.msg.state.roster.find((r: { pid: string }) => r.pid === p.pid);
    assert.ok(me, "joiner appears in their own roster");
    assert.equal(me.nickname, "Kenji");
    assert.equal(me.playerNumber, 1);
    assert.equal(me.conn, "on");
    await p.conn.close();
  });

  it("join codes ignore surrounding whitespace, because they arrive pasted from chat", async () => {
    const s = makeSession("lobby");
    const p = await join(`  ${s.joinCode}  `, "Kenji");
    assert.equal(p.welcome.msg.sid, s.runtime.state.sid);
    await p.conn.close();
  });

  // Case matters now. The codes were words and folded to upper case; they are
  // base62 tokens, so folding would map distinct codes onto each other and
  // silently break every link.
  it("join codes are case-sensitive", async () => {
    const s = makeSession("lobby");
    const flipped = [...s.joinCode]
      .map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
      .join("");
    assert.notEqual(flipped, s.joinCode, "the code should contain letters");
    const r = await refusedJoin(flipped, "Kenji");
    assert.equal(r.msg.reason, "no_such_code");
  });

  // Via the API, because makeSession mints its own fixture code and would be
  // testing the helper rather than the generator.
  it("a minted join code looks like a Vault token", async () => {
    const res = await post("/api/sessions", { title: "Shape" }, ADMIN_KEY);
    assert.equal(res.status, 201);
    const created = (await res.json()) as { joinCode: string };
    assert.match(created.joinCode, /^hvs\.[0-9A-Za-z]{24}$/);
  });

  it("hello with an unknown code is refused with no_such_code and the socket is closed", async () => {
    const { conn, reply } = await hello("ZZZZ", "Kenji");
    assert.equal(reply.msg.t, "refused");
    assert.equal(reply.msg.reason, "no_such_code");
    assert.equal(typeof reply.msg.message, "string");
    const closed = await conn.waitClosed();
    assert.ok(closed, "socket should be closed after a refusal");
  });

  it("hello as host with a bad token is refused and never sees state", async () => {
    makeSession("lobby");
    const conn = await Conn.open();
    conn.send({ t: "hello", role: "host", hostToken: "NOTAREALTOKENAAAAAAAAAAAAA" });
    const reply = await conn.next((f) => f.msg?.t === "welcome" || f.msg?.t === "refused");
    assert.equal(reply.msg.t, "refused");
    assert.equal(reply.msg.reason, "bad_token");
    assert.equal(conn.all("state").length, 0);
    assert.ok(await conn.waitClosed());
  });

  it("hello as screen with a bad token is refused and never sees state", async () => {
    makeSession("lobby");
    const conn = await Conn.open();
    conn.send({ t: "hello", role: "screen", screenToken: "" });
    const reply = await conn.next((f) => f.msg?.t === "welcome" || f.msg?.t === "refused");
    assert.equal(reply.msg.t, "refused");
    assert.equal(conn.all("state").length, 0);
    assert.ok(await conn.waitClosed());
  });

  it("host and screen tokens are not interchangeable", async () => {
    const s = makeSession("lobby");
    const a = await Conn.open();
    a.send({ t: "hello", role: "host", hostToken: s.screenToken });
    const ra = await a.next((f) => f.msg?.t === "welcome" || f.msg?.t === "refused");
    assert.equal(ra.msg.t, "refused", "screen token must not open a host session");

    const b = await Conn.open();
    b.send({ t: "hello", role: "screen", screenToken: s.hostToken });
    const rb = await b.next((f) => f.msg?.t === "welcome" || f.msg?.t === "refused");
    assert.equal(rb.msg.t, "refused", "host token must not open a screen session");
    await a.close();
    await b.close();
  });

  it("a host token from one session does not open another session", async () => {
    const s1 = makeSession("lobby");
    const s2 = makeSession("lobby");
    const conn = await Conn.open();
    conn.send({ t: "hello", role: "host", hostToken: s1.hostToken });
    const w = await conn.expect("welcome");
    assert.equal(w.msg.sid, s1.runtime.state.sid);
    assert.notEqual(w.msg.sid, s2.runtime.state.sid);
    await conn.close();
  });

  it("a socket that never sends hello is closed by the server", { timeout: 15_000 }, async () => {
    const conn = await Conn.open();
    const closed = await conn.waitClosed(12_000);
    assert.ok(closed, "server should close a silent socket");
  });

  it("malformed frames before hello are ignored, never treated as a hello, and do not crash the server", async () => {
    const s = makeSession("lobby");
    const bad: Array<string | Buffer> = [
      "not json at all",
      "[1,2,3]",
      "null",
      '"a string"',
      "42",
      "{}",
      '{"t":"nope"}',
      '{"t":{"x":1}}',
      '{"t":"hello"}',
      '{"t":"hello","role":"participant"}',
      `{"t":"hello","role":"participant","joinCode":"${s.joinCode}"}`,
      `{"t":"hello","role":"participant","joinCode":"${s.joinCode}","nickname":123}`,
      `{"t":"hello","role":"participant","joinCode":["${s.joinCode}"],"nickname":"Kenji"}`,
      '{"t":"hello","role":"host"}',
      '{"t":"hello","role":"host","hostToken":null}',
      '{"t":"hello","role":"admin","hostToken":"x"}',
      '{"t":"ping"}',
      '{"t":"ping","t0":"now"}',
      '{"t":"resync"}',
      '{"t":"host.cmd"}',
      '{"t":"host.cmd","cid":"c1","cmd":"open"}',
      '{"t":"host.cmd","cid":"c1","cmd":{"name":"open"}}',
      '{"__proto__":{"t":"resync"}}',
      Buffer.from([0x00, 0xff, 0xfe, 0x01]),
      "{".repeat(5000),
    ];
    const conn = await Conn.open();
    for (const frame of bad) conn.sendRaw(frame);
    await sleep(300);
    assert.equal(conn.all("welcome").length, 0, "no malformed frame may produce a welcome");
    assert.equal(conn.all("state").length, 0, "no malformed frame may produce a state");
    assert.equal(conn.all("pong").length, 0, "ping before hello should not be answered as a session frame");

    // The server is still healthy and still takes real connections.
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    const p = await join(s.joinCode, "Kenji");
    await p.conn.close();
    await conn.close();
  });

  it("an oversized frame closes only that socket; the server survives", async () => {
    const s = makeSession("lobby");
    const p = await join(s.joinCode, "Kenji");
    const big = await Conn.open();
    big.sendRaw("x".repeat(200_000));
    await big.waitClosed(2000);
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    p.conn.send({ t: "ping", t0: 1 });
    const pong = await p.conn.expect("pong");
    assert.equal(pong.msg.t0, 1);
    await p.conn.close();
    await big.close();
  });

  it("malformed frames after hello are ignored and the session continues", async () => {
    const s = makeSession("running");
    const p = await join(s.joinCode, "Kenji");
    for (const frame of ["garbage", "[]", '{"t":"ping","t0":null}', '{"t":"host.cmd","cid":1,"cmd":{"name":"close"}}']) {
      p.conn.sendRaw(frame);
    }
    p.conn.send({ t: "ping", t0: 77 });
    const pong = await p.conn.expect("pong");
    assert.equal(pong.msg.t0, 77);
    assert.equal(s.runtime.state.phase, "running", "a malformed host.cmd from a participant must not close the session");
    await p.conn.close();
  });

  it("a second hello on an already-identified socket does not change its role", async () => {
    const s = makeSession("running");
    const p = await join(s.joinCode, "Kenji");
    p.conn.send({ t: "hello", role: "host", hostToken: s.hostToken });
    await sleep(200);
    assert.equal(p.conn.all("welcome").length, 1, "only one welcome per socket");
    const r = await cmd(p.conn, { name: "segment", kind: "final" });
    assert.equal(r.msg.t, "refusedCmd", "the socket must still be a participant");
    assert.notEqual(s.runtime.state.segment, "final");
    await p.conn.close();
  });

  it("rejoin with the rejoinToken restores the same pid and player number", async () => {
    const s = makeSession("running");
    const first = await join(s.joinCode, "Kenji");
    const second = await join(s.joinCode, "Priya");
    await first.conn.close();
    await sleep(100);

    const back = await join(s.joinCode, "Kenji", first.rejoinToken);
    assert.equal(back.pid, first.pid, "rejoin must restore the original pid");
    const me = back.state.msg.state.roster.find((r: { pid: string }) => r.pid === first.pid);
    assert.equal(me.playerNumber, 1, "player number survives a rejoin");
    assert.equal(me.conn, "on");
    const roster = back.state.msg.state.roster;
    assert.equal(roster.length, 2, "a rejoin must not create a second participant");
    await back.conn.close();
    await second.conn.close();
  });

  it("rejoin works while the lobby is locked", async () => {
    const s = makeSession("running");
    const p = await join(s.joinCode, "Kenji");
    await p.conn.close();
    applyEvent(s, { type: "setJoinsLocked", locked: true });
    const back = await join(s.joinCode, "Kenji", p.rejoinToken);
    assert.equal(back.pid, p.pid);
    await back.conn.close();
  });

  it("a bogus rejoin token gets a fresh identity, not someone else's", async () => {
    const s = makeSession("running");
    const kenji = await join(s.joinCode, "Kenji");
    const imp = await join(s.joinCode, "Mallory", "ZZZZZZZZZZZZZZZZZZZZZZZZZZ");
    assert.notEqual(imp.pid, kenji.pid);
    const roster = imp.state.msg.state.roster;
    assert.equal(roster.length, 2);
    assert.equal(roster.find((r: { pid: string }) => r.pid === imp.pid).playerNumber, 2);
    await kenji.conn.close();
    await imp.conn.close();
  });

  it("a bogus rejoin token plus a connected participant's nickname is refused, not a takeover", async () => {
    const s = makeSession("running");
    const kenji = await join(s.joinCode, "Kenji");
    const mark = kenji.conn.mark();
    const refusal = await refusedJoin(s.joinCode, "Kenji", "ZZZZZZZZZZZZZZZZZZZZZZZZZZ");
    assert.equal(refusal.msg.reason, "nickname_taken");
    assert.ok(!kenji.conn.isClosed, "the incumbent keeps their socket");
    assert.equal(kenji.conn.since(mark).filter((f) => f.msg?.t === "refused").length, 0);
    await kenji.conn.close();
  });

  it("a valid rejoin token cannot claim another connected participant's nickname", async () => {
    const s = makeSession("running");
    const kenji = await join(s.joinCode, "Kenji");
    const priya = await join(s.joinCode, "Priya");
    await priya.conn.close();
    await sleep(100);
    const { conn, reply } = await hello(s.joinCode, "Kenji", priya.rejoinToken);
    assert.equal(reply.msg.t, "refused", "Priya's token must not become Kenji");
    assert.equal(reply.msg.reason, "nickname_taken");
    assert.equal(s.runtime.state.participants[kenji.pid]?.nickname, "Kenji");
    await conn.close();
    await kenji.conn.close();
  });

  it("rejoining with the token but a different nickname keeps the participant's nickname (rename is host-only)", async () => {
    // SPEC.md "Kick and rename. Host-only." A phone that reloads sends its
    // token; the token is the identity. If the wire nickname could differ
    // and win, a participant could undo a host rename by reloading.
    const s = makeSession("running");
    const kenji = await join(s.joinCode, "Kenji");
    await kenji.conn.close();
    await sleep(100);
    const back = await join(s.joinCode, "asdf", kenji.rejoinToken);
    assert.equal(back.pid, kenji.pid);
    const me = back.state.msg.state.roster.find((r: { pid: string }) => r.pid === kenji.pid);
    assert.equal(me.nickname, "Kenji", "a rejoin must not rename the participant");
    await back.conn.close();
  });

  it("duplicate nickname is refused with nickname_taken, and the refusal goes to the joiner not the incumbent", async () => {
    const s = makeSession("running");
    const kenji = await join(s.joinCode, "Kenji");
    const mark = kenji.conn.mark();
    for (const dup of ["Kenji", "kenji", "KENJI", "Kenji ", "  kenji  "]) {
      const refusal = await refusedJoin(s.joinCode, dup);
      assert.equal(refusal.msg.reason, "nickname_taken", `expected nickname_taken for ${JSON.stringify(dup)}`);
      assert.equal(typeof refusal.msg.message, "string");
      assert.match(refusal.msg.message, /release/i, "the message should explain the release flow");
    }
    await sleep(100);
    const incumbent = kenji.conn.since(mark);
    assert.equal(incumbent.filter((f) => f.msg?.t === "refused").length, 0, "the incumbent must not be refused");
    assert.ok(!kenji.conn.isClosed, "the incumbent must stay connected");
    assert.equal(Object.keys(s.runtime.state.participants).length, 1);
    await kenji.conn.close();
  });

  it("two sockets joining with the same nickname at the same instant: exactly one is admitted", async () => {
    const s = makeSession("running");
    const a = await Conn.open();
    const b = await Conn.open();
    a.send({ t: "hello", role: "participant", joinCode: s.joinCode, nickname: "Kenji" });
    b.send({ t: "hello", role: "participant", joinCode: s.joinCode, nickname: "Kenji" });
    const [ra, rb] = await Promise.all([
      a.next((f) => f.msg?.t === "welcome" || f.msg?.t === "refused"),
      b.next((f) => f.msg?.t === "welcome" || f.msg?.t === "refused"),
    ]);
    const outcomes = [ra.msg.t, rb.msg.t].sort();
    assert.deepEqual(outcomes, ["refused", "welcome"]);
    const refused = ra.msg.t === "refused" ? ra : rb;
    assert.equal(refused.msg.reason, "nickname_taken");
    assert.equal(Object.keys(s.runtime.state.participants).length, 1);
    await a.close();
    await b.close();
  });

  it("canonically-equivalent nicknames (NFC vs NFD) are the same person", async () => {
    const s = makeSession("running");
    const jose = await join(s.joinCode, "José");
    const refusal = await refusedJoin(s.joinCode, "José");
    assert.equal(refusal.msg.reason, "nickname_taken");
    await jose.conn.close();
  });

  it("non-Latin nicknames are accepted and delivered exactly", async () => {
    const s = makeSession("running");
    const names = ["こうた", "प्रिया", "李雷", "Zoë", "Øyvind", "김민준", "أحمد"];
    const joined: Joined[] = [];
    for (const name of names) {
      const p = await join(s.joinCode, name);
      joined.push(p);
      const me = p.state.msg.state.roster.find((r: { pid: string }) => r.pid === p.pid);
      assert.equal(me.nickname, name, `nickname ${name} must come back byte-identical`);
      assert.ok(p.state.raw.includes(JSON.stringify(name)), "raw frame carries the nickname as sent");
    }
    // And they are distinct people: second こうた is refused, not admitted.
    const dup = await refusedJoin(s.joinCode, "こうた");
    assert.equal(dup.msg.reason, "nickname_taken");
    for (const p of joined) await p.conn.close();
  });

  it("a nickname shorter than two characters is refused", async () => {
    const s = makeSession("running");
    for (const bad of ["K", " K ", "", "   ", "​​"]) {
      const { conn, reply } = await hello(s.joinCode, bad);
      assert.equal(reply.msg.t, "refused", `expected refusal for ${JSON.stringify(bad)}`);
      await conn.close();
    }
    assert.equal(Object.keys(s.runtime.state.participants).length, 0);
  });

  it("nicknames are at most 24 characters on the wire", async () => {
    const s = makeSession("running");
    const ok24 = "あ".repeat(24);
    const p = await join(s.joinCode, ok24);
    assert.equal(p.state.msg.state.roster[0].nickname, ok24);

    const too25 = "x".repeat(25);
    const { conn, reply } = await hello(s.joinCode, too25);
    if (reply.msg.t === "welcome") {
      const st = await conn.expect("state");
      const me = st.msg.state.roster.find((r: { pid: string }) => r.pid === reply.msg.pid);
      assert.ok([...me.nickname].length <= 24, `delivered nickname must be ≤ 24 chars, got ${[...me.nickname].length}`);
    } else {
      assert.equal(reply.msg.t, "refused");
    }
    // 24 ligature code points that expand to 48 under NFKD: accepted as 24, or refused — but never > 24 delivered.
    const lig = "ﬁ".repeat(24);
    const r2 = await hello(s.joinCode, lig);
    if (r2.reply.msg.t === "welcome") {
      const st = await r2.conn.expect("state");
      const me = st.msg.state.roster.find((r: { pid: string }) => r.pid === r2.reply.msg.pid);
      assert.ok([...me.nickname].length <= 24);
    }
    const r3 = await hello(s.joinCode, "fi".repeat(24));
    assert.equal(r3.reply.msg.t, "refused", "48 characters is over the limit");
    await conn.close();
    await r2.conn.close();
    await r3.conn.close();
    await p.conn.close();
  });

  it("control characters are stripped from nicknames before they reach anyone", async () => {
    const s = makeSession("running");
    const inputs = ["Kenji", "Ken\tji", "Kenji ", "Ke\nnji", "Priya", "Zoe"];
    const others: Conn[] = [];
    for (const input of inputs) {
      const { conn, reply } = await hello(s.joinCode, input);
      others.push(conn);
      if (reply.msg.t !== "welcome") continue; // refusing is also acceptable
      const st = await conn.expect("state");
      const me = st.msg.state.roster.find((r: { pid: string }) => r.pid === reply.msg.pid);
      assert.doesNotMatch(
        me.nickname,
        /\p{Cc}/u,
        `nickname ${JSON.stringify(input)} was delivered with a control character: ${JSON.stringify(me.nickname)}`,
      );
    }
    for (const c of others) await c.close();
  });

  it("a nickname that is too short once control characters are stripped is not admitted", async () => {
    const s = makeSession("running");
    const { conn, reply } = await hello(s.joinCode, "K");
    if (reply.msg.t === "welcome") {
      const st = await conn.expect("state");
      const me = st.msg.state.roster.find((r: { pid: string }) => r.pid === reply.msg.pid);
      assert.doesNotMatch(me.nickname, /\p{Cc}/u);
      assert.ok([...me.nickname].length >= 2, `delivered nickname ${JSON.stringify(me.nickname)} is under the two-character minimum`);
    }
    await conn.close();
  });

  it("an HTML payload as a nickname is delivered as the exact text, neither escaped nor altered", async () => {
    const s = makeSession("running");
    const html = "<b>hi</b>";
    const p = await join(s.joinCode, html);
    const me = p.state.msg.state.roster.find((r: { pid: string }) => r.pid === p.pid);
    assert.equal(me.nickname, html);
    assert.ok(p.state.raw.includes(JSON.stringify(html)));
    const amp = await join(s.joinCode, "Tom&amp;Jerry");
    const me2 = amp.state.msg.state.roster.find((r: { pid: string }) => r.pid === amp.pid);
    assert.equal(me2.nickname, "Tom&amp;Jerry", "entities are not decoded");
    await p.conn.close();
    await amp.conn.close();
  });

  it("surrounding whitespace is trimmed from the delivered nickname", async () => {
    const s = makeSession("running");
    const p = await join(s.joinCode, "   Kenji   ");
    const me = p.state.msg.state.roster.find((r: { pid: string }) => r.pid === p.pid);
    assert.equal(me.nickname, "Kenji");
    await p.conn.close();
  });

  it("refused reasons on the wire are the ones the protocol documents", async () => {
    const draft = makeSession("draft");
    const seen: Record<string, string> = {};
    seen["join before open"] = (await refusedJoin(draft.joinCode, "Kenji")).msg.reason;

    const closed = makeSession("running");
    applyEvent(closed, { type: "close" });
    seen["join after close"] = (await refusedJoin(closed.joinCode, "Kenji")).msg.reason;

    const running = makeSession("running");
    seen["one-character nickname"] = (await refusedJoin(running.joinCode, "K")).msg.reason;

    const undocumented = Object.entries(seen).filter(([, r]) => !DOCUMENTED_REFUSALS.includes(r));
    assert.deepEqual(
      undocumented,
      [],
      `refused reasons not in the protocol's list (${DOCUMENTED_REFUSALS.join(", ")}): ${JSON.stringify(seen)}`,
    );
  });

  /**
   * This used to assert the eleventh hello from one address was refused,
   * which is what the service did and was wrong: a team joining from one
   * office shares a public IP, so the limit refused the room rather than an
   * attacker. See limits.ts. The arithmetic is pinned in hello-limit.test.ts;
   * what matters here is that it holds over a real socket.
   */
  it("lets a room join from one address, and shuts out a bad code quickly", async () => {
    const s = makeSession("running");
    const ip = "203.0.113.77";
    const conns: Conn[] = [];
    // Well past the old ceiling of ten, from one address, all admitted.
    for (let i = 1; i <= 20; i += 1) {
      const { conn, reply } = await hello(s.joinCode, `Bot${i}`, undefined, ip);
      conns.push(conn);
      assert.equal(reply.msg.t, "welcome", `hello #${i} from one address should be admitted`);
      await conn.expect("state");
    }

    // A different address, failing: locked out after a handful, while the
    // room above stays connected.
    const badIp = "203.0.113.99";
    for (let i = 1; i <= HELLO_FAIL_LIMIT; i += 1) {
      const { conn, reply } = await hello("hvs.notacodeatall", `Bad${i}`, undefined, badIp);
      assert.equal(reply.msg.t, "refused", `bad code #${i} should be a plain refusal`);
      await conn.close();
    }
    const { conn: after, reply: afterReply } = await hello(
      s.joinCode,
      "BadLast",
      undefined,
      badIp,
    );
    assert.equal(afterReply.msg.t, "refused", "a failing address is shut out");
    assert.equal(
      (afterReply.msg as { reason?: string }).reason,
      "rate_limited",
      "and shut out for the rate limit, not the code",
    );
    await after.close();
    for (const c of conns) await c.close();
  });
});

/* ------------------------------------------------------------------ */
/* The seal                                                             */
/* ------------------------------------------------------------------ */

describe("seal", () => {
  async function sealedFixture(): Promise<{
    s: TestSession;
    host: Conn;
    screen: Conn;
    kenji: Joined;
    priya: Joined;
  }> {
    const s = makeSession("running");
    const host = await connectHost(s);
    const screen = await connectScreen(s);
    const kenji = await join(s.joinCode, "Kenji");
    const priya = await join(s.joinCode, "Priya");
    applyEvent(s, { type: "setScore", activityId: "trivia", pid: kenji.pid, raw: 900 });
    applyEvent(s, { type: "setScore", activityId: "trivia", pid: priya.pid, raw: 400 });
    applyEvent(s, { type: "setScore", activityId: "arcade", pid: priya.pid, raw: 50 });
    await sleep(150);
    return { s, host, screen, kenji, priya };
  }

  it("before sealing, a participant receives the top five and their own points", async () => {
    const { host, screen, kenji, priya } = await sealedFixture();
    const st = kenji.conn.latest("state")!;
    assert.equal(st.msg.state.seal, "live");
    assert.ok(st.msg.state.standings.length >= 2, "standings should be populated before the seal");
    assert.ok(st.msg.state.own, "own points strip present while live");
    assert.equal(typeof st.msg.state.own.total, "number");
    assert.ok(st.msg.state.own.total > 0);
    assert.equal(st.msg.state.hostExtras, undefined, "a participant never gets host extras");
    for (const c of [host, screen, kenji.conn, priya.conn]) await c.close();
  });

  it("while sealed, nothing that crosses a participant's socket carries standings or own points", async () => {
    const { s, host, screen, kenji, priya } = await sealedFixture();
    const kMark = kenji.conn.mark();
    const pMark = priya.conn.mark();

    const ack = await ackOk(host, { name: "seal", state: "sealed" });
    assert.equal(ack.msg.applied, true);
    await sleep(150);

    // Everything the seal itself produced.
    assertNoSealLeak(kenji.conn.since(kMark), "Kenji (on seal)");
    assertNoSealLeak(priya.conn.since(pMark), "Priya (on seal)");
    assert.ok(kenji.conn.since(kMark).length > 0, "the seal must be announced to participants");
    assert.equal(kenji.conn.latest("state")!.msg.state.seal, "sealed");

    // Scores keep moving under the seal: the last activity is being played.
    const k2 = kenji.conn.mark();
    const p2 = priya.conn.mark();
    applyEvent(s, { type: "setScore", activityId: "arcade", pid: kenji.pid, raw: 12 });
    applyEvent(s, { type: "setScore", activityId: "arcade", pid: priya.pid, raw: 99 });
    applyEvent(s, { type: "grantSpot", pid: priya.pid, activityId: "arcade", reason: "best recovery" });
    await sleep(150);
    assert.ok(kenji.conn.since(k2).length > 0, "score changes should produce frames");
    assertNoSealLeak(kenji.conn.since(k2), "Kenji (scores under seal)");
    assertNoSealLeak(priya.conn.since(p2), "Priya (scores under seal)");

    // An explicit resync must not be a back door.
    const k3 = kenji.conn.mark();
    kenji.conn.send({ t: "resync" });
    const st = await kenji.conn.expect("state");
    assert.equal(st.msg.state.seal, "sealed");
    assertNoSealLeak(kenji.conn.since(k3), "Kenji (resync under seal)");

    // Nor a segment change, nor a fresh join, nor a rejoin.
    const k4 = kenji.conn.mark();
    await ackOk(host, { name: "segment", kind: "standings" });
    await ackOk(host, { name: "segment", kind: "holding" });
    await sleep(100);
    assertNoSealLeak(kenji.conn.since(k4), "Kenji (segment changes under seal)");

    const late = await join(s.joinCode, "Late");
    await sleep(100);
    assertNoSealLeak(late.conn.frames, "late joiner under seal");

    await priya.conn.close();
    await sleep(50);
    const back = await join(s.joinCode, "Priya", priya.rejoinToken);
    await sleep(100);
    assertNoSealLeak(back.conn.frames, "Priya rejoining under seal");

    // The screen is a participant-facing surface too.
    assertNoSealLeak(
      screen.frames.slice(screen.frames.findIndex((f) => f.msg?.state?.seal === "sealed")),
      "screen",
    );

    // Belt and braces: the literal key names never appear in the raw text.
    for (const f of kenji.conn.since(kMark)) {
      assert.ok(!f.raw.includes('"own"'), `raw frame carries "own": ${f.raw}`);
      assert.ok(!f.raw.includes('"total"'), `raw frame carries "total": ${f.raw}`);
    }

    for (const c of [host, screen, kenji.conn, late.conn, back.conn]) await c.close();
  });

  it("while sealed the host still sees the full top five", async () => {
    const { s, host, screen, kenji, priya } = await sealedFixture();
    await ackOk(host, { name: "seal", state: "sealed" });
    await sleep(100);
    const st = host.latest("state")!;
    assert.equal(st.msg.state.seal, "sealed");
    assert.ok(st.msg.state.standings.length >= 2, "host must keep the standings while sealed");
    const names = st.msg.state.standings.map((r: { nickname: string }) => r.nickname);
    assert.ok(names.includes("Kenji") && names.includes("Priya"), `host standings: ${names}`);
    assert.equal(typeof st.msg.state.standings[0].total, "number");
    assert.ok(st.msg.state.hostExtras, "host extras present");
    assert.equal(st.msg.state.hostExtras.joinCode, s.joinCode);

    host.mark();
    host.send({ t: "resync" });
    const again = await host.expect("state");
    assert.ok(again.msg.state.standings.length >= 2, `host resync under seal: ${again.raw}`);
    for (const c of [host, screen, kenji.conn, priya.conn]) await c.close();
  });

  it("unsealing restores standings and own points to participants", async () => {
    const { host, screen, kenji, priya } = await sealedFixture();
    await ackOk(host, { name: "seal", state: "sealed" });
    await sleep(100);
    const mark = kenji.conn.mark();
    await ackOk(host, { name: "seal", state: "live" });
    const st = await kenji.conn.next((f) => f.msg?.t === "state" && f.msg.state.seal === "live");
    assert.ok(st.msg.state.standings.length >= 2, "standings back after unseal");
    assert.ok(st.msg.state.own, "own back after unseal");
    assert.ok(st.msg.state.own.total > 0);
    assert.ok(kenji.conn.since(mark).length > 0);

    // And the reveal state shows the top five too.
    await ackOk(host, { name: "seal", state: "revealed" });
    const rv = await kenji.conn.next((f) => f.msg?.t === "state" && f.msg.state.seal === "revealed");
    assert.ok(rv.msg.state.standings.length >= 2, "revealed shows the top five");
    for (const c of [host, screen, kenji.conn, priya.conn]) await c.close();
  });

  it("closing the session does not leak the full ranking into the final state", async () => {
    const { host, screen, kenji, priya } = await sealedFixture();
    await ackOk(host, { name: "close" });
    const st = await kenji.conn.next((f) => f.msg?.t === "state" && f.msg.state.phase === "closed");
    assert.equal(st.msg.state.segment, "final");
    assert.ok(st.msg.state.standings.length <= 5);
    assert.equal(st.msg.state.hostExtras, undefined);
    for (const c of [host, screen, kenji.conn, priya.conn]) await c.close();
  });
});

/* ------------------------------------------------------------------ */
/* Top five                                                             */
/* ------------------------------------------------------------------ */

describe("top five", () => {
  async function room(n: number): Promise<{ s: TestSession; people: Joined[]; screen: Conn; host: Conn }> {
    const s = makeSession("running");
    const host = await connectHost(s);
    const screen = await connectScreen(s);
    const people: Joined[] = [];
    for (let i = 1; i <= n; i += 1) people.push(await join(s.joinCode, `Player ${String(i).padStart(2, "0")}`));
    return { s, people, screen, host };
  }

  function rowsOf(f: Frame): number {
    return Array.isArray(f.msg?.state?.standings) ? f.msg.state.standings.length : 0;
  }

  it("with 30 participants on distinct scores, no participant or screen frame carries more than five rows", async () => {
    const { s, people, screen, host } = await room(30);
    const marks = people.map((p) => p.conn.mark());
    const screenMark = screen.mark();
    people.forEach((p, i) => applyEvent(s, { type: "setScore", activityId: "trivia", pid: p.pid, raw: 1000 - i * 10 }));
    await sleep(300);

    people.forEach((p, i) => {
      const frames = p.conn.since(marks[i]!).filter((f) => f.msg?.t === "state");
      assert.ok(frames.length > 0);
      for (const f of frames) {
        assert.ok(rowsOf(f) <= 5, `${p.pid} received ${rowsOf(f)} standing rows: ${f.raw}`);
      }
      const last = p.conn.latest("state")!;
      assert.equal(last.msg.state.standings.length, 5, "a full room shows exactly five");
      assert.equal(last.msg.state.standings[0].nickname, "Player 01");
      assert.ok(last.msg.state.own, "everyone still sees their own points");
      assert.equal(typeof last.msg.state.own.total, "number");
      // Their own rank is not on the wire.
      assert.ok(!("rank" in last.msg.state.own), "own points must not carry a rank");
    });
    for (const f of screen.since(screenMark)) assert.ok(rowsOf(f) <= 5, `screen received ${rowsOf(f)} rows`);

    // A resync by the person in last place still gets five, not thirty.
    const last = people[29]!;
    last.conn.send({ t: "resync" });
    const st = await last.conn.expect("state");
    assert.equal(st.msg.state.standings.length, 5);
    assert.ok(!st.msg.state.standings.some((r: { nickname: string }) => r.nickname === "Player 30"));

    for (const p of people) await p.conn.close();
    await screen.close();
    await host.close();
  });

  it("with 30 participants tied (no scores yet), a participant still receives at most five rows", async () => {
    // SPEC.md: "Top five only, never the full ranking ... enforced by the
    // software." A tie at fifth is the common case at the start of every
    // session (everyone on zero) and must not turn into the full roster of
    // standings on every phone.
    const { people, screen, host } = await room(30);
    await sleep(200);
    const worst = Math.max(...people.map((p) => Math.max(...p.conn.all("state").map(rowsOf))));
    assert.ok(worst <= 5, `a participant received ${worst} standing rows while everyone was tied`);
    for (const f of screen.all("state")) assert.ok(rowsOf(f) <= 5, `screen received ${rowsOf(f)} rows`);
    for (const p of people) await p.conn.close();
    await screen.close();
    await host.close();
  });

  it("with 8 participants tied at fifth place, a participant still receives at most five rows", async () => {
    const { s, people, screen, host } = await room(8);
    people.forEach((p, i) => applyEvent(s, { type: "setScore", activityId: "trivia", pid: p.pid, raw: i < 4 ? 1000 - i * 10 : 500 }));
    await sleep(200);
    const worst = Math.max(...people.map((p) => Math.max(...p.conn.all("state").map(rowsOf))));
    assert.ok(worst <= 5, `a participant received ${worst} standing rows with a tie at fifth`);
    for (const p of people) await p.conn.close();
    await screen.close();
    await host.close();
  });
});

/* ------------------------------------------------------------------ */
/* Authorisation                                                        */
/* ------------------------------------------------------------------ */

describe("authorisation", () => {
  it("a participant sending host.cmd is refused with its cid and cannot change the session", async () => {
    const s = makeSession("running");
    const p = await join(s.joinCode, "Kenji");
    const before = s.runtime.state;
    for (const c of [
      { name: "segment", kind: "final" },
      { name: "seal", state: "sealed" },
      { name: "close" },
      { name: "lobby.lock", locked: true },
      { name: "participant.kick", pid: p.pid },
      { name: "holding", title: "x", line: "y" },
    ]) {
      const r = await cmd(p.conn, c);
      assert.equal(r.msg.t, "refusedCmd", `participant must be refused for ${JSON.stringify(c)}`);
      assert.equal(typeof r.msg.code, "string");
      assert.equal(typeof r.msg.message, "string");
    }
    assert.equal(s.runtime.state.seq, before.seq, "no participant command may change the session");
    assert.equal(s.runtime.state.phase, "running");
    assert.equal(s.runtime.state.seal, "live");
    await p.conn.close();
  });

  it("a screen sending host.cmd is refused and cannot change the session", async () => {
    const s = makeSession("running");
    const screen = await connectScreen(s);
    const before = s.runtime.state.seq;
    for (const c of [{ name: "segment", kind: "final" }, { name: "close" }, { name: "seal", state: "sealed" }]) {
      const r = await cmd(screen, c);
      assert.equal(r.msg.t, "refusedCmd");
    }
    assert.equal(s.runtime.state.seq, before);
    assert.equal(s.runtime.state.phase, "running");
    await screen.close();
  });

  it("host.cmd from a socket that never said hello does nothing", async () => {
    const s = makeSession("running");
    const conn = await Conn.open();
    conn.send({ t: "host.cmd", cid: "x1", cmd: { name: "close" } });
    await sleep(200);
    assert.equal(s.runtime.state.phase, "running");
    await conn.close();
  });

  it("POST /api/sessions without a bearer token is 401", async () => {
    const res = await post("/api/sessions", { title: "x" });
    assert.equal(res.status, 401);
  });

  it("POST /api/sessions with a wrong bearer token is 401", async () => {
    const res = await post("/api/sessions", { title: "x" }, "definitely-not-the-key");
    assert.equal(res.status, 401);
    const res2 = await post("/api/sessions", { title: "x" }, ADMIN_KEY + "x");
    assert.equal(res2.status, 401);
    const res3 = await post("/api/sessions", { title: "x" }, "");
    assert.equal(res3.status, 401);
  });

  it("POST /api/sessions with the admin key creates a session and returns the tokens once", async () => {
    const res = await post("/api/sessions", { title: "REST created" }, ADMIN_KEY);
    assert.equal(res.status, 201);
    const body = (await res.json()) as Record<string, string>;
    assert.equal(typeof body["sid"], "string");
    assert.equal(typeof body["joinCode"], "string");
    assert.equal(typeof body["hostToken"], "string");
    assert.equal(typeof body["screenToken"], "string");
    assert.notEqual(body["hostToken"], body["screenToken"]);
    assert.match(body["hostToken"]!, /^[A-Z2-7]{26}$/, "128-bit base32 token");
    assert.ok(registry.bySessionId(body["sid"]!), "session is registered");
    assert.equal(registry.bySessionId(body["sid"]!)!.state.title, "REST created");
  });

  it("a participant's and a screen's state never carry host-only fields", async () => {
    const s = makeSession("running");
    const p = await join(s.joinCode, "Kenji");
    const screen = await connectScreen(s);
    const host = await connectHost(s);
    await sleep(100);
    for (const f of [...p.conn.all("state"), ...screen.all("state")]) {
      assert.equal(f.msg.state.hostExtras, undefined, `host extras leaked: ${f.raw}`);
    }
    // A participant has already used the code and never needs it again. The
    // screen renders it as a QR on the lobby, which is the point of the screen.
    for (const f of p.conn.all("state")) {
      assert.ok(!f.raw.includes(s.joinCode) || f.msg.state.title.includes(s.joinCode), "join code must not reach a participant");
    }
    for (const f of [...screen.all("state"), ...host.all("state")]) {
      assert.equal(f.msg.state.own, undefined, "only participants get an own strip");
    }
    assert.ok(host.latest("state")!.msg.state.hostExtras);
    await p.conn.close();
    await screen.close();
    await host.close();
  });
});

/* ------------------------------------------------------------------ */
/* Lifecycle and commands                                               */
/* ------------------------------------------------------------------ */

describe("lifecycle and commands", () => {
  it("full lifecycle over the wire: draft → lobby → running → closed, with joins refused before open and after close", async () => {
    const res = await post("/api/sessions", { title: "Lifecycle" }, ADMIN_KEY);
    assert.equal(res.status, 201);
    const created = (await res.json()) as { sid: string; joinCode: string; hostToken: string; screenToken: string };
    const runtime = registry.bySessionId(created.sid)!;
    const s: TestSession = { runtime, hostToken: created.hostToken, screenToken: created.screenToken, joinCode: created.joinCode };

    // Draft: the code is not live.
    const early = await refusedJoin(s.joinCode, "Kenji");
    assert.equal(early.msg.t, "refused");

    const host = await connectHost(s);
    assert.equal(host.latest("state")!.msg.state.phase, "draft");

    // start before open is refused with a message.
    const tooSoon = await cmd(host, { name: "start" });
    assert.equal(tooSoon.msg.t, "refusedCmd");
    assert.ok(tooSoon.msg.message.length > 0);

    const opened = await ackOk(host, { name: "open" });
    assert.equal(opened.msg.applied, true);
    assert.equal((await host.expect("state")).msg.state.phase, "lobby");

    const kenji = await join(s.joinCode, "Kenji");
    assert.equal(kenji.state.msg.state.phase, "lobby");

    await ackOk(host, { name: "start" });
    const running = await kenji.conn.next((f) => f.msg?.t === "state" && f.msg.state.phase === "running");
    assert.ok(running);

    // Late join while running lands on the current segment.
    await ackOk(host, { name: "segment", kind: "holding" });
    await sleep(50);
    const late = await join(s.joinCode, "Priya");
    assert.equal(late.state.msg.state.phase, "running");
    assert.equal(late.state.msg.state.segment, "holding");

    await ackOk(host, { name: "close" });
    const closed = await kenji.conn.next((f) => f.msg?.t === "state" && f.msg.state.phase === "closed");
    assert.equal(closed.msg.state.segment, "final");
    assert.ok(!kenji.conn.isClosed, "participants stay connected to screenshot the final standings");

    const tooLate = await refusedJoin(s.joinCode, "Zoe");
    assert.equal(tooLate.msg.t, "refused");

    // A host command after close is refused with its cid.
    const after = await cmd(host, { name: "segment", kind: "lobby" });
    assert.equal(after.msg.t, "refusedCmd");
    assert.equal(typeof after.msg.message, "string");
    assert.equal(runtime.state.phase, "closed");
    assert.equal(runtime.state.segment, "final");

    await host.close();
    await kenji.conn.close();
    await late.conn.close();
  });

  it("start twice is refused with a message, not silently ignored", async () => {
    const s = makeSession("lobby");
    const host = await connectHost(s);
    const first = await ackOk(host, { name: "start" });
    assert.equal(first.msg.applied, true);
    const second = await cmd(host, { name: "start" });
    assert.equal(second.msg.t, "refusedCmd");
    assert.equal(second.msg.cid, first.msg.cid.replace(/\d+$/, (n: string) => String(Number(n) + 1)));
    assert.equal(typeof second.msg.code, "string");
    assert.ok(second.msg.message.length > 0, "refusal explains why");
    await host.close();
  });

  it("open twice is refused with a message", async () => {
    const s = makeSession("lobby");
    const host = await connectHost(s);
    const r = await cmd(host, { name: "open" });
    assert.equal(r.msg.t, "refusedCmd");
    assert.ok(r.msg.message.length > 0);
    await host.close();
  });

  it("every segment is reachable in any order while running, and participants and the screen follow", async () => {
    const s = makeSession("running");
    const host = await connectHost(s);
    const screen = await connectScreen(s);
    const p = await join(s.joinCode, "Kenji");
    const order = ["final", "trivia", "lobby", "arcade", "standings", "holding", "trivia", "final", "lobby"];
    for (const kind of order) {
      p.conn.mark();
      screen.mark();
      const r = await ackOk(host, { name: "segment", kind });
      assert.equal(r.msg.applied, true, `segment ${kind} should apply`);
      const ps = await p.conn.next((f) => f.msg?.t === "state" && f.msg.state.segment === kind);
      assert.equal(ps.msg.state.segment, kind);
      const ss = await screen.next((f) => f.msg?.t === "state" && f.msg.state.segment === kind);
      assert.equal(ss.msg.state.segment, kind);
      assert.equal(s.runtime.state.phase, "running", "segments never change the phase");
    }
    await host.close();
    await screen.close();
    await p.conn.close();
  });

  it("holding card content reaches participants verbatim", async () => {
    const s = makeSession("running");
    const host = await connectHost(s);
    const p = await join(s.joinCode, "Kenji");
    const title = "Agentic Security TTX <script>alert(1)</script>";
    const line = "Ade has the room. Back here at 2:40.";
    await ackOk(host, { name: "holding", title, line });
    const st = await p.conn.next((f) => f.msg?.t === "state" && f.msg.state.holding !== null);
    assert.deepEqual(st.msg.state.holding, { title, line });
    await host.close();
    await p.conn.close();
  });

  it("ack echoes the cid that was sent; a refused command produces refusedCmd with that cid", async () => {
    const s = makeSession("lobby");
    const host = await connectHost(s);
    host.send({ t: "host.cmd", cid: "my-very-own-cid-1", cmd: { name: "start" } });
    const ack = await host.expect("ack");
    assert.equal(ack.msg.cid, "my-very-own-cid-1");
    assert.equal(ack.msg.applied, true);
    host.send({ t: "host.cmd", cid: "my-very-own-cid-2", cmd: { name: "start" } });
    const refused = await host.expect("refusedCmd");
    assert.equal(refused.msg.cid, "my-very-own-cid-2");
    assert.equal(typeof refused.msg.code, "string");
    assert.equal(typeof refused.msg.message, "string");
    await host.close();
  });

  it("a no-op command is acknowledged with applied:false rather than dropped", async () => {
    const s = makeSession("running");
    const host = await connectHost(s);
    const cur = s.runtime.state.segment;
    const r = await cmd(host, { name: "segment", kind: cur });
    assert.equal(r.msg.t, "ack");
    assert.equal(r.msg.applied, false);
    await host.close();
  });

  it("an unrecognised host command is refused with its cid, not silently dropped", async () => {
    // ARCHITECTURE.md: host commands that cannot be applied are "rejected with
    // a refused explaining why, not silently ignored". A cid that never gets a
    // reply leaves the console's optimistic update hanging forever.
    const s = makeSession("running");
    const host = await connectHost(s);
    for (const c of [
      { name: "trivia.open", qid: "q07" },
      { name: "segment", kind: "bogus" },
      { name: "seal", state: "half" },
      { name: "nope" },
      { name: "participant.kick" },
    ]) {
      const r = await cmd(host, c, 800).catch((e: Error) => e);
      assert.ok(
        !(r instanceof Error),
        `host got no reply at all for ${JSON.stringify(c)}: ${r instanceof Error ? r.message : ""}`,
      );
      if (!(r instanceof Error)) assert.equal(r.msg.t, "refusedCmd");
    }
    await host.close();
  });

  it("resync returns a full current state", async () => {
    const s = makeSession("running");
    const host = await connectHost(s);
    const p = await join(s.joinCode, "Kenji");
    await ackOk(host, { name: "segment", kind: "arcade" });
    await ackOk(host, { name: "holding", title: "T", line: "L" });
    await sleep(100);
    const mark = p.conn.mark();
    p.conn.send({ t: "resync" });
    const st = await p.conn.expect("state");
    assert.equal(p.conn.since(mark).length, 1, "resync yields exactly one frame");
    const v = st.msg.state;
    assert.equal(v.sid, s.runtime.state.sid);
    assert.equal(v.phase, "running");
    assert.equal(v.segment, "arcade");
    assert.equal(v.seal, "live");
    assert.deepEqual(v.holding, { title: "T", line: "L" });
    assert.equal(v.joinsLocked, false);
    assert.ok(Array.isArray(v.roster) && v.roster.length === 1);
    assert.ok(Array.isArray(v.standings));
    assert.equal(typeof v.title, "string");
    // seq counts frames sent to THIS client, not engine events. Events only
    // the host hears about (locking the lobby) must not leave a hole in a
    // participant's stream, because the protocol says a hole means resync and
    // thirty phones resyncing over a host toggling a switch is a stampede.
    const seqs = [...p.conn.all("state"), ...p.conn.all("roster")]
      .map((f: { msg: { seq: number } }) => f.msg.seq)
      .sort((a: number, b: number) => a - b);
    assert.deepEqual(
      seqs,
      seqs.map((_: number, i: number) => (seqs[0] ?? 0) + i),
      "a client's frames are consecutive",
    );
    await host.close();
    await p.conn.close();
  });

  it("ping gets a pong echoing t0 with a server t1", async () => {
    const s = makeSession("running");
    const p = await join(s.joinCode, "Kenji");
    const t0 = Date.now() - 12345;
    p.conn.send({ t: "ping", t0 });
    const pong = await p.conn.expect("pong");
    assert.equal(pong.msg.t0, t0);
    assert.equal(typeof pong.msg.t1, "number");
    assert.ok(Math.abs(pong.msg.t1 - Date.now()) < 5000, "t1 is server epoch");
    // Fractional and zero t0 are echoed exactly.
    p.conn.send({ t: "ping", t0: 0.5 });
    assert.equal((await p.conn.expect("pong")).msg.t0, 0.5);
    p.conn.send({ t: "ping", t0: 0 });
    assert.equal((await p.conn.expect("pong")).msg.t0, 0);
    await p.conn.close();
  });

  it("broadcast seq is monotonic on a participant socket", async () => {
    const s = makeSession("running");
    const host = await connectHost(s);
    const p = await join(s.joinCode, "Kenji");
    for (const kind of ["holding", "trivia", "standings"]) await ackOk(host, { name: "segment", kind });
    await ackOk(host, { name: "seal", state: "sealed" });
    await ackOk(host, { name: "seal", state: "live" });
    const other = await join(s.joinCode, "Priya");
    await sleep(100);
    const seqs = p.conn.frames.filter((f) => typeof f.msg?.seq === "number").map((f) => f.msg.seq as number);
    assert.ok(seqs.length >= 6);
    for (let i = 1; i < seqs.length; i += 1) {
      assert.ok(seqs[i]! >= seqs[i - 1]!, `seq went backwards: ${seqs.join(",")}`);
    }
    await host.close();
    await p.conn.close();
    await other.conn.close();
  });

  it("lobby lock refuses new nicknames with lobby_locked but keeps rejoin working", async () => {
    const s = makeSession("running");
    const host = await connectHost(s);
    const kenji = await join(s.joinCode, "Kenji");
    await ackOk(host, { name: "lobby.lock", locked: true });
    await sleep(50);
    const refusal = await refusedJoin(s.joinCode, "Priya");
    assert.equal(refusal.msg.reason, "lobby_locked");
    await kenji.conn.close();
    await sleep(50);
    const back = await join(s.joinCode, "Kenji", kenji.rejoinToken);
    assert.equal(back.pid, kenji.pid);
    await ackOk(host, { name: "lobby.lock", locked: false });
    await sleep(50);
    const priya = await join(s.joinCode, "Priya");
    assert.ok(priya.pid);
    await host.close();
    await back.conn.close();
    await priya.conn.close();
  });

  it("closing a session that is already closed is not an error, and rejects the next command", async () => {
    const s = makeSession("running");
    const host = await connectHost(s);
    await ackOk(host, { name: "close" });
    const again = await cmd(host, { name: "close" });
    assert.ok(again.msg.t === "ack" || again.msg.t === "refusedCmd");
    const seal = await cmd(host, { name: "seal", state: "sealed" });
    assert.equal(seal.msg.t, "refusedCmd");
    assert.equal(s.runtime.state.seal, "revealed", "a closed session's seal is the reveal");
    await host.close();
  });

  it("healthz reports the deploy-freeze signal", async () => {
    const s = makeSession("running");
    const p = await join(s.joinCode, "Kenji");
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body["ok"], true);
    assert.equal(typeof body["sessionsLive"], "number");
    assert.ok((body["sessionsLive"] as number) >= 1);
    assert.equal(typeof body["socketsOpen"], "number");
    assert.ok((body["socketsOpen"] as number) >= 1);
    assert.equal(typeof body["version"], "string");
    await p.conn.close();
  });
});

/* ------------------------------------------------------------------ */
/* Kick and release                                                     */
/* ------------------------------------------------------------------ */

describe("kick and release", () => {
  it("a kicked participant leaves the roster and their socket is disconnected", async () => {
    const s = makeSession("running");
    const host = await connectHost(s);
    const bad = await join(s.joinCode, "asdf");
    const other = await join(s.joinCode, "Kenji");
    await ackOk(host, { name: "participant.kick", pid: bad.pid });
    const st = await other.conn.next((f) => f.msg?.t === "state" && f.msg.state.roster.length === 1);
    assert.equal(st.msg.state.roster[0].nickname, "Kenji");
    const closed = await bad.conn.waitClosed(1500);
    assert.ok(closed, "a kicked participant's socket should be closed");
    await host.close();
    await other.conn.close();
    await bad.conn.close();
  });

  it("a kicked participant cannot come back under the same nickname (refused: kicked)", async () => {
    // SPEC.md: "Kicked participants can rejoin under a different nickname."
    // ARCHITECTURE.md lists `kicked` as a refusal reason. The offensive name
    // must not reappear just because the phone still holds its rejoin token.
    const s = makeSession("running");
    const host = await connectHost(s);
    const bad = await join(s.joinCode, "asdf");
    await ackOk(host, { name: "participant.kick", pid: bad.pid });
    await sleep(50);
    await bad.conn.close();

    const sameName = await hello(s.joinCode, "asdf", bad.rejoinToken);
    assert.equal(sameName.reply.msg.t, "refused", "the kicked nickname must not come back");
    assert.equal(sameName.reply.msg.reason, "kicked");
    await sameName.conn.close();

    // Without their rejoin token, a kicked person is indistinguishable from
    // a colleague who genuinely shares that name. Nickname-only identity
    // cannot tell them apart, so the name is freed rather than burned — the
    // host's tool for a determined troll is locking the lobby, tested below.
    const sameNameNoToken = await hello(s.joinCode, "asdf");
    assert.equal(sameNameNoToken.reply.msg.t, "welcome", "a freed nickname is available to a new arrival");
    await sameNameNoToken.conn.close();

    // The kicked participant comes back under a different name, as the spec
    // allows. The roster also holds the new arrival who took the freed name.
    const newName = await join(s.joinCode, "Kenji", bad.rejoinToken);
    const names = newName.state.msg.state.roster.map((r: { nickname: string }) => r.nickname);
    assert.ok(names.includes("Kenji"), "the kicked participant rejoined under a new name");
    assert.equal(names.filter((n: string) => n === "asdf").length, 1, "the freed name is held by exactly one person");
    await host.close();
    await newName.conn.close();
  });

  it("a kicked participant cannot rejoin at all once the lobby is locked", async () => {
    const s = makeSession("running");
    const host = await connectHost(s);
    const bad = await join(s.joinCode, "asdf");
    await ackOk(host, { name: "participant.kick", pid: bad.pid });
    await ackOk(host, { name: "lobby.lock", locked: true });
    await sleep(50);
    await bad.conn.close();
    const r = await refusedJoin(s.joinCode, "Kenji", bad.rejoinToken);
    assert.equal(r.msg.reason, "lobby_locked");
    await host.close();
  });

  it("releasing a nickname disconnects the old device and lets a new one claim the name", async () => {
    const s = makeSession("running");
    const host = await connectHost(s);
    const old = await join(s.joinCode, "Kenji");
    await ackOk(host, { name: "participant.release", pid: old.pid });
    const closed = await old.conn.waitClosed(1500);
    assert.ok(closed, "the released device should be disconnected");
    const fresh = await join(s.joinCode, "Kenji");
    assert.equal(fresh.state.msg.state.roster.filter((r: { nickname: string }) => r.nickname === "Kenji").length, 1);
    await host.close();
    await old.conn.close();
    await fresh.conn.close();
  });
});

/* ------------------------------------------------------------------ */
/* Disconnects mid-flight                                               */
/* ------------------------------------------------------------------ */

describe("disconnects", () => {
  it("a participant that vanishes right after sending a command leaves the server healthy", async () => {
    const s = makeSession("running");
    const host = await connectHost(s);
    const p = await join(s.joinCode, "Kenji");
    p.conn.send({ t: "host.cmd", cid: "x", cmd: { name: "close" } });
    p.conn.send({ t: "resync" });
    p.conn.send({ t: "ping", t0: 1 });
    p.conn.ws.terminate();
    await p.conn.waitClosed();
    await sleep(150);
    assert.equal(s.runtime.state.phase, "running");
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    // The host is sent full state rather than roster deltas, so hostExtras'
    // counts cannot go stale behind a delta. Its roster is on the state frame.
    const roster = host.latest("state")!.msg.state.roster;
    const me = roster.find((r: { pid: string }) => r.pid === p.pid);
    assert.ok(me, "a dropped participant stays on the roster");
    assert.equal(me.conn, "away", "the console shows them away, not gone");
    await host.close();
  });

  it("a host command sent immediately before the host socket drops is still applied", async () => {
    const s = makeSession("running");
    const host = await connectHost(s);
    host.send({ t: "host.cmd", cid: "last-words", cmd: { name: "segment", kind: "final" } });
    host.ws.terminate();
    await host.waitClosed();
    await sleep(150);
    assert.equal(s.runtime.state.segment, "final", "the state lives on the server");
    // The host reopens the console link and is exactly where they were.
    const again = await connectHost(s);
    assert.equal(again.latest("state")!.msg.state.segment, "final");
    await again.close();
  });

  it("a participant that disconnects and rejoins keeps their points", async () => {
    const s = makeSession("running");
    const p = await join(s.joinCode, "Kenji");
    applyEvent(s, { type: "setScore", activityId: "trivia", pid: p.pid, raw: 100 });
    await sleep(50);
    const totalBefore = p.conn.latest("state")!.msg.state.own.total;
    assert.ok(totalBefore > 0);
    p.conn.ws.terminate();
    await p.conn.waitClosed();
    const back = await join(s.joinCode, "Kenji", p.rejoinToken);
    assert.equal(back.state.msg.state.own.total, totalBefore);
    await back.conn.close();
  });

  it("many sockets opening and dropping without hello do not disturb a live session", async () => {
    const s = makeSession("running");
    const p = await join(s.joinCode, "Kenji");
    const junk: Conn[] = [];
    for (let i = 0; i < 20; i += 1) junk.push(await Conn.open());
    for (const j of junk) j.ws.terminate();
    await Promise.all(junk.map((j) => j.waitClosed()));
    p.conn.send({ t: "ping", t0: 9 });
    assert.equal((await p.conn.expect("pong")).msg.t0, 9);
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(((await res.json()) as { socketsOpen: number }).socketsOpen >= 1, true);
    await p.conn.close();
  });
});

/* ------------------------------------------------------------------ */
/* Trivia                                                              */
/* ------------------------------------------------------------------ */

/**
 * The same property as `trivia.test.ts`, asserted end to end on the bytes a
 * real socket receives rather than on a projection called directly. The unit
 * test proves the projection is right; this proves nothing between the
 * projection and the wire puts it back.
 *
 * `ZIRCON-RIGHT` is the correct answer's text and appears nowhere else, so
 * finding it in a frame is unambiguous — and so is finding `"correct"`.
 */
const WIRE_QUESTIONS: readonly Question[] = [
  {
    text: "Which of these is the right one?",
    answers: ["ZIRCON-WRONG-1", "ZIRCON-RIGHT", "ZIRCON-WRONG-3", "ZIRCON-WRONG-4"],
    timeLimitSec: 20,
    correct: [1],
    note: "OSMIUM-NOTE: read this out.",
    round: "Materials",
    basePoints: 1000,
  },
  {
    text: "And the second one?",
    answers: ["A", "B"],
    timeLimitSec: 10,
    correct: [0],
    note: null,
    round: "Materials",
    basePoints: 1000,
  },
];

function loadQuestions(s: TestSession): void {
  applyEvent(s, {
    type: "loadTrivia",
    activityId: "trivia",
    questions: WIRE_QUESTIONS,
  });
}

describe("trivia over the wire", () => {
  it("never sends a participant the answer while the question is open", async () => {
    const s = makeSession("running");
    loadQuestions(s);
    const host = await connectHost(s);
    const right = await join(s.joinCode, "Priya");
    const wrong = await join(s.joinCode, "Kenji");
    await ackOk(host, { name: "segment", kind: "trivia" });

    right.conn.mark();
    wrong.conn.mark();
    await ackOk(host, { name: "trivia.open", suddenDeath: false });

    // Both phones have the question and the answers, and neither has a hint.
    // Waited for by phase, not by position: the `segment` broadcast may still
    // be in flight, and a test that assumed the next frame was the open one
    // would fail on the server being fast rather than on it being wrong.
    for (const p of [right, wrong]) {
      const frame = await p.conn.next(
        (f) => f.msg?.t === "state" && f.msg.state.trivia?.phase === "open",
      );
      assert.ok(frame.raw.includes("ZIRCON-RIGHT"), "the answers did not arrive");
      assert.ok(!frame.raw.includes('"correct"'), `correctness leaked: ${frame.raw}`);
      assert.ok(!frame.raw.includes("OSMIUM-NOTE"), "the note leaked");
      assert.equal(frame.msg.state.triviaMine.state, "unanswered");
      // Nor the count, yet: a number climbing under a question this phone has
      // not answered is a second clock on a screen that already has one.
      assert.equal(frame.msg.state.trivia.answered, undefined);
      assert.ok(!frame.raw.includes('"eligible"'), frame.raw);
    }

    right.conn.send({ t: "trivia.answer", cid: "a1", index: 0, choice: 1 });
    wrong.conn.send({ t: "trivia.answer", cid: "a2", index: 0, choice: 0 });
    assert.equal((await right.conn.expect("ack")).msg.applied, true);
    assert.equal((await wrong.conn.expect("ack")).msg.applied, true);

    // "Locked in" and nothing else — and the right and wrong answers are told
    // exactly the same thing.
    for (const [p, choice] of [[right, 1], [wrong, 0]] as const) {
      const frame = await p.conn.next(
        (f) => f.msg?.t === "state" && f.msg.state.triviaMine?.state === "locked",
      );
      assert.deepEqual(frame.msg.state.triviaMine, { state: "locked", choice });
      const keys = keysDeep(frame.msg.state.trivia);
      assert.ok(!keys.has("correct"), [...keys].join(","));
      assert.ok(!keys.has("distribution"), [...keys].join(","));
      assert.ok(!frame.raw.includes("OSMIUM-NOTE"));
      // The count does arrive, because the tap has happened: how many have
      // answered, never what any of them answered, which is why `distribution`
      // is still missing from the same frame. Which number it is depends on
      // whose tap this frame is for, so what is asserted here is that it is
      // there at all.
      assert.equal(typeof frame.msg.state.trivia.answered, "number");
      assert.equal(frame.msg.state.trivia.eligible, 2);
    }

    // And it climbs on a phone that locked in first, which is the whole point:
    // the seventeen seconds after an answer used to be a phone that did not
    // move.
    const climbed = await right.conn.next(
      (f) => f.msg?.t === "state" && f.msg.state.trivia?.answered === 2,
    );
    assert.equal(climbed.msg.state.trivia.eligible, 2);
    assert.ok(!climbed.raw.includes('"distribution"'), climbed.raw);

    // The console, meanwhile, has everything: it is reading the answer out.
    const hostFrame = host.latest("state")!;
    assert.deepEqual(hostFrame.msg.state.trivia.correct, [1]);
    assert.deepEqual(hostFrame.msg.state.trivia.distribution, [1, 1, 0, 0]);
    assert.equal(hostFrame.msg.state.trivia.answered, 2);
    assert.equal(hostFrame.msg.state.trivia.eligible, 2);

    await Promise.all([host.close(), right.conn.close(), wrong.conn.close()]);
  });

  it("closing settles the points and revealing hands them over", async () => {
    const s = makeSession("running");
    loadQuestions(s);
    const host = await connectHost(s);
    const p = await join(s.joinCode, "Priya");
    await ackOk(host, { name: "segment", kind: "trivia" });
    await ackOk(host, { name: "trivia.open", suddenDeath: false });
    await p.conn.expect("state");
    p.conn.send({ t: "trivia.answer", cid: "a1", index: 0, choice: 1 });
    await p.conn.expect("ack");

    p.conn.mark();
    await ackOk(host, { name: "trivia.close" });
    // Closed, not revealed: the host chooses the moment, and until they do
    // the phone still says nothing.
    const closed = await p.conn.next(
      (f) => f.msg?.t === "state" && f.msg.state.trivia?.phase === "closed",
    );
    assert.equal(closed.msg.state.triviaMine.state, "locked");
    assert.ok(!closed.raw.includes('"correct"'), closed.raw);

    await ackOk(host, { name: "trivia.reveal" });
    const revealed = await p.conn.next(
      (f) => f.msg?.t === "state" && f.msg.state.trivia?.phase === "revealed",
    );
    const mine = revealed.msg.state.triviaMine;
    assert.equal(mine.state, "revealed");
    assert.equal(mine.correct, true);
    assert.ok(mine.points > 500, "a correct answer is worth more than half the base");
    assert.ok(mine.points <= 1000);
    assert.equal(mine.streak, 1);
    assert.deepEqual(revealed.msg.state.trivia.correct, [1]);
    assert.equal(revealed.msg.state.trivia.note, "OSMIUM-NOTE: read this out.");
    assert.equal(revealed.msg.state.trivia.podium[0].nickname, "Priya");
    // Still not the distribution: DESIGN.md keeps that on the big screen.
    assert.equal(revealed.msg.state.trivia.distribution, undefined);

    await Promise.all([host.close(), p.conn.close()]);
  });

  it("refuses a tap once the question has moved on, rather than moving it", async () => {
    const s = makeSession("running");
    loadQuestions(s);
    const host = await connectHost(s);
    const p = await join(s.joinCode, "Priya");
    await ackOk(host, { name: "segment", kind: "trivia" });
    await ackOk(host, { name: "trivia.open", suddenDeath: false });
    await ackOk(host, { name: "trivia.close" });
    await ackOk(host, { name: "trivia.reveal" });
    await ackOk(host, { name: "trivia.next" });
    await ackOk(host, { name: "trivia.open", suddenDeath: false });

    // A tap that was in flight when the host advanced. It names question 0;
    // question 1 is open. It must not land on question 1.
    p.conn.send({ t: "trivia.answer", cid: "late", index: 0, choice: 0 });
    const refusal = await p.conn.next((f) => f.msg?.cid === "late");
    assert.equal(refusal.msg.t, "refusedCmd");
    assert.equal(refusal.msg.code, "question_not_open");
    assert.equal(s.runtime.state.trivia?.answers[p.pid], undefined);

    await Promise.all([host.close(), p.conn.close()]);
  });

  it("refuses an answer from the host socket and a trivia command from a phone", async () => {
    const s = makeSession("running");
    loadQuestions(s);
    const host = await connectHost(s);
    const p = await join(s.joinCode, "Priya");
    await ackOk(host, { name: "trivia.open", suddenDeath: false });

    host.send({ t: "trivia.answer", cid: "h1", index: 0, choice: 1 });
    const refusedAnswer = await host.next((f) => f.msg?.cid === "h1");
    assert.equal(refusedAnswer.msg.t, "refusedCmd");
    assert.equal(refusedAnswer.msg.code, "forbidden");

    p.conn.send({ t: "host.cmd", cid: "p1", cmd: { name: "trivia.reveal" } });
    const refusedCmd = await p.conn.next((f) => f.msg?.cid === "p1");
    assert.equal(refusedCmd.msg.t, "refusedCmd");
    assert.equal(refusedCmd.msg.code, "forbidden");

    await Promise.all([host.close(), p.conn.close()]);
  });

  it("sends absolute epochs, never durations", async () => {
    // ARCHITECTURE.md "Clocks and fairness": a client that receives the
    // message late still counts down to the right instant.
    const s = makeSession("running");
    loadQuestions(s);
    const host = await connectHost(s);
    const p = await join(s.joinCode, "Priya");
    await ackOk(host, { name: "segment", kind: "trivia" });
    p.conn.mark();
    await ackOk(host, { name: "trivia.open", suddenDeath: false });
    const frame = await p.conn.next(
      (f) => f.msg?.t === "state" && f.msg.state.trivia?.phase === "open",
    );
    const trivia = frame.msg.state.trivia;
    assert.ok(trivia.opensAt > 1_600_000_000_000, "opensAt is not an epoch");
    assert.equal(trivia.closesAt, trivia.opensAt + 20_000);
    const keys = keysDeep(trivia);
    for (const banned of ["remaining", "remainingMs", "secondsLeft", "duration"]) {
      assert.ok(!keys.has(banned), `${banned} is a duration on the wire`);
    }
    await Promise.all([host.close(), p.conn.close()]);
  });

  it("closes the question by itself when the timer runs out", async () => {
    const s = makeSession("running");
    applyEvent(s, {
      type: "loadTrivia",
      activityId: "trivia",
      // The engine's floor is 5 seconds; this test does not wait for it.
      questions: [{ ...WIRE_QUESTIONS[0]!, timeLimitSec: 5 }],
    });
    const host = await connectHost(s);
    await ackOk(host, { name: "segment", kind: "trivia" });
    await ackOk(host, { name: "trivia.open", suddenDeath: false });
    assert.equal(s.runtime.state.trivia?.phase, "open");

    // Pull the deadline into the past and re-arm, which is exactly what a
    // restart mid-question does with a `closesAt` that has already passed.
    s.runtime.state = {
      ...s.runtime.state,
      trivia: { ...s.runtime.state.trivia!, closesAt: Date.now() - 1 },
    };
    s.runtime.armQuestionTimer();
    await host.next((f) => f.msg?.t === "state" && f.msg.state.trivia?.phase === "closed");
    assert.equal(s.runtime.state.trivia?.phase, "closed");
    assert.equal(s.runtime.armedCloseAt, null);
    await host.close();
  });
});

describe("the trivia question upload", () => {
  const SET = JSON.stringify({
    title: "HashiCorp & IBM trivia",
    questions: [
      {
        text: "In what year was HashiCorp founded?",
        answers: ["2008", "2010", "2012", "2015"],
        correct: "C",
        timeLimitSec: 20,
        round: "History",
      },
      {
        text: "Which product does secrets management and dynamic credentials?",
        answers: ["Consul", "Boundary", "Vault", "Nomad"],
        correct: "C",
        timeLimitSec: 20,
        note: "Dynamic credentials are the bit people forget.",
        round: "Name that product",
      },
    ],
  });

  async function upload(s: TestSession, body: string, token?: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/api/sessions/${s.runtime.state.sid}/content/trivia`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body,
    });
  }

  it("loads a question file unchanged", async () => {
    const s = makeSession("running");
    const res = await upload(s, SET, s.hostToken);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { activityId: "trivia", questions: 2 });
    assert.equal(s.runtime.state.trivia?.questions.length, 2);
    // A letter in the file, a 0-based index in the engine, converted once.
    assert.deepEqual(s.runtime.state.trivia?.questions[0]?.correct, [2]);
  });

  it("rejects the whole file with errors addressed by question", async () => {
    // SPEC.md: "a set with question 14 missing is worse than a set that
    // failed to load in the dry run."
    const s = makeSession("running");
    const bad = JSON.stringify({
      questions: [
        ...(JSON.parse(SET) as { questions: unknown[] }).questions,
        { text: "A question with no time limit", answers: ["a", "b"], correct: "A" },
      ],
    });
    const res = await upload(s, bad, s.hostToken);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; errors: string[] };
    assert.equal(body.error, "invalid_questions");
    assert.ok(body.errors.length > 0);
    assert.ok(
      body.errors.every((e) => /^Question \d+/.test(e)),
      body.errors.join(" | "),
    );
    assert.equal(s.runtime.state.trivia, null, "half a set was loaded");
  });

  it("replaces the set during prep and refuses once a question has opened", async () => {
    const s = makeSession("running");
    assert.equal((await upload(s, SET, s.hostToken)).status, 200);
    // Re-uploading is the only way to edit a set, so a fix in the green room
    // has to work.
    assert.equal((await upload(s, SET, s.hostToken)).status, 200);

    applyEvent(s, { type: "openQuestion", suddenDeath: false });
    const res = await upload(s, SET, s.hostToken);
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { error: string }).error, "trivia_already_started");
  });

  it("answers an unknown session and a wrong token the same way", async () => {
    const s = makeSession("running");
    assert.equal((await upload(s, SET, "not-the-token")).status, 401);
    assert.equal((await upload(s, SET)).status, 401);
    const missing = await fetch(
      `http://127.0.0.1:${port}/api/sessions/ses_does_not_exist/content/trivia`,
      { method: "POST", headers: { authorization: `Bearer ${s.hostToken}` }, body: SET },
    );
    assert.equal(missing.status, 401);
  });
});

/* ------------------------------------------------------------------ */
/* Starting over, and undoing a close                                   */
/* ------------------------------------------------------------------ */

/**
 * The two ways back, over the wire.
 *
 * Expected behaviour is the contract the events promise (engine/types.ts) plus
 * the one thing that only exists out here: `session.restart` carries the
 * session's join code and the server refuses a frame that does not name the
 * session it is wiping. That check is not authentication — the socket is
 * already the host's — it is what stops a bare `{ name: "session.restart" }`,
 * which is the shape every other command in the union takes.
 */
describe("restart and reopen over the wire", () => {
  /** A session with two people in it, a score each, and a Spot Award. */
  async function withScores(): Promise<{
    s: TestSession;
    host: Conn;
    kenji: Joined;
    priya: Joined;
  }> {
    const s = makeSession("running");
    const host = await connectHost(s);
    const kenji = await join(s.joinCode, "Kenji");
    const priya = await join(s.joinCode, "Priya");
    applyEvent(s, { type: "setScore", activityId: "trivia", pid: kenji.pid, raw: 18400 });
    applyEvent(s, { type: "setScore", activityId: "trivia", pid: priya.pid, raw: 14720 });
    applyEvent(s, {
      type: "grantSpot",
      pid: priya.pid,
      activityId: "trivia",
      reason: "best recovery",
    });
    applyEvent(s, { type: "enterArcade", activityId: "arcade" });
    return { s, host, kenji, priya };
  }

  it("wipes the scores, keeps the room, and the phones land in a clean lobby", async () => {
    const { s, host, kenji, priya } = await withScores();
    assert.ok(s.runtime.state.arcade, "the arcade is open before the wipe");
    kenji.conn.mark();

    await ackOk(host, { name: "session.restart", confirm: s.joinCode });

    const after = await kenji.conn.next(
      (f) => f.msg?.t === "state" && f.msg.state.phase === "lobby",
    );
    assert.equal(after.msg.state.segment, "lobby");
    assert.equal(after.msg.state.seal, "live");
    assert.deepEqual(after.msg.state.standings, [], "nothing on the board");
    assert.equal(after.msg.state.arcade, undefined, "no arcade on a lobby phone");
    assert.equal(after.msg.state.arcadeMine, undefined);
    // Their own points strip is the participant's copy of the scoreboard.
    assert.equal(after.msg.state.own?.total ?? 0, 0);
    // Nobody was thrown off.
    assert.ok(!kenji.conn.isClosed);
    assert.ok(!priya.conn.isClosed);
    assert.equal(after.msg.state.roster.length, 2, "the room is still here");

    assert.equal(s.runtime.state.spots.length, 0);
    assert.equal(s.runtime.state.arcade, null);
    assert.equal(Object.keys(s.runtime.state.participants).length, 2);
    assert.equal(s.runtime.state.joinCode, s.joinCode, "the join code did not change");

    await host.close();
    await kenji.conn.close();
    await priya.conn.close();
  });

  it("refuses a restart that does not name the session", async () => {
    const { s, host, kenji, priya } = await withScores();
    for (const bad of [
      { name: "session.restart" },
      { name: "session.restart", confirm: "" },
      { name: "session.restart", confirm: "hvs.wrongwrongwrongwrongwrong" },
      // Join codes are base62 and case is significant. Nothing may fold them.
      { name: "session.restart", confirm: s.joinCode.toLowerCase() },
      { name: "session.restart", confirm: `${s.joinCode} ` },
      { name: "session.restart", confirm: 17 },
    ]) {
      const r = await cmd(host, bad);
      assert.equal(r.msg.t, "refusedCmd", `expected a refusal for ${JSON.stringify(bad)}`);
      assert.ok(r.msg.message.length > 0, "a refusal says something");
    }
    assert.ok(s.runtime.state.scores["trivia"]?.[kenji.pid], "nothing was wiped");
    assert.equal(s.runtime.state.spots.length, 1);

    await host.close();
    await kenji.conn.close();
    await priya.conn.close();
  });

  it("works on a closed session, and the code is joinable again afterwards", async () => {
    const { s, host, kenji, priya } = await withScores();
    await ackOk(host, { name: "close" });
    await kenji.conn.next((f) => f.msg?.t === "state" && f.msg.state.phase === "closed");
    await refusedJoin(s.joinCode, "Zoe");

    await ackOk(host, { name: "session.restart", confirm: s.joinCode });
    assert.equal(s.runtime.state.phase, "lobby");
    assert.equal(s.runtime.state.joinsLocked, false);

    // The point of keeping the code: somebody who never got in still can.
    const zoe = await join(s.joinCode, "Zoe");
    assert.equal(zoe.state.msg.state.phase, "lobby");

    await host.close();
    await kenji.conn.close();
    await priya.conn.close();
    await zoe.conn.close();
  });

  it("reopen puts a closed session back with every score on it", async () => {
    const { s, host, kenji, priya } = await withScores();
    const before = s.runtime.state.scores;
    await ackOk(host, { name: "close" });
    await kenji.conn.next((f) => f.msg?.t === "state" && f.msg.state.phase === "closed");

    await ackOk(host, { name: "session.reopen" });
    const back = await kenji.conn.next(
      (f) => f.msg?.t === "state" && f.msg.state.phase === "running",
    );
    assert.ok(back);
    assert.deepEqual(s.runtime.state.scores, before, "not a point moved");
    assert.equal(s.runtime.state.spots.length, 1);

    // And the console can drive it again, which a closed session refuses.
    await ackOk(host, { name: "segment", kind: "holding" });
    assert.equal(s.runtime.state.segment, "holding");

    await host.close();
    await kenji.conn.close();
    await priya.conn.close();
  });

  it("reopen on a session that is not closed is refused", async () => {
    const s = makeSession("running");
    const host = await connectHost(s);
    const r = await cmd(host, { name: "session.reopen" });
    assert.equal(r.msg.t, "refusedCmd");
    assert.ok(r.msg.message.length > 0);
    await host.close();
  });

  it("only the host can do either", async () => {
    const s = makeSession("running");
    const kenji = await join(s.joinCode, "Kenji");
    const screen = await connectScreen(s);
    for (const conn of [kenji.conn, screen]) {
      cidCounter += 1;
      const cid = `x${cidCounter}`;
      conn.send({
        t: "host.cmd",
        cid,
        cmd: { name: "session.restart", confirm: s.joinCode },
      });
      const r = await conn.next((f) => f.msg?.t === "refusedCmd" && f.msg.cid === cid);
      assert.equal(r.msg.code, "forbidden");
    }
    assert.equal(s.runtime.state.phase, "running");
    await kenji.conn.close();
    await screen.close();
  });

  it("a participant who was mid-question sees the lobby, not half a question", async () => {
    const s = makeSession("running");
    const host = await connectHost(s);
    const kenji = await join(s.joinCode, "Kenji");
    applyEvent(s, {
      type: "loadTrivia",
      activityId: "trivia",
      questions: [
        {
          text: "Which one?",
          answers: ["A", "B", "C", "D"],
          timeLimitSec: 20,
          correct: [1],
          note: "because",
          round: null,
          basePoints: 1000,
        },
      ],
    });
    await ackOk(host, { name: "segment", kind: "trivia" });
    await ackOk(host, { name: "trivia.open", suddenDeath: false });
    await kenji.conn.next((f) => f.msg?.t === "state" && f.msg.state.trivia?.phase === "open");
    kenji.conn.mark();

    await ackOk(host, { name: "session.restart", confirm: s.joinCode });
    const after = await kenji.conn.next(
      (f) => f.msg?.t === "state" && f.msg.state.phase === "lobby",
    );
    // The set is still loaded, so the phone still has a trivia block — it is
    // just an idle one, on question 1, with no clock and no answers.
    assert.equal(after.msg.state.segment, "lobby");
    assert.equal(after.msg.state.trivia?.phase, "idle");
    assert.equal(after.msg.state.trivia?.index, 0);
    assert.equal(after.msg.state.trivia?.opensAt, null);
    assert.equal(after.msg.state.trivia?.closesAt, null);
    assert.equal(after.msg.state.triviaMine?.state, "unanswered");
    assert.equal(s.runtime.armedCloseAt, null, "the question's timer is disarmed");
    assert.equal(
      s.runtime.state.trivia?.questions.length,
      1,
      "the question set survived the wipe",
    );

    await host.close();
    await kenji.conn.close();
  });
});
