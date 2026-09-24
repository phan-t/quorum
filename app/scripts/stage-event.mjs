#!/usr/bin/env node
/**
 * Stage an event: create the session, push everything it needs, print the
 * four things you cannot get back.
 *
 * One command, run from a terminal before the room arrives, because that is
 * what prestaging means. A browser upload cannot be prestaged — it needs a
 * person clicking at nine in the morning — and everything here can be run
 * twice, from a script, or by somebody who is not the person who wrote it.
 *
 * Reads `config/events/<event>/session.json`. Writes nothing.
 */

import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");

function die(msg) {
  process.stderr.write(`\n  ${msg}\n\n`);
  process.exit(1);
}

const event = process.env["EVENT"];
if (!event) die("Set EVENT. For example: make stage EVENT=2026-09-25-sa-apj-huddle");

const url = (process.env["QUORUM_URL"] ?? "").replace(/\/$/, "");
if (!url) die("Set QUORUM_URL — `make stage` reads it from the Terraform output.");

const adminKey = process.env["QUORUM_ADMIN_KEY"];
if (!adminKey) die("Set QUORUM_ADMIN_KEY — `make stage` reads it from SSM.");

const dir = join(REPO, "config", "events", event);
const read = (name) => {
  try {
    return readFileSync(join(dir, name), "utf8");
  } catch {
    return null;
  }
};

const sessionRaw = read("session.json");
if (sessionRaw === null) die(`No config/events/${event}/session.json`);

let session;
try {
  session = JSON.parse(sessionRaw);
} catch (err) {
  die(`session.json is not valid JSON — ${err.message}`);
}

const title = typeof session.title === "string" ? session.title : null;
if (!title) die("session.json needs a \"title\".");

// The questions travel in their own file, because that is the file people edit
// and because the importer's errors are about questions, not about setup.
const questionsFile =
  typeof session.questions === "string" ? session.questions : "trivia-questions.json";
const questionsRaw = read(questionsFile);
if (questionsRaw === null) die(`No config/events/${event}/${questionsFile}`);

const post = async (path, body, token, contentType = "application/json") => {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": contentType },
    body,
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not json; the text is the error */
  }
  return { ok: res.ok, status: res.status, body: parsed, text };
};

/* 1 — the session, with the console's setup staged onto it */
const created = await post(
  "/api/sessions",
  JSON.stringify({ title, ...(session.console ? { setup: session.console } : {}) }),
  adminKey,
);
if (!created.ok) die(`Creating the session failed (${created.status}): ${created.text}`);
const { sid, joinCode, hostToken, screenToken } = created.body;

/* 2 — the questions */
const loaded = await post(
  `/api/sessions/${encodeURIComponent(sid)}/content/trivia`,
  questionsRaw,
  hostToken,
);
if (!loaded.ok) {
  const errors = loaded.body?.errors ?? [loaded.text];
  process.stderr.write(
    `\n  The session was created but the questions were not loaded.\n` +
      `  Nothing was half-loaded — fix ${questionsFile} and re-run the upload.\n\n` +
      errors.map((e) => `    ${e}\n`).join("") +
      `\n  sid        ${sid}\n  hostToken  ${hostToken}\n\n`,
  );
  process.exit(1);
}

/* 3 — what you cannot get back */
const line = "─".repeat(72);
process.stdout.write(
  `\n${line}\n` +
    `  ${title}\n` +
    `  ${loaded.body.questions} questions loaded\n` +
    `${line}\n\n` +
    `  Console    ${url}/host#${hostToken}\n` +
    `  Desktop    ${url}/screen#${screenToken}\n` +
    `  Join link  ${url}/j/${joinCode}\n\n` +
    `  sid        ${sid}\n\n` +
    `  Keep these. There is no endpoint that returns them.\n` +
    `  The console and Desktop links are secrets — never screen-share the console.\n\n`,
);
