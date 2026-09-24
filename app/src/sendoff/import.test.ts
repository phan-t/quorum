/**
 * The send-off file importer.
 *
 * Same bias as the question importer's tests: a file that is wrong must fail
 * *here*, naming the message or the section, rather than load and be found out
 * in front of the room. So most of these are about rejection.
 *
 * Every fixture below is invented. `config/events/` is gitignored because its
 * content is messages real colleagues wrote about a real person, and this
 * repository is public — nothing from a real send-off belongs in a test file.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatErrors,
  importSendoffJson,
  MAX_KUDOS,
  MAX_PHOTOS,
  sendoffAssetKeys,
} from "./import.ts";

function ok(text: string) {
  const result = importSendoffJson(text);
  assert.ok(
    result.ok,
    `expected a load, got: ${result.ok ? "" : formatErrors(result.errors).join(" / ")}`,
  );
  return result.content;
}

function errs(text: string): string[] {
  const result = importSendoffJson(text);
  assert.ok(!result.ok, "expected a rejection");
  return formatErrors(result.errors);
}

const KUDO = { from: "Sam", message: "Thanks for every review you left on my terrible first PRs." };

const BASE = {
  for: { name: "Alex Rivera", subtitle: "Last day 30 September 2026" },
  opening: { photos: ["photos/a.jpg", "photos/b.jpg"], music: "send-off.mp3", seconds: 40 },
  kudos: [KUDO],
  closing: { photos: ["photos/c.jpg"], line: "See you around." },
};

/** `BASE`, with sections patched by the caller. */
function file(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...BASE, ...patch });
}

describe("what loads", () => {
  it("reads the documented shape", () => {
    const c = ok(file());
    assert.equal(c.name, "Alex Rivera");
    assert.equal(c.subtitle, "Last day 30 September 2026");
    assert.deepEqual(c.opening.photos, ["photos/a.jpg", "photos/b.jpg"]);
    assert.equal(c.opening.music, "send-off.mp3");
    assert.equal(c.opening.seconds, 40);
    assert.equal(c.kudos.length, 1);
    assert.deepEqual(c.kudos[0], KUDO);
    assert.deepEqual(c.closing.photos, ["photos/c.jpg"]);
    assert.equal(c.closing.line, "See you around.");
  });

  it("carries photo keys, never anything resembling bytes", () => {
    // The whole contract: a snapshot is replayed and broadcast, and what comes
    // out of here ends up inside one.
    for (const p of ok(file()).opening.photos) assert.equal(typeof p, "string");
  });

  it("loads a send-off that is only messages", () => {
    // docs/sendoff.md: "a send-off with no photos and no music is a list of
    // messages, which is still the thing."
    const c = ok(JSON.stringify({ for: { name: "Alex" }, kudos: [KUDO] }));
    assert.deepEqual(c.opening.photos, []);
    assert.equal(c.opening.music, null);
    assert.deepEqual(c.closing.photos, []);
    assert.equal(c.closing.line, null);
    assert.equal(c.subtitle, null);
  });

  it("loads a send-off that is only a montage", () => {
    const c = ok(
      JSON.stringify({ for: { name: "Alex" }, opening: { photos: ["p.jpg"] }, kudos: [] }),
    );
    assert.equal(c.kudos.length, 0);
    assert.equal(c.opening.photos.length, 1);
  });

  it("defaults the montage's length", () => {
    assert.equal(ok(JSON.stringify({ ...BASE, opening: { photos: ["p.jpg"] } })).opening.seconds, 40);
  });

  it("treats an explicit null music, subtitle and line as absent", () => {
    const c = ok(
      file({
        for: { name: "Alex", subtitle: null },
        opening: { photos: ["p.jpg"], music: null },
        closing: { photos: [], line: null },
      }),
    );
    assert.equal(c.opening.music, null);
    assert.equal(c.subtitle, null);
    assert.equal(c.closing.line, null);
  });

  it("trims names, messages and filenames", () => {
    const c = ok(
      file({
        for: { name: "  Alex  " },
        opening: { photos: ["  photos/a.jpg  "] },
        kudos: [{ from: " Sam ", message: "  Thank you.  " }],
      }),
    );
    assert.equal(c.name, "Alex");
    assert.deepEqual(c.opening.photos, ["photos/a.jpg"]);
    assert.deepEqual(c.kudos[0], { from: "Sam", message: "Thank you." });
  });

  it("accepts every photo extension it documents, in any case", () => {
    const photos = ["a.JPG", "b.jpeg", "c.png", "d.webp", "e.gif", "f.avif"];
    assert.equal(ok(file({ opening: { photos } })).opening.photos.length, 6);
  });

  it("accepts a bare filename as well as one in a folder", () => {
    assert.deepEqual(ok(file({ opening: { photos: ["p01.jpg"] } })).opening.photos, ["p01.jpg"]);
  });

  it("lists every asset key once, opening then music then closing", () => {
    assert.deepEqual(sendoffAssetKeys(ok(file())), [
      "photos/a.jpg",
      "photos/b.jpg",
      "send-off.mp3",
      "photos/c.jpg",
    ]);
  });

  it("does not list a bookend photo twice", () => {
    // The same picture opening and closing is a deliberate shape, unlike the
    // same picture twice inside one montage.
    const c = ok(
      file({
        opening: { photos: ["photos/a.jpg"] },
        closing: { photos: ["photos/a.jpg"] },
      }),
    );
    assert.deepEqual(sendoffAssetKeys(c), ["photos/a.jpg"]);
  });
});

