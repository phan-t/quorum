/**
 * The seam between the client runtime and whatever is carrying the frames.
 *
 * There are two implementations: a real WebSocket, and the in-page mock server
 * in `mock.ts`. `net.ts` cannot tell them apart, which is the point — every
 * page can be opened and driven with no backend at all.
 */

import type { ClientMessage, ServerMessage } from "../../protocol.ts";

export interface Transport {
  send(msg: ClientMessage): void;
  /** Idempotent. Must not fire `onClose` when the caller closes deliberately. */
  close(): void;
}

export interface TransportHandlers {
  onOpen(): void;
  onMessage(msg: ServerMessage): void;
  /** The far end went away. `net.ts` decides whether to reconnect. */
  onClose(reason: string): void;
}

export type TransportFactory = (h: TransportHandlers) => Transport;

/** `wss://host/ws`, or whatever `?ws=` says, for pointing a page at a laptop. */
export function socketUrl(): string {
  const override = new URLSearchParams(location.search).get("ws");
  if (override) return override;
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/ws`;
}

export function webSocketTransport(url: string): TransportFactory {
  return (handlers) => {
    const ws = new WebSocket(url);
    let closedByUs = false;

    ws.addEventListener("open", () => handlers.onOpen());
    ws.addEventListener("message", (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return; // a frame we cannot read is a frame that never arrived
      }
      if (typeof parsed !== "object" || parsed === null) return;
      if (typeof (parsed as { t?: unknown }).t !== "string") return;
      handlers.onMessage(parsed as ServerMessage);
    });
    const gone = (reason: string) => {
      if (closedByUs) return;
      closedByUs = true;
      handlers.onClose(reason);
    };
    ws.addEventListener("close", (ev: CloseEvent) =>
      gone(ev.reason || `closed ${ev.code}`),
    );
    ws.addEventListener("error", () => gone("socket error"));

    return {
      send(msg) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      },
      close() {
        closedByUs = true;
        try {
          ws.close();
        } catch {
          /* already gone */
        }
      },
    };
  };
}
