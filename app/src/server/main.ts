/**
 * Entry point: HTTP + WebSocket on one port.
 *
 * One process, one port, in-memory session state. Phase 2 adds DynamoDB
 * persistence behind the same `persist` effect the engine already emits.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { newSession, nicknameKey } from "../engine/reducer.ts";
import type { Event, ParticipantId } from "../engine/types.ts";
import { parseClientMessage, PROTOCOL_VERSION } from "../protocol.ts";
import type { HostCommand, RefusedReason } from "../protocol.ts";
import {
  DEFAULT_ACTIVITIES,
  SessionRegistry,
  type Client,
  type SessionRuntime,
} from "./runtime.ts";
import { newId, newJoinCode, tokenMatches } from "./tokens.ts";
import { AWAY_AFTER_MS } from "./views.ts";

const PORT = Number(process.env["PORT"] ?? 3000);
const ADMIN_KEY = process.env["QUORUM_ADMIN_KEY"] ?? "";
const VERSION = process.env["QUORUM_VERSION"] ?? "dev";
/** Set behind a load balancer that appends X-Forwarded-For. */
const TRUST_PROXY = process.env["QUORUM_TRUST_PROXY"] === "1";

const registry = new SessionRegistry();

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

function handleHttp(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  if (path === "/healthz") {
    return json(res, 200, {
      ok: true,
      sessionsLive: registry.liveCount(),
      socketsOpen: registry.socketCount(),
      version: VERSION,
    });
  }

  if (path === "/status") {
    const text =
      `quorum ${VERSION}\n` +
      `sessions live: ${registry.liveCount()}\n` +
      `sockets open:  ${registry.socketCount()}\n`;
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return void res.end(text);
  }

  if (path === "/api/sessions" && req.method === "POST") {
    const auth = req.headers.authorization ?? "";
    const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    // An unset admin key must refuse everything rather than allow everything.
    if (ADMIN_KEY === "" || presented === "" || presented !== ADMIN_KEY) {
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
        runtime.broadcastRoster(now);
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
    const client: Client = { socket, role: msg.role, lastSeen: now };
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
      // A session that is not open has no live code, so that is what the
      // phone is told. "malformed" would blame the client for our state.
      not_joinable: "no_such_code",
      session_closed: "no_such_code",
    };
    return refuseBare(
      socket,
      map[out.rejection.code] ?? "malformed",
      out.rejection.message,
    );
  }

  const client: Client = { socket, role: "participant", pid, lastSeen: now };
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
    default:
      return null;
  }
}

/** Repaint the roster so amber appears without anyone having to do anything. */
setInterval(() => {
  const now = Date.now();
  for (const r of registry.all()) if (r.clients.size > 0) r.sweep(now);
}, AWAY_AFTER_MS / 2).unref();

server.listen(PORT, () => {
  const where = `http://localhost:${PORT}`;
  console.log(`quorum ${VERSION} listening on ${where}`);
  if (ADMIN_KEY === "") {
    console.log(
      "  QUORUM_ADMIN_KEY is unset — POST /api/sessions will refuse everything.",
    );
  }
});

export { server, registry };
