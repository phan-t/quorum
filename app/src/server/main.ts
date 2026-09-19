/**
 * Entry point: HTTP + WebSocket on one port.
 *
 * One process, one port. In-memory session state is the truth while the
 * process runs; a store behind the engine's `persist` effect is what makes a
 * restart survivable. Boot order matters — the store is opened and live
 * sessions are recovered *before* the port is, so the load balancer never
 * sends a socket to a process that has not finished remembering.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { newSession, nicknameKey } from "../engine/reducer.ts";
import type { Event, ParticipantId, SessionState } from "../engine/types.ts";
import { parseClientMessage, PROTOCOL_VERSION } from "../protocol.ts";
import type { HostCommand, RefusedReason } from "../protocol.ts";
import {
  DEFAULT_ACTIVITIES,
  SessionRegistry,
  type Client,
  type SessionRuntime,
} from "./runtime.ts";
import { hashToken, newId, newJoinCode, tokenMatches } from "./tokens.ts";
import { AWAY_AFTER_MS } from "./views.ts";
import { Persister } from "./persist.ts";
import { openStore } from "./store/index.ts";
import type { StoredEvent } from "./store/types.ts";
import { recoverSessions, rehydrate } from "./recovery.ts";
import {
  eventsJsonl,
  mergeEventLogs,
  scoresheetCsv,
  scoresheetFilename,
} from "./export.ts";

const PORT = Number(process.env["PORT"] ?? 3000);
const ADMIN_KEY = process.env["QUORUM_ADMIN_KEY"] ?? "";
const VERSION = process.env["QUORUM_VERSION"] ?? "dev";
/** Set behind a load balancer that appends X-Forwarded-For. */
const TRUST_PROXY = process.env["QUORUM_TRUST_PROXY"] === "1";

// Top-level await: the store has to exist before the first session does, and
// a registry that is sometimes persistent and sometimes not, depending on how
// far boot got, is the kind of thing nobody debugs twice.
const store = await openStore();
const persister = new Persister(store);
const registry = new SessionRegistry(persister);

/* ------------------------------------------------------------------ */
/* Static client                                                       */
/* ------------------------------------------------------------------ */

const CLIENT_ROOT = resolve(
  process.env["QUORUM_CLIENT_ROOT"] ?? new URL("../../dist/client", import.meta.url).pathname,
);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

