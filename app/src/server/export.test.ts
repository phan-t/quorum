/**
 * Export: the scoresheet and the event log.
 *
 * Expected behaviour comes from SCORING.md (normalisation, Bench Credit, Spot
 * Awards) and ARCHITECTURE.md's REST table, which fixes the CSV's shape as
 * `Name, <Activity> Raw, <Activity> Pts, …, Spot Awards, TOTAL` — the
 * spreadsheet this service replaces, so the columns land where the person who
 * has kept the scores for years expects them.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { newSession } from "../engine/reducer.ts";
import type { Event, SessionState } from "../engine/types.ts";
import {
  csvField,
  eventsJsonl,
  mergeEventLogs,
  scoresheetCsv,
  scoresheetFilename,
  scoresheetHeader,
} from "./export.ts";
import { reduce } from "../engine/reducer.ts";

const ACTIVITIES = [
  { id: "ttx", title: "Agentic Security TTX", kind: "manual" as const, spotCap: 2 },
  { id: "trivia", title: "Trivia", kind: "trivia" as const, spotCap: 2 },
];

function build(events: readonly Event[]): SessionState {
  let state = newSession({
    sid: "ses_export",
    title: "September Huddle",
    joinCode: "hvs.exportexportexportexport",
    activities: ACTIVITIES,
  });
  const at = 1_790_337_171_200;
  for (const e of events) state = reduce(state, e, at).state;
  return state;
}

const rows = (csv: string): string[] => csv.trimEnd().split("\r\n");

describe("the scoresheet", () => {
  it("has the columns the spreadsheet it replaces has", () => {
    const state = build([{ type: "open" }]);
    assert.deepEqual(scoresheetHeader(state), [
      "Name",
      "Agentic Security TTX Raw",
      "Agentic Security TTX Pts",
      "Trivia Raw",
      "Trivia Pts",
      "Spot Awards",
      "TOTAL",
    ]);
  });

  it("normalises per activity: the top raw is 100 and everyone scales to it", () => {
    // SCORING.md's worked example.
    const state = build([
      { type: "open" },
      { type: "start" },
      { type: "join", pid: "p1", nickname: "Priya" },
      { type: "join", pid: "p2", nickname: "Kenji" },
      { type: "join", pid: "p3", nickname: "Sam" },
      { type: "setScore", activityId: "trivia", pid: "p1", raw: 18400 },
      { type: "setScore", activityId: "trivia", pid: "p2", raw: 14720 },
      { type: "setScore", activityId: "trivia", pid: "p3", raw: 9200 },
    ]);
    const out = rows(scoresheetCsv(state));
    assert.equal(out[0], "Name,Agentic Security TTX Raw,Agentic Security TTX Pts,Trivia Raw,Trivia Pts,Spot Awards,TOTAL");
    assert.equal(out[1], "Priya,,,18400,100,0,100");
    assert.equal(out[2], "Kenji,,,14720,80,0,80");
    assert.equal(out[3], "Sam,,,9200,50,0,50");
  });

  it("carries Spot Awards in their own column and in the total", () => {
    const state = build([
      { type: "open" },
      { type: "start" },
      { type: "join", pid: "p1", nickname: "Priya" },
      { type: "setScore", activityId: "trivia", pid: "p1", raw: 100 },
      {
        type: "grantSpot",
        pid: "p1",
        activityId: "trivia",
        reason: "best recovery of the afternoon",
      },
    ]);
    assert.equal(rows(scoresheetCsv(state))[1], "Priya,,,100,100,10,110");
  });

  it("says `bench` in the raw column and still credits the points", () => {
    const state = build([
      { type: "open" },
      { type: "start" },
      { type: "join", pid: "p1", nickname: "Ade" },
      { type: "join", pid: "p2", nickname: "Kenji" },
      // Ade ran the TTX and played the trivia: credited their own average.
      { type: "setScore", activityId: "trivia", pid: "p1", raw: 90 },
      { type: "setScore", activityId: "trivia", pid: "p2", raw: 100 },
      { type: "setStatus", activityId: "ttx", pid: "p1", status: "bench" },
    ]);
    const line = rows(scoresheetCsv(state)).find((l) => l.startsWith("Ade,"));
    // 90 raw against a top of 100 is 90 points; the bench cell is credited 90.
    assert.equal(line, "Ade,bench,90,90,90,0,180");
  });

  it("leaves an unscored activity blank rather than writing a misleading zero", () => {
    const state = build([
      { type: "open" },
      { type: "start" },
      { type: "join", pid: "p1", nickname: "Priya" },
    ]);
    assert.equal(rows(scoresheetCsv(state))[1], "Priya,,,,,0,0");
  });

  it("leaves a kicked participant out", () => {
    const state = build([
      { type: "open" },
      { type: "start" },
      { type: "join", pid: "p1", nickname: "Priya" },
      { type: "join", pid: "p2", nickname: "Troll" },
      { type: "kick", pid: "p2" },
    ]);
    assert.equal(scoresheetCsv(state).includes("Troll"), false);
  });

  it("keeps someone whose nickname was released — the points are still theirs", () => {
    const state = build([
      { type: "open" },
      { type: "start" },
      { type: "join", pid: "p1", nickname: "Priya" },
      { type: "setScore", activityId: "trivia", pid: "p1", raw: 500 },
      { type: "releaseNickname", pid: "p1" },
    ]);
    assert.match(scoresheetCsv(state), /^Priya,,,500,100,0,100$/m);
  });

  it("is ordered by standing, highest first", () => {
    const state = build([
      { type: "open" },
      { type: "start" },
      { type: "join", pid: "p1", nickname: "Aaron" },
      { type: "join", pid: "p2", nickname: "Zoe" },
      { type: "setScore", activityId: "trivia", pid: "p1", raw: 10 },
      { type: "setScore", activityId: "trivia", pid: "p2", raw: 100 },
    ]);
    const out = rows(scoresheetCsv(state));
    assert.ok(out[1]?.startsWith("Zoe,"), "the leader comes first, not the alphabet");
  });

  it("ends every line with CRLF, as RFC 4180 and every spreadsheet want", () => {
    const state = build([
      { type: "open" },
      { type: "start" },
      { type: "join", pid: "p1", nickname: "Priya" },
    ]);
    const csv = scoresheetCsv(state);
    assert.ok(csv.endsWith("\r\n"));
    assert.equal(csv.includes("\n\n"), false);
  });

  it("names the file after the session", () => {
    const state = build([{ type: "open" }]);
    assert.equal(scoresheetFilename(state), "september-huddle-scores.csv");
  });
});

describe("CSV fields", () => {
  it("quotes a comma and doubles a quote", () => {
    assert.equal(csvField("Smith, Ade"), '"Smith, Ade"');
    assert.equal(csvField('Ade "Speedy"'), '"Ade ""Speedy"""');
    assert.equal(csvField("Priya"), "Priya");
  });

  it("defangs a nickname that would be read as a formula", () => {
    // A nickname is free text and this file is opened in Excel by definition.
    assert.equal(csvField("=1+1"), "'=1+1");
    assert.equal(csvField("@here"), "'@here");
    // A hyphen starts nothing that matters here, and mangling it would
    // corrupt ordinary names.
    assert.equal(csvField("-Ade"), "-Ade");
  });

  it("writes an empty cell for null, not the word null", () => {
    assert.equal(csvField(null), "");
    assert.equal(csvField(0), "0");
  });
});

describe("the event log", () => {
  const at = 1_790_337_171_200;

  it("is one JSON object per line, oldest first", () => {
    const out = eventsJsonl([
      { seq: 2, at, event: { type: "start" } },
      { seq: 1, at, event: { type: "open" } },
    ]);
    const lines = out.trimEnd().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0] ?? "{}"), {
      seq: 1,
      at,
      type: "open",
      event: { type: "open" },
    });
    assert.equal(JSON.parse(lines[1] ?? "{}").seq, 2);
  });

  it("is empty, not a blank line, when nothing happened", () => {
    assert.equal(eventsJsonl([]), "");
  });

  it("merges the stored log with whatever this process still has", () => {
    // After a restart the store holds the first half and memory the second.
    const merged = mergeEventLogs(
      [
        { seq: 1, at, event: { type: "open" } },
        { seq: 2, at, event: { type: "start" } },
      ],
      [
        { seq: 2, at, event: { type: "start" } },
        { seq: 3, at, event: { type: "setSeal", seal: "sealed" } },
      ],
    );
    assert.deepEqual(merged.map((r) => r.seq), [1, 2, 3]);
  });
});
