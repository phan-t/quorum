/**
 * Build an event's trivia: a random `count` of the shared bank's scored
 * questions, every one of the event's additional questions, shuffled together,
 * and every tiebreaker from both.
 *
 * The bank is where the verified, kept-up-to-date questions live, so every
 * event draws from it and two events staged from it do not ask the same set.
 * An event's additional questions are the ones written for that room — a few
 * about the team, a farewell — so they are never drawn down: all of them play,
 * and they are mixed in with the draw rather than bolted on at the end.
 *
 * **Round labels are dropped.** A question's `round` puts a round card on the
 * Desktop wherever the label changes, which suits a set written in rounds and
 * not a shuffled one: History, Deep cuts and IBM interleaved would put a card
 * up before nearly every question.
 *
 * Tiebreakers (`"tiebreak": true`) are lifted out of the scored set by the
 * engine and only feed sudden death, so they are never part of the draw or the
 * shuffle and always come along.
 *
 * What this checks is only what it needs to do its job — a JSON object with a
 * `questions` array. Every rule about a question is the server importer's, and
 * it reports them when staging uploads the result.
 */

import { randomInt } from "node:crypto";

/** How many questions are drawn from the shared bank, unless an event says otherwise. */
export const QUESTION_COUNT = 20;

const isTiebreak = (q) =>
  q !== null && typeof q === "object" && q.tiebreak === true;

/**
 * The `questions` array of a question file, or an error naming the file.
 *
 * @param {string} raw
 * @param {string} name
 * @returns {{ ok: true, bank: Record<string, unknown>, questions: unknown[] } | { ok: false, error: string }}
 */
export function readBank(raw, name) {
  let bank;
  try {
    bank = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `${name} is not valid JSON — ${err.message}` };
  }
  if (
    bank === null ||
    typeof bank !== "object" ||
    Array.isArray(bank) ||
    !Array.isArray(bank.questions)
  ) {
    return {
      ok: false,
      error: `${name} needs to be an object with a "questions" array.`,
    };
  }
  return { ok: true, bank, questions: bank.questions };
}

/**
 * @param {unknown[]} items
 * @param {(n: number) => number} pick a uniform integer in [0, n)
 */
function shuffle(items, pick) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A question without its round label. */
function unlabelled(q) {
  if (q === null || typeof q !== "object" || !("round" in q)) return q;
  const { round: _round, ...rest } = q;
  return rest;
}

/**
 * @param {{ bank: Record<string, unknown>, questions: unknown[] }} shared the shared bank, read
 * @param {unknown[]} additional the event's own questions; empty when it has none
 * @param {number} count how many scored questions to draw from the shared bank
 * @param {(n: number) => number} [pick] a uniform integer in [0, n); tests pass their own
 * @returns {{ raw: string, drawn: number, of: number, additional: number, tiebreakers: number }}
 */
export function drawQuestions(shared, additional, count, pick = randomInt) {
  const bankScored = shared.questions.filter((q) => !isTiebreak(q));
  const bankTiebreak = shared.questions.filter(isTiebreak);
  const extraScored = additional.filter((q) => !isTiebreak(q));
  const extraTiebreak = additional.filter(isTiebreak);

  const drawn = shuffle(bankScored, pick).slice(0, count);
  const scored = shuffle([...drawn, ...extraScored], pick).map(unlabelled);
  const questions = [...scored, ...bankTiebreak, ...extraTiebreak];
  return {
    raw: `${JSON.stringify({ ...shared.bank, questions }, null, 2)}\n`,
    drawn: drawn.length,
    of: bankScored.length,
    additional: extraScored.length,
    tiebreakers: bankTiebreak.length + extraTiebreak.length,
  };
}