async function serveFile(res: ServerResponse, rel: string): Promise<boolean> {
  // normalize + prefix check: a path like /client/../../etc/passwd must not
  // escape the client root, and `..` is the whole of that attack.
  const abs = resolve(join(CLIENT_ROOT, normalize(rel)));
  if (abs !== CLIENT_ROOT && !abs.startsWith(CLIENT_ROOT + "/")) return false;
  try {
    const info = await stat(abs);
    if (!info.isFile()) return false;
    res.writeHead(200, {
      "content-type": MIME[extname(abs)] ?? "application/octet-stream",
      "content-length": info.size,
      // Hashed filenames are a later problem; for now never cache the shell.
      "cache-control": "no-cache",
    });
    createReadStream(abs).pipe(res);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Rate limiting — crude on purpose                                    */
/* ------------------------------------------------------------------ */

const hits = new Map<string, number[]>();
function rateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > limit;
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function json(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("bad json");
  }
}

/**
 * The presented bearer token, or "".
 *
 * Header only, never a query parameter: ARCHITECTURE.md keeps the host token
 * in the console's URL *fragment* precisely so it never reaches an access log,
 * and accepting `?token=` would put it in the ALB's log on the way to the CSV.
 * The console fetches the export with this header and hands the browser a blob.
 */
function bearer(req: IncomingMessage): string {
  const auth = req.headers.authorization ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
}

/**
 * The host's two takeaways: the scoresheet and the event log.
 *
 * A session that is still live is exported straight from memory. One the
 * registry has never heard of is loaded from the store, which is what makes
 * the export work for a session that finished before the last restart — the
 * case a host hits when they come back for the numbers on Monday.
 */
async function serveExport(
  res: ServerResponse,
  sid: string,
  kind: "export.csv" | "events.jsonl",
  presented: string,
): Promise<void> {
  const runtime = registry.bySessionId(sid);
  // A live CSV comes straight out of memory. The stored side is read when the
  // session is not in the registry at all, and always for the event log,
  // which has to span whatever happened before the last restart.
  const loaded =
    runtime && kind === "export.csv"
      ? null
      : await store.loadSession(sid).catch(() => null);

  const hostTokenHash = runtime?.secrets.hostTokenHash ?? loaded?.meta.hostTokenHash;
  // Unknown session and wrong token answer the same way. A 404 that only
  // appears for a real sid would otherwise be a session-id oracle.
  if (!hostTokenHash || presented === "" || !tokenMatches(presented, hostTokenHash)) {
    return json(res, 401, { error: "unauthorized" });
  }

  const state: SessionState | null =
    runtime?.state ?? (loaded ? (rehydrate(loaded)?.state ?? null) : null);
  if (!state) return json(res, 404, { error: "not_found" });

  if (kind === "export.csv") {
    return send(res, 200, "text/csv; charset=utf-8", scoresheetCsv(state), {
      "content-disposition": `attachment; filename="${scoresheetFilename(state)}"`,
    });
  }

  const live: StoredEvent[] = (runtime?.log ?? []).map((r) => ({
    seq: r.seq,
    event: r.event,
    at: r.at,
  }));
  const merged = mergeEventLogs(loaded?.events ?? [], live);
  return send(
    res,
    200,
    "application/x-ndjson; charset=utf-8",
    eventsJsonl(merged),
    { "content-disposition": `attachment; filename="${sid}-events.jsonl"` },
  );
}

function send(
  res: ServerResponse,
  code: number,
  contentType: string,
  body: string,
  extra: Record<string, string> = {},
): void {
  res.writeHead(code, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    // An export is a point-in-time answer about a session in flight.
    "cache-control": "no-store",
    ...extra,
  });
  res.end(body);
}

function handleHttp(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  if (path === "/healthz") {
    const persist = persister.health();
    return json(res, 200, {
      // Still `ok` while persistence is degraded: the session is playable and
      // pulling the task out of the load balancer would end it, which is a
      // far worse outcome than a gap in the audit trail.
      ok: true,
      sessionsLive: registry.liveCount(),
      socketsOpen: registry.socketCount(),
      version: VERSION,
      store: persist.kind,
      persist: {
        pending: persist.pending,
        failures: persist.failures,
        degraded: persist.degraded,
      },
    });
  }

  if (path === "/status") {
    const persist = persister.health();
    const text =
      `quorum ${VERSION}\n` +
      `sessions live: ${registry.liveCount()}\n` +
      `sockets open:  ${registry.socketCount()}\n` +
      `store:         ${persist.kind}${persist.degraded ? " (DEGRADED)" : ""}\n` +
      `writes:        ${persist.pending} pending, ${persist.failures} failed\n` +
      (persist.lastError ? `last error:    ${persist.lastError}\n` : "");
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return void res.end(text);
  }

  // GET /api/sessions/:sid/export.csv and /events.jsonl — host token only.
  if (req.method === "GET" && path.startsWith("/api/sessions/")) {
    const rest = path.slice("/api/sessions/".length);
    const cut = rest.indexOf("/");
    const raw = cut < 0 ? rest : rest.slice(0, cut);
    // A stray `%` is a malformed URL, not a crash: decodeURIComponent throws
    // on one, and this runs inside the request handler.
    let sid = raw;
    try {
      sid = decodeURIComponent(raw);
    } catch {
      /* use it as typed; it will simply not match a session */
    }
    const tail = cut < 0 ? "" : rest.slice(cut + 1);
    if (tail === "export.csv" || tail === "events.jsonl") {
      void serveExport(res, sid, tail, bearer(req));
      return;
    }
  }

  if (path === "/api/sessions" && req.method === "POST") {
    const auth = req.headers.authorization ?? "";
    const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    // An unset admin key must refuse everything rather than allow everything.
    // Compared the same way as every other secret here: a `!==` on the raw
    // string leaks its length and its matching prefix through timing.
    if (
      ADMIN_KEY === "" ||
      presented === "" ||
      !tokenMatches(presented, hashToken(ADMIN_KEY))
    ) {
      return json(res, 401, { error: "unauthorized" });
    }
    if (rateLimited("create", 10, 3_600_000)) {
      return json(res, 429, { error: "rate_limited" });
    }
    void readBody(req)
      .then((body) => {
        const b = (body ?? {}) as Record<string, unknown>;
        const title = typeof b["title"] === "string" ? b["title"] : "Team Huddle";
        const state = newSession({
          sid: newId("ses"),
          title,
          joinCode: newJoinCode(registry.takenCodes()),
          activities: DEFAULT_ACTIVITIES,
        });
        const created = registry.add(state);
        json(res, 201, {
          sid: state.sid,
          joinCode: state.joinCode,
          // Shown once. There is no endpoint that returns these again.
          hostToken: created.hostToken,
          screenToken: created.screenToken,
        });
      })
      .catch(() => json(res, 400, { error: "bad_request" }));
    return;
  }

  // The three client shells. /j/:code serves the same page as / — the client
  // reads the code off the path, so a QR can point straight at a session.
  if (req.method === "GET") {
    const shell =
      path === "/" || path.startsWith("/j/")
        ? "participant/index.html"
        : path === "/host"
          ? "host/index.html"
          : path === "/screen"
            ? "screen/index.html"
            : null;
    if (shell) {
      void serveFile(res, shell).then((ok) => {
        if (!ok) json(res, 404, { error: "client_not_built" });
      });
      return;
    }
    if (path.startsWith("/client/")) {
      void serveFile(res, path.slice("/client/".length)).then((ok) => {
        if (!ok) json(res, 404, { error: "not_found" });
      });
      return;
    }
  }

  json(res, 404, { error: "not_found" });
}

