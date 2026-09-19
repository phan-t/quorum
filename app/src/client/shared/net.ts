/**
 * The shared client runtime. One of these per page, whatever the role.
 *
 * It owns five things the three surfaces would otherwise each get subtly
 * wrong:
 *
 * - the `hello` → `welcome` / `refused` handshake, including the fact that a
 *   refusal is *terminal* and must not be retried in a loop;
 * - reconnect with exponential backoff, plus an immediate attempt when the tab
 *   becomes visible again — the phone that slept through the holding page is
 *   the failure this product actually has;
 * - `seq` gap detection. Broadcasts are deltas; a client that misses one and
 *   keeps rendering is a client showing yesterday's standings. A gap sends
 *   `resync` and the server answers with a full `state`;
 * - the clock offset, median of the last five `ping`/`pong` round trips, so a
 *   countdown drawn from an absolute server epoch lands on the right instant;
 * - holding the last `RenderState` so a reconnect repaints the page it left,
 *   never a blank one.
 */

import type {
  ClientMessage,
  HostCommand,
  RefusedReason,
  RenderState,
  ServerMessage,
} from "../../protocol.ts";
import {
  socketUrl,
  webSocketTransport,
  type Transport,
  type TransportFactory,
} from "./transport.ts";

export type Hello = Extract<ClientMessage, { t: "hello" }>;
export type Welcome = Extract<ServerMessage, { t: "welcome" }>;

export type ConnStatus =
  /** First attempt, nothing on screen yet. */
  | "connecting"
  /** Socket up, `welcome` received. */
  | "live"
  /** Dropped; the page keeps its last state under a banner. */
  | "reconnecting"
  /** The server said no, and said why. Terminal. */
  | "refused"
  /** We stopped on purpose. */
  | "gone";

export type CommandResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export interface QuorumClientOptions {
  /** Rebuilt for every attempt: a rejoin token may have arrived since. */
  hello: () => Hello;
  transport?: TransportFactory;
  onState?: (state: RenderState) => void;
  onStatus?: (status: ConnStatus, detail: string) => void;
  onWelcome?: (welcome: Welcome) => void;
  onRefused?: (reason: RefusedReason, message: string) => void;
  onToast?: (kind: "spot" | "text", text: string) => void;
  onCommandResult?: (cid: string, result: CommandResult) => void;
}

const PING_EVERY_MS = 10_000;
const OFFSET_SAMPLES = 5;
/** If `welcome` is not followed by a `state`, ask for one rather than hang. */
const STATE_GRACE_MS = 1_500;
const BACKOFF_MS = [300, 800, 1_600, 3_200, 6_400, 10_000] as const;

export class QuorumClient {
  readonly #opts: QuorumClientOptions;
  readonly #makeTransport: TransportFactory;

  #transport: Transport | null = null;
  #status: ConnStatus = "connecting";
  #state: RenderState | null = null;
  #lastSeq: number | null = null;
  #attempt = 0;
  #stopped = false;

  #offsets: number[] = [];
  #offset = 0;

  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #stateGraceTimer: ReturnType<typeof setTimeout> | null = null;
  #resyncPending = false;
  #cidSeq = 0;

