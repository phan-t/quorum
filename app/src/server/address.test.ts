/**
 * The bucket key the join rate limit counts against.
 *
 * These are cheap tests for a small function, and they are here because the
 * flag that makes the forwarded path live in production is now set. Before it
 * was set, everything below the `trustProxy: true` line was code that had
 * never run anywhere that mattered.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { clientAddress } from "./address.ts";

const SOCKET = "10.0.1.7"; // an ALB ENI, in production
const CLIENT = "203.0.113.9";

describe("clientAddress, with nothing in front of us", () => {
  test("uses the peer", () => {
    assert.equal(clientAddress(undefined, CLIENT, false), CLIENT);
  });

  test("does not read X-Forwarded-For at all", () => {
    // The attack: a caller who can pick their own key gets a fresh ten joins
    // a minute for every value they invent, and the limit stops existing.
    assert.equal(clientAddress("1.1.1.1", CLIENT, false), CLIENT);
    assert.equal(clientAddress("1.1.1.1, 2.2.2.2", CLIENT, false), CLIENT);
  });

  test("falls back to a name rather than undefined when there is no peer", () => {
    assert.equal(clientAddress(undefined, undefined, false), "unknown");
  });
});

describe("clientAddress, behind the ALB", () => {
  test("uses the entry the load balancer appended, which is the last", () => {
    assert.equal(clientAddress(CLIENT, SOCKET, true), CLIENT);
  });

  test("ignores a chain the caller prefixed to it", () => {
    // What arrives when someone sends their own X-Forwarded-For: the ALB
    // appends the real peer, so the forgery is everything but the last entry.
    assert.equal(clientAddress(`1.1.1.1, 2.2.2.2, ${CLIENT}`, SOCKET, true), CLIENT);
  });

  test("two people behind one office NAT still share a key, which is the point", () => {
    // Not a bug being pinned: this is the limit working. What it must not do
    // is give the whole room one key, which is what SOCKET would be.
    const a = clientAddress(`${CLIENT}`, SOCKET, true);
    const b = clientAddress(`${CLIENT}`, SOCKET, true);
    assert.equal(a, b);
    assert.notEqual(a, SOCKET);
  });

  test("tolerates the whitespace a chain is conventionally written with", () => {
    assert.equal(clientAddress(`1.1.1.1,   ${CLIENT}  `, SOCKET, true), CLIENT);
  });

  test("an IPv6 participant keys on their own address", () => {
    // The ALB is dualstack and some mobile networks are IPv6-only, so this is
    // an ordinary joiner, not an edge case.
    const v6 = "2001:db8::42";
    assert.equal(clientAddress(v6, SOCKET, true), v6);
  });

  test("an empty or blank header falls back to the peer instead of an empty key", () => {
    // One empty-string key shared by every malformed request would be a
    // bucket anybody could fill on everybody's behalf.
    assert.equal(clientAddress("", SOCKET, true), SOCKET);
    assert.equal(clientAddress("  ", SOCKET, true), SOCKET);
    assert.equal(clientAddress(" , , ", SOCKET, true), SOCKET);
  });

  test("survives a header node handed us as an array", () => {
    // Node joins repeated headers itself, so this should not happen. It is
    // tested because the failure mode if it ever did would be a TypeError in
    // the connection handler, taking the process down mid-session.
    assert.equal(clientAddress(["1.1.1.1", CLIENT], SOCKET, true), CLIENT);
    assert.equal(clientAddress([], SOCKET, true), SOCKET);
  });
});
