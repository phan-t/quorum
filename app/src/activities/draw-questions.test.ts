/**
 * The staging draw: a random subset of the shared bank's scored questions,
 * every additional question, shuffled together, round labels dropped, and
 * every tiebreaker kept.
 *
 * Every fixture below is invented, except the last test, which reads the
 * committed shared bank.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";

import {
  drawQuestions,
  QUESTION_COUNT,
  readBank,
} from "../../scripts/draw-questions.mjs";

type Q = { text: string; tiebreak?: boolean; round?: string };

const q = (text: string, extra: Record<string, unknown> = {}) => ({
  text,
  answers: ["a", "b", "c", "d"],
  correct: [0],
  timeLimitSec: 20,
  ...extra,
});

const shared = (questions: unknown[]) => ({
  bank: { title: "Test bank", questions },
  questions,
});

/** A deterministic `pick` that walks a fixed list of draws. */
const picks = (seq: number[]) => {
  let i = 0;
  return (n: number) => (seq[i++] ?? 0) % n;
};

const out = (raw: string) =>
  JSON.parse(raw) as { title: string; questions: Q[] };

const tens = Array.from({ length: 10 }, (_, i) => q(`B${i + 1}`));

describe("readBank", () => {
  it("reads an object with a questions array", () => {
    const r = readBank('{"questions": []}', "f.json");
    assert.ok(r.ok);
  });

  it("names the file when it cannot be read", () => {
    for (const raw of ["not json", "[]", '{"questions": "nope"}', "null"]) {
      const r = readBank(raw, "extra.json");
      assert.ok(!r.ok);
      assert.match(r.error, /extra\.json/);
    }
  });
});

describe("drawQuestions", () => {
  it("defaults to twenty", () => {
    assert.equal(QUESTION_COUNT, 20);
  });

  it("draws the count from the bank, without repeats", () => {
    const r = drawQuestions(shared(tens), [], 4);
    const texts = out(r.raw).questions.map((x) => x.text);
    assert.equal(texts.length, 4);
    assert.equal(new Set(texts).size, 4);
    assert.ok(texts.every((t) => t.startsWith("B")));
    assert.deepEqual([r.drawn, r.of, r.additional], [4, 10, 0]);
  });

  it("plays every additional question on top of the draw", () => {
    const extra = [q("E1"), q("E2"), q("E3")];
    const r = drawQuestions(shared(tens), extra, 4);
    const texts = out(r.raw).questions.map((x) => x.text);
    assert.equal(texts.length, 7);
    for (const e of ["E1", "E2", "E3"]) assert.ok(texts.includes(e));
    assert.deepEqual([r.drawn, r.additional], [4, 3]);
  });

  it("shuffles the additional questions in with the draw", () => {
    // Identity picks leave the draw in bank order; the second shuffle is the
    // one that mixes. A pick of 0 at every step moves each item to the front.
    const extra = [q("E1"), q("E2")];
    const r = drawQuestions(
      shared(tens.slice(0, 2)),
      extra,
      2,
      picks([1, 0, 0, 0, 0]),
    );
    const texts = out(r.raw).questions.map((x) => x.text);
    assert.notDeepEqual(texts, ["B1", "B2", "E1", "E2"]);
    assert.deepEqual([...texts].sort(), ["B1", "B2", "E1", "E2"]);
  });

  it("plays the whole bank when it has fewer than the count", () => {
    const r = drawQuestions(shared(tens.slice(0, 3)), [], 20);
    assert.equal(out(r.raw).questions.length, 3);
    assert.deepEqual([r.drawn, r.of], [3, 3]);
  });

  it("keeps every tiebreaker from both files, out of the draw and at the end", () => {
    const bank = [q("B1"), q("T1", { tiebreak: true }), q("B2"), q("B3")];
    const extra = [q("E1"), q("T2", { tiebreak: true })];
    const r = drawQuestions(shared(bank), extra, 2);
    const qs = out(r.raw).questions;
    assert.deepEqual(
      qs.slice(-2).map((x) => x.text),
      ["T1", "T2"],
    );
    assert.equal(qs.filter((x) => x.tiebreak !== true).length, 3);
    assert.deepEqual(
      [r.drawn, r.of, r.additional, r.tiebreakers],
      [2, 3, 1, 2],
    );
  });

  it("drops round labels from the shuffled set and keeps every other field", () => {
    const bank = [q("B1", { round: "History", note: "n" })];
    const extra = [q("E1", { round: "Farewell" })];
    const qs = out(drawQuestions(shared(bank), extra, 1).raw).questions;
    assert.ok(qs.every((x) => !("round" in x)));
    assert.deepEqual(
      qs.find((x) => x.text === "B1"),
      q("B1", { note: "n" }),
    );
  });

  it("keeps the shared bank's title", () => {
    assert.equal(
      out(drawQuestions(shared(tens), [], 2).raw).title,
      "Test bank",
    );
  });

  it("draws twenty scored questions and all four tiebreakers from the shared bank", () => {
    const here = dirname(new URL(import.meta.url).pathname);
    const path = resolve(
      here,
      "../../../config/event.example/trivia-questions.json",
    );
    const bank = readBank(readFileSync(path, "utf8"), path);
    assert.ok(bank.ok);
    const qs = out(drawQuestions(bank, [], QUESTION_COUNT).raw).questions;
    assert.equal(qs.filter((x) => x.tiebreak !== true).length, 20);
    assert.equal(qs.filter((x) => x.tiebreak === true).length, 4);
  });
});