  constructor(opts: QuorumClientOptions) {
    this.#opts = opts;
    this.#makeTransport = opts.transport ?? webSocketTransport(socketUrl());

    document.addEventListener("visibilitychange", this.#onVisible);
    window.addEventListener("online", this.#onVisible);
  }

  /* ----------------------------------------------------------------- */
  /* Public surface                                                     */
  /* ----------------------------------------------------------------- */

  start(): void {
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#clearTimers();
    this.#transport?.close();
    this.#transport = null;
    this.#setStatus("gone", "closed");
    document.removeEventListener("visibilitychange", this.#onVisible);
    window.removeEventListener("online", this.#onVisible);
  }

  get state(): RenderState | null {
    return this.#state;
  }

  get status(): ConnStatus {
    return this.#status;
  }

  /** Server epoch, corrected. Every countdown in the product is drawn off this. */
  now(): number {
    return Date.now() + this.#offset;
  }

  get clockOffsetMs(): number {
    return this.#offset;
  }

  /** Sends a host command and returns the `cid` the ack will carry. */
  command(cmd: HostCommand): string {
    const cid = this.#nextCid();
    this.#send({ t: "host.cmd", cid, cmd });
    return cid;
  }

  /**
   * One tap at a trivia question, and it is final. Returns the `cid`.
   *
   * `index` rides along so a tap sent as the host advances is refused rather
   * than silently landing on the next question. There is no timestamp on it:
   * the response time is the server's to measure, and a client that could
   * send one would be sending a number worth points.
   */
  answer(index: number, choice: number): string {
    const cid = this.#nextCid();
    this.#send({ t: "trivia.answer", cid, index, choice });
    return cid;
  }

  #nextCid(): string {
    return `c${++this.#cidSeq}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Ask for a full state. Safe to call at any time. */
  resync(): void {
    this.#requestResync();
  }

  /* ----------------------------------------------------------------- */
  /* Connection                                                         */
  /* ----------------------------------------------------------------- */

  #connect(): void {
    if (this.#stopped) return;
    this.#clearTimer("reconnect");
    this.#setStatus(
      this.#state === null ? "connecting" : "reconnecting",
      this.#attempt === 0 ? "connecting" : `attempt ${this.#attempt + 1}`,
    );

    let transport: Transport;
    try {
      transport = this.#makeTransport({
        onOpen: () => this.#onOpen(),
        onMessage: (m) => this.#onMessage(m),
        onClose: (reason) => this.#onClose(reason),
      });
    } catch (err) {
      this.#onClose(String(err));
      return;
    }
    this.#transport = transport;
  }

  #onOpen(): void {
    this.#send(this.#opts.hello());
  }

