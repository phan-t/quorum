/**
 * `sendoff.json` -> `SendoffContent`. See docs/sendoff.md "The file".
 *
 * Written to the same three rules as the question importer, for the same
 * reason — a send-off is read to a room once, in front of the person it is
 * about, and there is no second attempt:
 *
 * 1. **All or nothing.** Every message and every photo key is validated and
 *    the whole file is rejected with addressed errors, rather than loading
 *    what parsed. A montage with photo 19 missing is discovered live.
 * 2. **Photos are keys, never bytes.** What comes out of here is filenames.
 *    The images are uploaded separately and served over HTTP; see
 *    `SendoffContent` and the asset endpoints.
 * 3. **Unknown keys are errors.** A file with `"music"` at the top level is a
 *    file whose author believes they set a track. Silently ignoring it is how
 *    a montage runs in silence in front of thirty people.
 *
 * Pure. No fs: the caller supplies the text.
 */

import type { Kudo, SendoffContent } from "../engine/types.ts";
import { assetKeyProblem } from "../server/store/types.ts";

/* ------------------------------------------------------------------ */
/* The format                                                          */
/* ------------------------------------------------------------------ */

/** Keys the top-level object may carry. */
export const FILE_KEYS = ["for", "opening", "kudos", "closing"] as const;
export const FOR_KEYS = ["name", "subtitle"] as const;
export const OPENING_KEYS = ["photos", "music", "seconds"] as const;
export const CLOSING_KEYS = ["photos", "line"] as const;
export const KUDO_KEYS = ["from", "message"] as const;

export const MAX_NAME_CHARS = 80;
export const MAX_SUBTITLE_CHARS = 120;
export const MAX_FROM_CHARS = 80;
/**
 * The longest one message may be.
 *
 * The real set's longest is 745 characters and the Desktop's smallest type
 * step starts at 520, so this is roughly triple the longest thing anybody has
 * actually written. Past it the message stops being a message: it does not fit
 * a screen at any size the back of a video call can read.
 */
export const MAX_MESSAGE_CHARS = 2_000;
export const MAX_LINE_CHARS = 280;
export const MAX_KUDOS = 100;
/** Per montage. Each photo is an upload and a row; 200 is already minutes. */
export const MAX_PHOTOS = 200;

export const DEFAULT_OPENING_SECONDS = 40;
export const MIN_OPENING_SECONDS = 5;
export const MAX_OPENING_SECONDS = 300;

/**
 * Extensions a photo key may end in.
 *
 * Checked because the extension is the only thing staging has to work out a
 * content type from, and a photo uploaded as `application/octet-stream` is a
 * photo the browser downloads instead of drawing. Being told here beats an
 * empty frame in the montage.
 */
export const PHOTO_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"] as const;
/** Same reasoning. An `<audio>` element will not play an unknown type either. */
export const MUSIC_EXTENSIONS = [".mp3", ".m4a", ".aac", ".ogg", ".oga", ".wav", ".flac"] as const;

/* ------------------------------------------------------------------ */
/* Result                                                              */
/* ------------------------------------------------------------------ */

export interface SendoffImportError {
  /** 1-based position in `kudos`, or null for a problem elsewhere. */
  readonly kudo: number | null;
  /** The offending key, dotted from the top of the file, or null. */
  readonly field: string | null;
  readonly message: string;
}

export type SendoffImportResult =
  | { readonly ok: true; readonly content: SendoffContent }
  | { readonly ok: false; readonly errors: readonly SendoffImportError[] };

/**
 * One error per line, rendered the way the host console lists them.
 *
 * Addressed by position rather than by the message's text, exactly as the
 * question importer is: the text is the thing most likely to be wrong, or
 * missing, in an entry that failed to load — and a kudo's text is somebody's
 * words about a colleague, which is not a thing to echo back in an error.
 *
 * Unlike a question file, a send-off has named sections as well as a list, so
 * a whole-file error names its section. `questions: This must be a list.` adds
 * nothing to a file that has one list; `closing.photos: …` is the difference
 * between two places to look and one.
 */
export function formatErrors(errors: readonly SendoffImportError[]): string[] {
  return errors.map((e) => {
    if (e.kudo === null) return e.field === null ? e.message : `${e.field}: ${e.message}`;
    const where = `Kudo ${e.kudo}`;
    return e.field === null ? `${where}: ${e.message}` : `${where}, ${e.field}: ${e.message}`;
  });
}

/**
 * Every asset key a loaded send-off refers to, in upload order, deduplicated.
 *
 * One list rather than three, because every caller wants the same thing: the
 * set of files that has to exist beside the JSON for the segment to run.
 */