/* ------------------------------------------------------------------ */
/* WebSocket                                                           */
/* ------------------------------------------------------------------ */

const server = createServer(handleHttp);
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 64 * 1024 });

interface Pending {
  runtime: SessionRuntime;
  client: Client;
}

wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
  // X-Forwarded-For is client-supplied. Behind the ALB the *last* entry is
  // the one the load balancer appended and the only one we can believe; the
  // first is whatever the caller typed, which would let anyone pick their own
  // rate-limit bucket. Off the ALB, trust the socket.
  const xff = (req.headers["x-forwarded-for"] as string | undefined)
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ip =
    (TRUST_PROXY && xff && xff.length > 0 ? xff[xff.length - 1] : undefined) ??
    req.socket.remoteAddress ??
    "unknown";

  let joined: Pending | null = null;
  // A socket that never says hello is a port scan, not a participant.
  const helloTimer = setTimeout(() => {
    if (!joined) socket.close(1008, "no_hello");
  }, 10_000);

  socket.on("message", (data) => {
    const msg = parseClientMessage(String(data));
    if (!msg) return;
    const now = Date.now();

    if (msg.t === "hello") {
      if (joined) return;
      if (rateLimited(`hello:${ip}`, 10, 60_000)) {
        return refuseBare(socket, "rate_limited", "Too many attempts. Wait a minute.");
      }
      joined = handleHello(socket, msg, now);
      if (joined) {
        clearTimeout(helloTimer);
        const { runtime, client } = joined;
        runtime.clients.add(client);
        runtime.sendState(client, now);
        // The new client's own state already carries the roster; sending it
        // again would give a host two identical frames at connect.
        runtime.broadcastRoster(now, client);
      }
      return;
    }

    if (!joined) return;
    const { runtime, client } = joined;
    client.lastSeen = now;

    switch (msg.t) {
      case "ping":
        runtime.send(client, { t: "pong", t0: msg.t0, t1: now });
        return;
      case "resync":
        runtime.sendState(client, now);
        return;
      case "host.cmd": {
        if (client.role !== "host") {
          runtime.send(client, {
            t: "refusedCmd",
            cid: msg.cid,
            code: "forbidden",
            message: "Only the host can do that.",
          });
          return;
        }
        const event = msg.cmd ? commandToEvent(msg.cmd) : null;
        if (!event) {
          runtime.send(client, {
            t: "refusedCmd",
            cid: msg.cid,
            code: "malformed",
            message: "Unrecognised command.",
          });
          return;
        }
        const out = runtime.apply(event, now);
        // Kicking or releasing has to reach the device, not just the state:
        // a kicked participant whose socket stays open keeps watching, and a
        // released name is meant to free the *old* phone.
        if (
          out.applied &&
          (cmd_pid(msg.cmd) !== null)
        ) {
          const pid = cmd_pid(msg.cmd)!;
          for (const c of [...runtime.clients]) {
            if (c.pid !== pid) continue;
            runtime.clients.delete(c);
            runtime.refuse(
              c.socket,
              msg.cmd?.name === "participant.kick" ? "kicked" : "not_joinable",
              msg.cmd?.name === "participant.kick"
                ? "The host removed you. Rejoin with a different nickname."
                : "Your nickname was released. Join again to come back.",
            );
          }
          runtime.broadcastRoster(now);
        }
        if (out.rejection) {
          runtime.send(client, {
            t: "refusedCmd",
            cid: msg.cid,
            code: out.rejection.code,
            message: out.rejection.message,
          });
        } else {
          runtime.send(client, { t: "ack", cid: msg.cid, applied: out.applied });
        }
        return;
      }
    }
  });

  socket.on("close", () => {
    clearTimeout(helloTimer);
    if (!joined) return;
    const { runtime, client } = joined;
    runtime.clients.delete(client);
    if (client.pid) {
      // Still a participant, just not connected. Their score does not move.
      runtime.apply({ type: "disconnect", pid: client.pid }, Date.now());
    }
    runtime.broadcastRoster(Date.now());
  });

  socket.on("error", () => socket.close());
});

