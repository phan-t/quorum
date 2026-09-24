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
import { join, dirname, resolve, sep } from "node:path";

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
// A second line for what is not the name: a date, a time, a place. Optional.
const subtitle =
  typeof session.subtitle === "string" && session.subtitle.trim() !== ""
    ? session.subtitle.trim()
    : null;
if (!title) die("session.json needs a \"title\".");

// The questions travel in their own file, because that is the file people edit
// and because the importer's errors are about questions, not about setup.
const questionsFile =
  typeof session.questions === "string" ? session.questions : "trivia-questions.json";
const questionsRaw = read(questionsFile);
if (questionsRaw === null) die(`No config/events/${event}/${questionsFile}`);

/** The bytes of a file in the event directory, or null if it is not there. */
const readBinary = (name) => {
  // Resolved and checked, because the name comes out of a JSON file: a key of
  // `../../.ssh/id_rsa` would otherwise be read off this laptop and uploaded
  // to a public endpoint. The server refuses such a key too; this is the half
  // of the check that protects the machine rather than the table.
  const abs = resolve(dir, name);
  if (abs !== resolve(dir) && !abs.startsWith(resolve(dir) + sep)) return null;
  try {
    return readFileSync(abs);
  } catch {
    return null;
  }
};

/**
 * The content type for an asset, from its extension.
 *
 * The extension is all there is to go on, which is why the send-off importer
 * refuses a photo or a track whose extension it does not know: anything that
 * arrives as `application/octet-stream` is downloaded by the browser rather
 * than drawn, and a montage of download prompts is not a montage.
 */
const ASSET_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
};

const assetType = (key) => {
  const dot = key.lastIndexOf(".");
  return (dot < 0 ? null : ASSET_TYPES[key.slice(dot).toLowerCase()]) ?? "application/octet-stream";
};

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
  JSON.stringify({ title, ...(subtitle ? { subtitle } : {}), ...(session.console ? { setup: session.console } : {}) }),
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

/* 3 — the promo card, if this event has one.
 *
 * Optional and non-fatal, both deliberately. Optional because an event without
 * a poster stages exactly as it did before this existed. Non-fatal because of
 * where in the run it sits: the session is already created and its questions
 * are already loaded, so failing here would leave the operator with a staged
 * session and a script that exited 1 — and the obvious response to that,
 * re-running staging, creates a *second* session with different tokens and a
 * different join code. So it warns, prints the one command that fixes it, and
 * lets the rest of the run finish.
 */
const named = typeof session.promo === "string";
const promoFile =
  session.promo === false ? null : named ? session.promo : "promo-card.html";
const promoRaw = promoFile === null ? null : read(promoFile);
let promoLine = "";

if (promoFile !== null && promoRaw === null && named) {
  // Silent when it is just the default that is absent — that is the ordinary
  // case. Loud when session.json named a file, because somebody meant it.
  process.stderr.write(
    `\n  No config/events/${event}/${promoFile} — staging without a promo card.\n`,
  );
}

if (promoRaw !== null) {
  let up;
  try {
    up = await post(
      `/api/sessions/${encodeURIComponent(sid)}/content/promo`,
      promoRaw,
      hostToken,
      "text/html",
    );
  } catch (err) {
    up = { ok: false, status: 0, body: null, text: err.message };
  }
  if (up.ok) {
    promoLine = `  promo card ${promoFile}, ${up.body?.chars ?? promoRaw.length} characters\n`;
  } else {
    process.stderr.write(
      `\n  The promo card was not uploaded (${up.status}): ${up.text}\n` +
        `  The session and its questions are staged. Do NOT re-run staging —\n` +
        `  that creates a second session. Retry just this upload:\n\n` +
        `    curl -X POST "$QUORUM_URL/api/sessions/${sid}/content/promo" \\\n` +
        `      -H "Authorization: Bearer $HOST_TOKEN" \\\n` +
        `      -H 'content-type: text/html' \\\n` +
        `      --data-binary @config/events/${event}/${promoFile}\n`,
    );
  }
}

/* 4 — the send-off, if this event has one.
 *
 * Optional and non-fatal for exactly the promo card's reasons, and slower than
 * everything else here put together: the file is a few kilobytes and the
 * photos it names are several megabytes, one request each. So it reports
 * progress, and a photo that fails is named rather than swallowed — a montage
 * with a hole in it is a hole that shows up on a shared screen.
 */
const sendoffNamed = typeof session.sendoff === "string";
const sendoffFile =
  session.sendoff === false ? null : sendoffNamed ? session.sendoff : "sendoff.json";
const sendoffRaw = sendoffFile === null ? null : read(sendoffFile);
let sendoffLine = "";

if (sendoffFile !== null && sendoffRaw === null && sendoffNamed) {
  // Silent when it is only the default that is absent — the ordinary case.
  // Loud when session.json named a file, because somebody meant it.
  process.stderr.write(
    `\n  No config/events/${event}/${sendoffFile} — staging without a send-off.\n`,
  );
}