  #onClose(reason: string): void {
    this.#transport = null;
    this.#clearTimer("ping");
    this.#clearTimer("stateGrace");
    if (this.#stopped || this.#status === "refused") return;

    this.#setStatus("reconnecting", reason);
    const idx = Math.min(this.#attempt, BACKOFF_MS.length - 1);
    const base = BACKOFF_MS[idx] ?? 10_000;
    // Jitter: thirty phones reconnecting in lockstep is a thundering herd of
    // exactly the size this product has.
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.#attempt += 1;
    this.#reconnectTimer = setTimeout(() => this.#connect(), delay);
  }

  #onVisible = (): void => {
    if (this.#stopped) return;
    if (document.visibilityState === "hidden") return;
    if (this.#status === "refused") return;
    if (this.#transport === null) {
      // The phone woke up. Do not make the person wait out the backoff.
      this.#attempt = 0;
      this.#clearTimer("reconnect");
      this.#connect();
    } else if (this.#status === "live") {
      // The socket may look alive and be long dead. Ask, do not assume.
      this.#requestResync();
      this.#ping();
    }
  };

  /* ----------------------------------------------------------------- */
  /* Messages                                                           */
  /* ----------------------------------------------------------------- */

  #onMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case "welcome": {
        this.#attempt = 0;
        // A first, latency-blind offset so the page is never wildly wrong
        // before the first pong lands.
        if (this.#offsets.length === 0) this.#offset = msg.serverTime - Date.now();
        this.#setStatus("live", "connected");
        this.#opts.onWelcome?.(msg);
        this.#startPings();
        // A reconnect starts from nothing: the deltas we missed are gone.
        this.#lastSeq = null;
        this.#clearTimer("stateGrace");
        this.#stateGraceTimer = setTimeout(() => {
          if (this.#lastSeq === null) this.#requestResync();
        }, STATE_GRACE_MS);
        return;
      }

      case "refused": {
        this.#setStatus("refused", msg.reason);
        this.#clearTimers();
        this.#transport?.close();
        this.#transport = null;
        this.#opts.onRefused?.(msg.reason, msg.message);
        return;
      }

      case "state": {
        // A full state supersedes anything we missed, gap or no gap.
        this.#resyncPending = false;
        this.#lastSeq = msg.seq;
        this.#clearTimer("stateGrace");
        this.#state = msg.state;
        this.#opts.onState?.(msg.state);
        return;
      }

      case "roster": {
        if (!this.#accept(msg.seq)) return;
        if (this.#state === null) return this.#requestResync();
        this.#state = { ...this.#state, roster: msg.roster };
        this.#opts.onState?.(this.#state);
        return;
      }

      case "seal": {
        if (!this.#accept(msg.seq)) return;
        if (this.#state === null) return this.#requestResync();
        this.#state = { ...this.#state, seal: msg.state };
        this.#opts.onState?.(this.#state);
        return;
      }

      case "toast": {
        if (!this.#accept(msg.seq)) return;
        this.#opts.onToast?.(msg.kind, msg.text);
        return;
      }

      case "ack": {
        // `applied: false` is not a success. The easy mistake for every
        // caller of the engine is to treat a refusal as one.
        this.#opts.onCommandResult?.(
          msg.cid,
          msg.applied
            ? { ok: true }
            : { ok: false, code: "not_applied", message: "nothing changed" },
        );
        return;
      }

      case "refusedCmd": {
        this.#opts.onCommandResult?.(msg.cid, {
          ok: false,
          code: msg.code,
          message: msg.message,
        });
        return;
      }

      case "pong": {
        this.#recordOffset(msg.t0, msg.t1);
        return;
      }
    }
  }

  /**
   * Sequence discipline for delta broadcasts. `seq` is per session and
   * monotonic: anything but `last + 1` means we are out of step, and the only
   * honest move is to throw away the delta and ask for the whole thing.
   */
  #accept(seq: number): boolean {
    if (this.#lastSeq === null) {
      this.#requestResync();
      return false;
    }
    if (seq <= this.#lastSeq) return false; // duplicate or reordered; already applied
    if (seq !== this.#lastSeq + 1) {
      this.#requestResync();
      return false;
    }
    this.#lastSeq = seq;
    return true;
  }

  #requestResync(): void {
    if (this.#resyncPending || this.#transport === null) return;
    this.#resyncPending = true;
    // Jittered: one missed broadcast means every phone in the room notices the
    // same gap at the same moment, and thirty simultaneous resyncs is thirty
    // full states out of one process.
    setTimeout(() => this.#send({ t: "resync" }), Math.random() * 400);
    // If the answer never comes, allow another ask rather than wedging.
    setTimeout(() => {
      this.#resyncPending = false;
    }, 2_000);
  }

  #send(msg: ClientMessage): void {
    this.#transport?.send(msg);
  }

  /* ----------------------------------------------------------------- */
  /* Clock                                                              */
  /* ----------------------------------------------------------------- */

  #startPings(): void {
    this.#clearTimer("ping");
    this.#ping();
    this.#pingTimer = setInterval(() => this.#ping(), PING_EVERY_MS);
  }

  #ping(): void {
    this.#send({ t: "ping", t0: Date.now() });
  }

  #recordOffset(t0: number, t1: number): void {
    const t2 = Date.now();
    // NTP's, with one server timestamp: the server's clock at t1 sat halfway
    // through a round trip of (t2 - t0).
    const offset = t1 - (t0 + t2) / 2;
    this.#offsets.push(offset);
    if (this.#offsets.length > OFFSET_SAMPLES) this.#offsets.shift();
    // Median, not mean: one packet stuck behind a bufferbloated uplink should
    // not move the clock for the rest of the session.
    const sorted = [...this.#offsets].sort((a, b) => a - b);
    const mid = sorted[Math.floor(sorted.length / 2)];
    if (mid !== undefined) this.#offset = mid;
  }

  /* ----------------------------------------------------------------- */
  /* Bookkeeping                                                        */
  /* ----------------------------------------------------------------- */

  #setStatus(status: ConnStatus, detail: string): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#opts.onStatus?.(status, detail);
  }

  #clearTimer(which: "ping" | "reconnect" | "stateGrace"): void {
    if (which === "ping" && this.#pingTimer !== null) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
    if (which === "reconnect" && this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    if (which === "stateGrace" && this.#stateGraceTimer !== null) {
      clearTimeout(this.#stateGraceTimer);
      this.#stateGraceTimer = null;
    }
  }

  #clearTimers(): void {
    this.#clearTimer("ping");
    this.#clearTimer("reconnect");
    this.#clearTimer("stateGrace");
  }
}