function refuseBare(socket: WebSocket, reason: RefusedReason, message: string): null {
  try {
    socket.send(JSON.stringify({ t: "refused", reason, message }));
    socket.close(1008, reason);
  } catch {
    /* gone */
  }
  return null;
}

function handleHello(
  socket: WebSocket,
  msg: Extract<ReturnType<typeof parseClientMessage>, { t: "hello" }>,
  now: number,
): Pending | null {
  if (msg.role === "host" || msg.role === "screen") {
    const token = msg.role === "host" ? msg.hostToken : msg.screenToken;
    const runtime = registry
      .all()
      .find((r) =>
        tokenMatches(
          token,
          msg.role === "host" ? r.secrets.hostTokenHash : r.secrets.screenTokenHash,
        ),
      );
    if (!runtime) return refuseBare(socket, "bad_token", "That link is not valid.");
    const client: Client = { socket, role: msg.role, lastSeen: now, seq: 0 };
    runtime.send(client, {
      t: "welcome",
      role: msg.role,
      sid: runtime.state.sid,
      serverTime: now,
      protocol: PROTOCOL_VERSION,
    });
    return { runtime, client };
  }

  const runtime = registry.byJoinCode(msg.joinCode);
  if (!runtime) return refuseBare(socket, "no_such_code", "No session with that code.");

  // A rejoin reuses the original pid, so the player keeps their number and score.
  const pid: ParticipantId =
    (msg.rejoinToken ? runtime.pidForRejoin(msg.rejoinToken) : undefined) ??
    newId("p");

  const out = runtime.apply(
    { type: "join", pid, nickname: msg.nickname },
    now,
  );
  if (out.rejection) {
    const map: Record<string, RefusedReason> = {
      nickname_taken: "nickname_taken",
      invalid_nickname: "invalid_nickname",
      joins_locked: "lobby_locked",
      kicked: "kicked",
      // Not "no_such_code". The code is real and the session exists — it has
      // not been opened, or it has finished. Saying "no session with that
      // code" sends someone to check a code that is perfectly correct, which
      // is exactly the wrong place to look.
      not_joinable: "not_joinable",
      session_closed: "not_joinable",
    };
    return refuseBare(
      socket,
      map[out.rejection.code] ?? "malformed",
      out.rejection.message,
    );
  }

  const client: Client = { socket, role: "participant", pid, lastSeen: now, seq: 0 };
  runtime.send(client, {
    t: "welcome",
    role: "participant",
    sid: runtime.state.sid,
    pid,
    rejoinToken: runtime.issueRejoinToken(pid),
    serverTime: now,
    protocol: PROTOCOL_VERSION,
  });
  return { runtime, client };
}