export function sendoffAssetKeys(content: SendoffContent): string[] {
  const keys: string[] = [];
  const add = (k: string | null): void => {
    if (k !== null && !keys.includes(k)) keys.push(k);
  };
  for (const p of content.opening.photos) add(p);
  add(content.opening.music);
  for (const p of content.closing.photos) add(p);
  return keys;
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

export function importSendoffJson(text: string): SendoffImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errors: [{ kudo: null, field: null, message: `This is not valid JSON — ${detail}` }],
    };
  }

  if (!isRecord(parsed)) {
    return {
      ok: false,
      errors: [
        {
          kudo: null,
          field: null,
          message: 'The file must be an object with a "kudos" list. See docs/sendoff.md.',
        },
      ],
    };
  }

  const errors: SendoffImportError[] = [];
  const fail = (field: string | null, message: string): void => {
    errors.push({ kudo: null, field, message });
  };

  unknownKeys(parsed, FILE_KEYS, null, fail);

  /* who it is for */
  const { name, subtitle } = readFor(parsed["for"], fail);

  /* the opening montage */
  const opening = readOpening(parsed["opening"], fail);

  /* the messages */
  const kudos = readKudos(parsed["kudos"], errors, fail);

  /* the closing montage */
  const closing = readClosing(parsed["closing"], fail);

  // The same condition the reducer refuses on, checked here so it cannot be
  // reached from an upload: an engine rejection arrives as one sentence with
  // no address, and everything else this importer says names a line to fix.
  //
  // Only when nothing else is wrong. A file whose one photo has the wrong
  // extension is empty *because* of that, and saying so twice — once with an
  // address and once without — reads as two problems.
  if (errors.length === 0 && kudos.length === 0 && opening.photos.length === 0) {
    fail(null, "This send-off has no messages and no opening photos, so there is nothing to show.");
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, content: { name, subtitle, opening, kudos, closing } };
}

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

type Fail = (field: string | null, message: string) => void;

/**
 * `for`, which is required.
 *
 * Alone among the sections: docs/sendoff.md says every field except `kudos` is
 * optional, and that is about photos and music. A send-off is a segment about
 * one person, and a file that does not say who is one somebody stopped writing
 * halfway.
 */
function readFor(raw: unknown, fail: Fail): { name: string; subtitle: string | null } {
  if (raw === undefined || raw === null) {
    fail("for", 'Missing. A send-off is about somebody: give a "for" with their "name".');
    return { name: "", subtitle: null };
  }
  if (!isRecord(raw)) {
    fail("for", "This is not an object.");
    return { name: "", subtitle: null };
  }
  unknownKeys(raw, FOR_KEYS, "for", fail);

  const name = readText(raw["name"], "for.name", MAX_NAME_CHARS, fail);
  if (name === null || name === "") {
    fail("for.name", "Missing, blank, or not a string.");
  }
  const subtitle = readOptionalText(raw["subtitle"], "for.subtitle", MAX_SUBTITLE_CHARS, fail);
  return { name: name ?? "", subtitle };
}

function readOpening(raw: unknown, fail: Fail): SendoffContent["opening"] {
  if (raw === undefined || raw === null) {
    return { photos: [], seconds: DEFAULT_OPENING_SECONDS, music: null };
  }
  if (!isRecord(raw)) {
    fail("opening", "This is not an object.");
    return { photos: [], seconds: DEFAULT_OPENING_SECONDS, music: null };
  }
  unknownKeys(raw, OPENING_KEYS, "opening", fail);

  const photos = readPhotos(raw["photos"], "opening.photos", fail);

  let music: string | null = null;
  const rawMusic = raw["music"];
  if (rawMusic !== undefined && rawMusic !== null) {
    if (typeof rawMusic !== "string") {
      fail("opening.music", `${JSON.stringify(rawMusic)} is not a filename.`);
    } else {
      const trimmed = rawMusic.trim();
      const problem = keyProblem(trimmed, MUSIC_EXTENSIONS);
      if (problem !== null) fail("opening.music", problem);
      else music = trimmed;
    }
  }

  let seconds = DEFAULT_OPENING_SECONDS;
  const rawSeconds = raw["seconds"];
  if (rawSeconds !== undefined && rawSeconds !== null) {
    if (!isWholeNumber(rawSeconds)) {
      fail("opening.seconds", `${JSON.stringify(rawSeconds)} is not a whole number of seconds.`);
    } else if (rawSeconds < MIN_OPENING_SECONDS || rawSeconds > MAX_OPENING_SECONDS) {
      fail(
        "opening.seconds",
        `${rawSeconds} is outside ${MIN_OPENING_SECONDS}–${MAX_OPENING_SECONDS} seconds.`,
      );
    } else {
      seconds = rawSeconds;
    }
  }

  // Music with nothing to play under it. docs/sendoff.md scopes the track to
  // the opening montage and the engine projects it nowhere else, so this file
  // would upload an audio track that can never be heard.
  if (music !== null && photos.length === 0) {
    fail("opening.music", "There is a track but no opening photos, so it would never play.");
  }

  return { photos, seconds, music };
}

function readClosing(raw: unknown, fail: Fail): SendoffContent["closing"] {
  if (raw === undefined || raw === null) return { photos: [], line: null };
  if (!isRecord(raw)) {
    fail("closing", "This is not an object.");
    return { photos: [], line: null };
  }
  unknownKeys(raw, CLOSING_KEYS, "closing", fail);
  return {
    photos: readPhotos(raw["photos"], "closing.photos", fail),
    line: readOptionalText(raw["line"], "closing.line", MAX_LINE_CHARS, fail),
  };
}