describe("what is refused", () => {
  it("names the JSON error rather than saying the file is bad", () => {
    assert.match(errs("{ nope")[0] ?? "", /not valid JSON/);
  });

  it("refuses a file that is not an object", () => {
    assert.match(errs("[]")[0] ?? "", /must be an object/);
    assert.match(errs('"a string"')[0] ?? "", /must be an object/);
  });

  it("refuses a top-level key nothing reads", () => {
    // The point of the rule: a "music" at the top level is somebody who
    // believes they set a track, and a silent default is a silent montage.
    assert.match(
      errs(file({ music: "song.mp3" }))[0] ?? "",
      /^music: Nothing reads a "music" key/,
    );
  });

  it("refuses a misspelled section key rather than defaulting it", () => {
    assert.match(
      errs(file({ opening: { photos: ["p.jpg"], second: 20 } }))[0] ?? "",
      /^opening\.second: Nothing reads a "second" key/,
    );
  });

  it("refuses a misspelled key inside a message", () => {
    assert.match(
      errs(file({ kudos: [{ ...KUDO, name: "Sam" }] }))[0] ?? "",
      /^Kudo 1, name: Nothing reads a "name" key/,
    );
  });

  it("refuses a file with nobody to be about", () => {
    assert.match(errs(JSON.stringify({ kudos: [KUDO] }))[0] ?? "", /^for: Missing\./);
    assert.match(errs(file({ for: { subtitle: "x" } }))[0] ?? "", /^for\.name: Missing, blank/);
    assert.match(errs(file({ for: { name: "  " } }))[0] ?? "", /^for\.name: Missing, blank/);
  });

  it("refuses a missing kudos list", () => {
    assert.match(
      errs(JSON.stringify({ for: { name: "Alex" } }))[0] ?? "",
      /^kudos: Missing\. The file has no "kudos" list\./,
    );
  });

  it("refuses a kudos list that is not a list", () => {
    assert.match(errs(file({ kudos: {} }))[0] ?? "", /^kudos: This must be a list\./);
  });

  it("refuses a send-off with nothing in it at all", () => {
    // The same condition the reducer refuses on, caught here so it arrives
    // with an address instead of as one unaddressed sentence.
    assert.match(
      errs(JSON.stringify({ for: { name: "Alex" }, kudos: [] }))[0] ?? "",
      /no messages and no opening photos/,
    );
  });

  it("addresses a message's errors by its position", () => {
    const lines = errs(file({ kudos: [KUDO, { from: "Jo" }] }));
    assert.match(lines[0] ?? "", /^Kudo 2, message: Missing, blank, or not a string\./);
  });

  it("refuses an unsigned message", () => {
    assert.match(
      errs(file({ kudos: [{ from: "", message: "Thanks." }] }))[0] ?? "",
      /^Kudo 1, from: Missing, blank, or not a string\. Every message is signed\./,
    );
  });

  it("refuses a message that is not an object", () => {
    assert.match(errs(file({ kudos: ["Thanks!"] }))[0] ?? "", /^Kudo 1: This is not a message object\./);
  });

  it("refuses an over-long message, counting code points", () => {
    assert.match(
      errs(file({ kudos: [{ from: "Sam", message: "x".repeat(2001) }] }))[0] ?? "",
      /^Kudo 1, message: 2001 characters; the limit is 2000\./,
    );
    // Astral code points count once each, not twice.
    assert.equal(
      ok(file({ kudos: [{ from: "Sam", message: "🎉".repeat(2000) }] })).kudos[0]?.message.length,
      4000,
    );
  });

  it("refuses more messages than anyone would read aloud", () => {
    const many = Array.from({ length: MAX_KUDOS + 1 }, (_, i) => ({ from: `P${i}`, message: "Thanks." }));
    assert.match(errs(file({ kudos: many }))[0] ?? "", /101 messages; the most is 100\./);
  });

  it("refuses a photo list that is not a list", () => {
    assert.match(
      errs(file({ opening: { photos: "photos/a.jpg" } }))[0] ?? "",
      /^opening\.photos: This must be a list of filenames\./,
    );
  });

  it("addresses a bad photo by its position in the montage", () => {
    assert.match(
      errs(file({ opening: { photos: ["a.jpg", 7, "c.jpg"] } }))[0] ?? "",
      /^opening\.photos: Photo 2 is not a filename\./,
    );
  });

  it("refuses a photo with no extension it can serve", () => {
    // Staging has only the extension to work a content type out of, and a
    // photo served as octet-stream is a photo the browser downloads.
    assert.match(
      errs(file({ opening: { photos: ["photos/a.heic"] } }))[0] ?? "",
      /^opening\.photos: Photo 1: "photos\/a\.heic" does not end in \.jpg/,
    );
  });

  it("refuses a track with no extension it can serve", () => {
    assert.match(
      errs(file({ opening: { photos: ["a.jpg"], music: "track.aiff" } }))[0] ?? "",
      /^opening\.music: "track\.aiff" does not end in \.mp3/,
    );
  });

  it("refuses a path that climbs out of the event directory", () => {
    assert.match(
      errs(file({ opening: { photos: ["../../etc/passwd.jpg"] } }))[0] ?? "",
      /relative path segment/,
    );
    assert.match(
      errs(file({ opening: { photos: ["/etc/hosts.png"] } }))[0] ?? "",
      /cannot start with "\/"/,
    );
    assert.match(
      errs(file({ opening: { photos: ["photos\\a.jpg"] } }))[0] ?? "",
      /forward slashes/,
    );
  });

  it("refuses the same photo twice in one montage", () => {
    assert.match(
      errs(file({ opening: { photos: ["a.jpg", "a.jpg"] } }))[0] ?? "",
      /^opening\.photos: Photo 2 is "a\.jpg", which is already in this montage\./,
    );
  });

  it("refuses more photos than a montage could hold", () => {
    const many = Array.from({ length: MAX_PHOTOS + 1 }, (_, i) => `p${i}.jpg`);
    assert.match(errs(file({ opening: { photos: many } }))[0] ?? "", /201 photos; the most is 200\./);
  });

  it("refuses a montage length outside the range, and one that is not whole", () => {
    assert.match(errs(file({ opening: { photos: ["a.jpg"], seconds: 2 } }))[0] ?? "", /outside 5–300/);
    assert.match(errs(file({ opening: { photos: ["a.jpg"], seconds: 600 } }))[0] ?? "", /outside 5–300/);
    assert.match(errs(file({ opening: { photos: ["a.jpg"], seconds: 40.5 } }))[0] ?? "", /not a whole number/);
    assert.match(errs(file({ opening: { photos: ["a.jpg"], seconds: "40" } }))[0] ?? "", /not a whole number/);
  });

  it("refuses music with no montage to play under", () => {
    // The engine projects the track only during the opening, so this file
    // would upload a track that can never be heard.
    assert.match(
      errs(file({ opening: { photos: [], music: "song.mp3" } }))[0] ?? "",
      /^opening\.music: There is a track but no opening photos/,
    );
  });

  it("refuses a section that is not an object", () => {
    assert.match(errs(file({ opening: [] }))[0] ?? "", /^opening: This is not an object\./);
    assert.match(errs(file({ closing: "later" }))[0] ?? "", /^closing: This is not an object\./);
    assert.match(errs(file({ for: "Alex" }))[0] ?? "", /^for: This is not an object\./);
  });

  it("refuses an over-long name, subtitle and closing line", () => {
    assert.match(errs(file({ for: { name: "x".repeat(81) } }))[0] ?? "", /^for\.name: 81 characters/);
    assert.match(
      errs(file({ for: { name: "Alex", subtitle: "x".repeat(121) } }))[0] ?? "",
      /^for\.subtitle: 121 characters/,
    );
    assert.match(
      errs(file({ closing: { photos: [], line: "x".repeat(281) } }))[0] ?? "",
      /^closing\.line: 281 characters/,
    );
  });

  it("reports every problem at once, not just the first", () => {
    const lines = errs(
      JSON.stringify({
        for: { name: "" },
        opening: { photos: ["a.bmp"], seconds: 1 },
        kudos: [{ from: "Sam" }, { message: "Thanks." }],
      }),
    );
    assert.equal(lines.length, 5);
    assert.match(lines[0] ?? "", /^for\.name:/);
    assert.match(lines[1] ?? "", /^opening\.photos:/);
    assert.match(lines[2] ?? "", /^opening\.seconds:/);
    assert.match(lines[3] ?? "", /^Kudo 1, message:/);
    assert.match(lines[4] ?? "", /^Kudo 2, from:/);
  });

  it("loads nothing at all when one message is wrong", () => {
    const result = importSendoffJson(file({ kudos: [KUDO, { from: "Jo" }] }));
    assert.ok(!result.ok);
  });
});
