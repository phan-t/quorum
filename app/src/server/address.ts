/**
 * Who a socket is, for rate limiting.
 *
 * The join limit is ten `hello` frames a minute per address, and the address
 * is the only thing keeping one phone from spending everybody's budget. That
 * makes this three lines of parsing with the whole limit resting on it, which
 * is why it is a module with tests rather than an expression inside the
 * connection handler.
 *
 * Two ways to get it wrong, in opposite directions:
 *
 * - Trust `X-Forwarded-For` when nothing in front of us writes it, and any
 *   caller picks their own bucket by sending a header. The limit is then
 *   decoration.
 * - Ignore it when something in front of us *does* write it, and every
 *   participant shares the load balancer's address. Thirty people joining at
 *   2:45pm rate-limit each other, the join link looks broken, and it looks
 *   broken at the worst possible moment.
 *
 * The second is the one this deployment is actually exposed to: the room is
 * behind an ALB, so without the flag the bucket key is one ENI address for
 * the entire room. See `infra/modules/service/ecs.tf`, which sets the flag.
 */

/**
 * The address to bill a connection to.
 *
 * `trustProxy` is a parameter rather than a read of the environment so that
 * both answers can be tested in one process — and so that the decision about
 * what is in front of us is made once, at boot, by the thing that knows.
 *
 * When it is on we take the **last** entry in the chain. An ALB appends the
 * peer's address to whatever `X-Forwarded-For` arrived, so the last entry is
 * the one the load balancer wrote and the only one nobody else could have.
 * Every earlier entry is whatever the caller chose to send. Taking the first,
 * which is the conventional reading of the header when the whole chain is
 * trusted, would hand the bucket key back to the caller and undo the limit.
 *
 * When it is off the header is not read at all. Not preferred-but-overridable:
 * unread. A deployment with nothing in front of it has no honest use for it.
 */
export function clientAddress(
  forwardedFor: string | readonly string[] | undefined,
  socketAddress: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    // Node joins repeated `X-Forwarded-For` headers into one comma-separated
    // string, so the array arm is unreachable today. It is handled anyway
    // because the alternative is a `TypeError` thrown inside a connection
    // handler, and this is not a line worth crashing the room's server over.
    const raw = Array.isArray(forwardedFor)
      ? forwardedFor.join(",")
      : ((forwardedFor ?? "") as string);
    const chain = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const last = chain[chain.length - 1];
    if (last !== undefined) return last;
  }
  // No usable header, or not trusted. The peer is whoever actually dialled
  // us, which off a proxy is the participant and behind one is the proxy —
  // and a shared bucket is still better than one a stranger can choose.
  return socketAddress ?? "unknown";
}
