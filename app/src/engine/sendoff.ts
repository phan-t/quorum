/**
 * The send-off's slide plan: what the room sees, in what order.
 *
 * The segment used to be two blocks — every photo, then every message — and
 * the photographs were over before the first person was quoted. Folding them
 * together is what this module is for: the messages are dealt out *through*
 * the photographs so the room keeps being handed something new, and the plan
 * is worked out once, up front, rather than being decided a frame at a time.
 *
 * Two rules it has to hold to.
 *
 * **It is arithmetic, not randomness.** The shuffle is `shuffled()` from a
 * seed drawn at the socket boundary, exactly as Tug of Raft's sides are. A
 * replayed event log has to deal the same slides twice, and a Desktop that
 * reloads at message nine has to come back to the same message nine.
 *
 * **Every photo is used exactly once.** Forty-three photographs and thirteen
 * messages do not divide, so the gap between messages varies by one rather
 * than the remainder being dropped on the end — somebody sent every one of
 * those photos, and a send-off that quietly shows thirty-nine of them is
 * worse than one whose spacing is a frame uneven.
 */

import { shuffled } from "./arcade.ts";
import type { Kudo, SendoffContent, SendoffSlide } from "./types.ts";

/**
 * The longest a single message slide may run, in characters.
 *
 * The real set runs 34 to 145 words — 489 characters at the top — and the
 * whole of one of those on a screen is a paragraph the room reads rather
 * than a sentence it hears. Held to roughly a breath, so the type can be
 * set at something like twice the size the longest message used to force on
 * every other message in the set.
 */
export const SLIDE_CHARS = 260;

/**
 * One message, cut into the slides it will be read from.
 *
 * Cut at sentence ends and nowhere else. A farewell message broken mid-clause
 * reads as a transmission error, and the room has no way to tell a deliberate
 * pause from a bug. A sentence longer than the budget is therefore left whole
 * and allowed to be the small one — being slightly under-sized is a far
 * better failure than being cut in half.
 *
 * A message inside the budget comes back as a single slide, which is the
 * common case and the one that must stay cheap.
 */
export function splitMessage(message: string, budget = SLIDE_CHARS): readonly string[] {
  const text = message.trim();
  if (text.length <= budget) return [text];

  // A sentence end is a terminator, then space, then something that starts a
  // sentence. Not merely a full stop: the first version of this cut a real
  // message inside "consul.io" and put a slide reading "io, I was already so
  // scarred..." in front of the room. A domain has no space after its dot,
  // and "e.g. something" has no capital after it, so both survive.
  const sentences = text
    .split(/(?<=[.!?])\s+(?=["'"'"'“‘(\[]?[A-Z0-9])/u)
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (sentences.length <= 1) return [text];

  const out: string[] = [];
  let held = "";
  for (const sentence of sentences) {
    if (held === "") {
      held = sentence;
      continue;
    }
    if (held.length + 1 + sentence.length <= budget) {
      held = `${held} ${sentence}`;
      continue;
    }
    out.push(held);
    held = sentence;
  }
  if (held !== "") out.push(held);
  return out;
}

/** How many slides a message takes. The plan and the fit both need it. */
export function partsOf(kudo: Kudo, budget = SLIDE_CHARS): readonly string[] {
  return splitMessage(kudo.message, budget);
}

/**
 * Deal the messages through the photographs.
 *
 * `round((i + 1) * photos / (messages + 1))` is the whole of the spacing: it
 * puts message `i` at its own fraction of the way through the set, which
 * leaves a short run of photographs at either end rather than opening on a
 * quotation or ending on one. The closing card follows the last of them.
 *
 * A message that was split occupies consecutive slides — its parts are never
 * separated by a photograph, because a paragraph interrupted by somebody's
 * holiday snap is not a paragraph the room can follow.
 */
export function buildPlan(content: SendoffContent, seed: number): readonly SendoffSlide[] {
  const photos = shuffled(content.opening.photos, seed);
  // A second seed, derived rather than drawn, so the two shuffles cannot walk
  // in step — the same seed on both would pair photo n with message n for as
  // long as the lists were the same length.
  const order = shuffled(
    content.kudos.map((_, i) => i),
    (seed ^ 0x5bf03635) >>> 0,
  );

  const slides: SendoffSlide[] = [];
  const m = order.length;
  const p = photos.length;
  let taken = 0;

  order.forEach((at, i) => {
    const upTo = m === 0 ? p : Math.round(((i + 1) * p) / (m + 1));
    for (; taken < upTo; taken += 1) slides.push({ kind: "photo", key: photos[taken]! });
    const parts = partsOf(content.kudos[at]!).length;
    for (let part = 0; part < parts; part += 1) {
      slides.push({ kind: "kudo", at, part, parts });
    }
  });

  for (; taken < p; taken += 1) slides.push({ kind: "photo", key: photos[taken]! });
  return slides;
}

/**
 * The longest slide in the set, in characters.
 *
 * The Desktop sets every message at one size and the size that works is the
 * one the longest needs — and now that a long message is split, "the longest"
 * is a slide rather than a message. This is the number that went up.
 */
export function longestSlide(content: SendoffContent): number {
  let longest = 0;
  for (const k of content.kudos) {
    for (const part of partsOf(k)) longest = Math.max(longest, part.length);
  }
  return longest;
}

/* ---- auto-advance ---------------------------------------------------- */

/**
 * Seconds a photograph holds when the run is playing itself.
 *
 * Four rather than the montage's old arithmetic — `seconds` in the file was
 * the whole montage's length, divided by however many photographs there were,
 * which for forty-three of them worked out under a second and hit the floor.
 * A number per photograph is the thing a host can actually reason about while
 * standing in front of a room, and it is the number the slider sets.
 */
export const DEFAULT_AUTO_SECONDS = 4;
export const MIN_AUTO_SECONDS = 2;
export const MAX_AUTO_SECONDS = 12;

/**
 * How long one slide holds under auto-advance.
 *
 * A photograph gets the slider's number. A message gets longer, because the
 * room is reading it rather than looking at it, and a message that leaves the
 * screen mid-sentence is the one failure this segment cannot have. Sixty
 * milliseconds a character is roughly 200 words a minute with a beat at
 * either end; the slider still moves it, so a host who wants the whole thing
 * faster gets it faster without the messages becoming unreadable first.
 */
export function slideMs(
  slide: SendoffSlide,
  content: SendoffContent,
  autoSeconds: number,
): number {
  const base = autoSeconds * 1000;
  if (slide.kind === "photo") return base;
  const text = partsOf(content.kudos[slide.at]!)[slide.part] ?? "";
  return Math.max(base * 1.5, text.length * 60 * (autoSeconds / DEFAULT_AUTO_SECONDS));
}