/** The pid a command targets, when it targets one. */
function cmd_pid(cmd: HostCommand | null): string | null {
  if (!cmd) return null;
  return cmd.name === "participant.kick" || cmd.name === "participant.release"
    ? cmd.pid
    : null;
}

function commandToEvent(cmd: HostCommand): Event | null {
  switch (cmd.name) {
    case "open":
      return { type: "open" };
    case "start":
      return { type: "start" };
    case "close":
      return { type: "close" };
    case "segment":
      return { type: "setSegment", segment: cmd.kind };
    case "holding":
      return { type: "setHolding", holding: { title: cmd.title, line: cmd.line } };
    case "seal":
      return { type: "setSeal", seal: cmd.state };
    case "lobby.lock":
      return { type: "setJoinsLocked", locked: cmd.locked };
    case "participant.kick":
      return { type: "kick", pid: cmd.pid };
    case "participant.release":
      return { type: "releaseNickname", pid: cmd.pid };
    case "score.set":
      return {
        type: "setScore",
        activityId: cmd.activityId,
        pid: cmd.pid,
        raw: cmd.raw,
      };
    case "score.status":
      return {
        type: "setStatus",
        activityId: cmd.activityId,
        pid: cmd.pid,
        status: cmd.status,
      };
    case "spot.grant":
      return {
        type: "grantSpot",
        pid: cmd.pid,
        activityId: cmd.activityId,
        reason: cmd.reason,
      };
    case "spot.revoke":
      return { type: "revokeSpot", seq: cmd.seq };
    default:
      return null;
  }
}

/** Repaint the roster so amber appears without anyone having to do anything. */
setInterval(() => {
  const now = Date.now();
  for (const r of registry.all()) if (r.clients.size > 0) r.sweep(now);
}, AWAY_AFTER_MS / 2).unref();

/* ------------------------------------------------------------------ */
/* Boot and shutdown                                                    */
/* ------------------------------------------------------------------ */

// Recovery before listen. ARCHITECTURE.md gives the task a 60-second health
// check grace period for exactly this, and a port that opens first would let
// the ALB route a phone into a process that has not loaded its sessions yet.
await recoverSessions(store, registry);

server.listen(PORT, () => {
  const where = `http://localhost:${PORT}`;
  console.log(`quorum ${VERSION} listening on ${where}`);
  if (ADMIN_KEY === "") {
    console.log(
      "  QUORUM_ADMIN_KEY is unset — POST /api/sessions will refuse everything.",
    );
  }
});

/**
 * SIGTERM: ECS stopping the task, which is what a deploy looks like from in
 * here. Thirty seconds, of which this uses as few as it can — stop taking new
 * sockets, let the queued writes land, then close every socket with `1012
 * Service Restart` so clients reconnect with backoff rather than treating it
 * as a normal close and giving up.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: draining`);
  server.close();
  const now = Date.now();
  for (const r of registry.all()) {
    // The last word on the state, so a restart mid-question loses nothing
    // that this process had accepted.
    r.persistence.snapshot(r.state, now);
    r.persistence.meta(r.meta(now));
  }
  await Promise.race([persister.drain(), new Promise((r) => setTimeout(r, 10_000))]);
  for (const r of registry.all()) {
    for (const c of r.clients) {
      try {
        c.socket.close(1012, "Service Restart");
      } catch {
        /* already gone */
      }
    }
  }
  await store.close().catch(() => {});
  console.log("drained");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

export { server, registry, store, persister };