/**
 * One montage's photo list.
 *
 * Addressed by position within the list, the way the question importer
 * addresses answers: "Photo 19" is what somebody can count to in the file.
 */
function readPhotos(raw: unknown, field: string, fail: Fail): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    fail(field, "This must be a list of filenames.");
    return [];
  }
  if (raw.length > MAX_PHOTOS) {
    fail(field, `${raw.length} photos; the most is ${MAX_PHOTOS}.`);
  }

  const photos: string[] = [];
  const seen = new Set<string>();
  for (const [i, value] of raw.entries()) {
    const at = `Photo ${i + 1}`;
    if (typeof value !== "string") {
      fail(field, `${at} is not a filename.`);
      continue;
    }
    const trimmed = value.trim();
    const problem = keyProblem(trimmed, PHOTO_EXTENSIONS);
    if (problem !== null) {
      fail(field, `${at}: ${problem}`);
      continue;
    }
    // The same file twice in one montage is the copy-paste that happens while
    // assembling forty of them, and it shows as the same picture twice in a
    // row on a shared screen.
    if (seen.has(trimmed)) {
      fail(field, `${at} is "${trimmed}", which is already in this montage.`);
      continue;
    }
    seen.add(trimmed);
    photos.push(trimmed);
  }
  return photos;
}

function readKudos(raw: unknown, errors: SendoffImportError[], fail: Fail): Kudo[] {
  if (raw === undefined) {
    fail("kudos", 'Missing. The file has no "kudos" list.');
    return [];
  }
  if (!Array.isArray(raw)) {
    fail("kudos", "This must be a list.");
    return [];
  }
  if (raw.length > MAX_KUDOS) {
    fail("kudos", `${raw.length} messages; the most is ${MAX_KUDOS}.`);
  }

  const kudos: Kudo[] = [];
  for (const [i, entry] of raw.entries()) {
    const before = errors.length;
    const kudo = readKudo(i + 1, entry, errors);
    if (kudo && errors.length === before) kudos.push(kudo);
  }
  return kudos;
}

function readKudo(at: number, raw: unknown, errors: SendoffImportError[]): Kudo | null {
  const fail: Fail = (field, message) => {
    errors.push({ kudo: at, field, message });
  };

  if (!isRecord(raw)) {
    fail(null, "This is not a message object.");
    return null;
  }
  unknownKeys(raw, KUDO_KEYS, null, (field, message) => fail(field, message));

  const from = readText(raw["from"], "from", MAX_FROM_CHARS, fail);
  if (from === null || from === "") {
    // Unsigned is not anonymous, it is unfinished: the Desktop draws a name
    // under every message and an empty one reads as the message having been
    // cut off.
    fail("from", "Missing, blank, or not a string. Every message is signed.");
  }
  const message = readText(raw["message"], "message", MAX_MESSAGE_CHARS, fail);
  if (message === null || message === "") {
    fail("message", "Missing, blank, or not a string.");
  }

  if (from === null || from === "" || message === null || message === "") return null;
  return { from, message };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function unknownKeys(
  raw: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string | null,
  fail: Fail,
): void {
  for (const key of Object.keys(raw)) {
    if (allowed.includes(key)) continue;
    fail(
      prefix === null ? key : `${prefix}.${key}`,
      `Nothing reads a "${key}" key. Expected ${allowed.join(", ")}. Check the spelling.`,
    );
  }
}

/**
 * A required string, trimmed. Null when it is not a string at all.
 *
 * Returns `""` for a present-but-blank value so the caller can tell the two
 * apart in its message — "not a string" and "blank" are different mistakes.
 */
function readText(raw: unknown, field: string, limit: number, fail: Fail): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (glyphs(trimmed) > limit) {
    fail(field, `${glyphs(trimmed)} characters; the limit is ${limit}.`);
  }
  return trimmed;
}

function readOptionalText(
  raw: unknown,
  field: string,
  limit: number,
  fail: Fail,
): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    fail(field, `${JSON.stringify(raw)} is not a string.`);
    return null;
  }
  const trimmed = raw.trim();
  if (glyphs(trimmed) > limit) {
    fail(field, `${glyphs(trimmed)} characters; the limit is ${limit}.`);
    return null;
  }
  return trimmed === "" ? null : trimmed;
}

/**
 * Why this filename is not a usable asset key, or null.
 *
 * The path rules come from the store, so the importer and the upload route
 * cannot drift; the extension rule is this file's, because only the importer
 * knows whether it is looking at a picture or a track.
 */
function keyProblem(key: string, extensions: readonly string[]): string | null {
  const problem = assetKeyProblem(key);
  if (problem !== null) return problem;
  const lower = key.toLowerCase();
  if (!extensions.some((ext) => lower.endsWith(ext))) {
    return `"${key}" does not end in ${extensions.join(", ")}.`;
  }
  return null;
}

/** Code points, not UTF-16 units: a limit is about what fits on a screen. */
function glyphs(s: string): number {
  return [...s].length;
}

function isWholeNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