if (sendoffRaw !== null) {
  const retry =
    `    curl -X POST "$QUORUM_URL/api/sessions/${sid}/content/sendoff" \\\n` +
    `      -H "Authorization: Bearer $HOST_TOKEN" \\\n` +
    `      -H 'content-type: application/json' \\\n` +
    `      --data-binary @config/events/${event}/${sendoffFile}\n`;

  let up;
  try {
    up = await post(
      `/api/sessions/${encodeURIComponent(sid)}/content/sendoff`,
      sendoffRaw,
      hostToken,
    );
  } catch (err) {
    up = { ok: false, status: 0, body: null, text: err.message };
  }

  if (!up.ok) {
    // The importer's errors are addressed by message and by section, so they
    // are printed as they came rather than summarised into one line.
    const errors = up.body?.errors ?? [up.text];
    process.stderr.write(
      `\n  The send-off was not loaded (${up.status}).\n` +
        `  Nothing was half-loaded — fix ${sendoffFile} and re-run just this upload.\n` +
        `  The session and its questions are staged. Do NOT re-run staging.\n\n` +
        errors.map((e) => `    ${e}\n`).join("") +
        `\n${retry}`,
    );
  } else {
    // The server hands back the keys the file refers to, so what gets uploaded
    // is the server's reading of the file rather than a second parser here
    // that could quietly disagree with it.
    const keys = up.body?.assets ?? [];
    const photos = up.body?.photos ?? 0;
    const failures = [];
    let done = 0;

    if (keys.length > 0) {
      process.stdout.write(
        `\n  uploading ${photos} photo${photos === 1 ? "" : "s"}` +
          `${up.body?.music ? " and the music file" : ""}…\n`,
      );
    }

    const upload = async (key) => {
      const bytes = readBinary(key);
      if (bytes === null) {
        failures.push(`${key} — no such file in the event directory`);
        return;
      }
      // Three attempts, backing off. Forty-three uploads over a real network
      // is not forty-three uploads over localhost: staging this event against
      // the deployed service dropped seven of them on the first run and every
      // one of those seven succeeded on a straight retry. Nothing about them
      // was different — same sizes as their neighbours, no pattern, no 4xx.
      //
      // Retrying matters more here than the failure count suggests, because a
      // missing photo is invisible afterwards: the montage preloads each key
      // and silently steps over one that 404s, which is the right behaviour on
      // a shared screen and means nobody would ever notice the gap. This
      // report is the only place a dropped upload shows up at all.
      //
      // A 4xx is not retried. The file is too big, or the key is wrong, or the
      // token is: none of those get better by asking again.
      let res;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          res = await post(
            `/api/sessions/${encodeURIComponent(sid)}/assets/${encodeURIComponent(key)}`,
            bytes,
            hostToken,
            assetType(key),
          );
        } catch (err) {
          res = { ok: false, status: 0, body: null, text: err.message };
        }
        if (res.ok) break;
        if (res.status >= 400 && res.status < 500) break;
        if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 400));
      }
      if (!res.ok) {
        failures.push(
          `${key} — ${res.status} ${res.body?.error ?? res.text}` +
            (res.status === 413
              ? ` (${bytes.length} bytes; downscale it to about 1200px wide)`
              : ""),
        );
      }
      done += 1;
      // Only on a terminal. Redirected into a file, a line per photo is
      // forty-three lines of noise around the four that matter.
      if (process.stdout.isTTY) process.stdout.write(`\r    ${done}/${keys.length}`);
    };

    // Four at a time. Sequential is a long minute for forty-three photos over
    // a conference connection; many more at once is how a laptop's uplink
    // starts timing them out instead of sending them.
    const queue = [...keys];
    await Promise.all(
      Array.from({ length: Math.min(4, queue.length) }, async () => {
        for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
          await upload(key);
        }
      }),
    );
    if (process.stdout.isTTY && keys.length > 0) process.stdout.write("\r[K");

    if (failures.length > 0) {
      process.stderr.write(
        `\n  ${failures.length} of ${keys.length} send-off assets did not upload:\n\n` +
          failures.map((f) => `    ${f}\n`).join("") +
          `\n  Each was tried three times. The send-off itself is loaded, so do NOT\n` +
          `  re-run staging: that creates a second session. Re-upload these:\n\n` +
          `    curl -X POST "$QUORUM_URL/api/sessions/${sid}/assets/photos%2Fp01.jpg" \\\n` +
          `      -H "Authorization: Bearer $HOST_TOKEN" -H 'content-type: image/jpeg' \\\n` +
          `      --data-binary @config/events/${event}/photos/p01.jpg\n`,
      );
    }

    const uploaded = keys.length - failures.length;
    const messages = up.body?.kudos ?? 0;
    sendoffLine =
      `  send-off   ${messages} message${messages === 1 ? "" : "s"}, ` +
      `${uploaded} of ${keys.length} asset${keys.length === 1 ? "" : "s"} uploaded\n`;
  }
}

/* 5 — what you cannot get back */
const line = "─".repeat(72);
process.stdout.write(
  `\n${line}\n` +
    `  ${title}\n` +
    `  ${loaded.body.questions} questions loaded\n` +
    promoLine +
    sendoffLine +
    `${line}\n\n` +
    `  Console    ${url}/host#${hostToken}\n` +
    `  Desktop    ${url}/screen#${screenToken}\n` +
    `  Join link  ${url}/j/${joinCode}\n\n` +
    `  sid        ${sid}\n\n` +
    `  Keep these. There is no endpoint that returns them.\n` +
    `  The console and Desktop links are secrets — never screen-share the console.\n\n`,
);
