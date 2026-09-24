/**
 * `session.json`'s `activities` -> `Activity[]`. See docs/event-config.md.
 *
 * What a session scores used to be a constant in the server's source
 * (`DEFAULT_ACTIVITIES` in `src/server/runtime.ts`), which meant that an event
 * that wanted a different set was a code change and a deploy. It is per-event
 * configuration and it belongs in `session.json` beside the runbook, so this
 * is the parser for it. The constant stays as the default for a session that
 * does not say.
 *
 * Written to the same three rules as the question and send-off importers, for
 * the same reason — the set is fixed when the session is created and there is
 * no way to change it afterwards short of creating a second session, which
 * loses the join code and the tokens:
 *
 * 1. **All or nothing.** Every entry is validated and the whole list is
 *    rejected with addressed errors, rather than creating the session out of
 *    whatever parsed. A session created with three of its four activities is
 *    discovered when the fourth one will not open.
 * 2. **Unknown keys are errors.** A file with `"spotcap"` in it is a file
 *    whose author believes they set a Spot Award cap. Silently defaulting it
 *    to 2 is how a facilitator runs out of awards in front of the room.
 * 3. **Errors are addressed by position.** `Activity 3, kind: …`, in the
 *    file's own order, so what gets fixed is the entry rather than the guess.
 *
 * Unlike the other two importers this one takes already-parsed JSON rather
 * than text: the list arrives inside the `POST /api/sessions` body, which the
 * server has parsed before it gets here. There is no text to re-parse and no
 * second place for a JSON syntax error to be reported from.
 *
 * Pure. No fs, no clock.
 */

import type { Activity, ActivityKind } from "../engine/types.ts";

/* ------------------------------------------------------------------ */
/* The format                                                          */
/* ------------------------------------------------------------------ */

/** Keys an activity may carry. Anything else is rejected. */
export const ACTIVITY_KEYS = ["id", "title", "kind", "spotCap"] as const;

/**
 * The kinds the engine actually has, in `ActivityKind`'s own order.
 *
 * A typo'd kind is the failure this list exists to prevent: `"trvia"` is a
 * session whose trivia activity can never be opened, because the endpoint that
 * loads a question set looks for an activity whose kind is `trivia` and finds
 * none. Discovered when the questions are staged at best, and in the room at
 * worst.
 */
export const ACTIVITY_KINDS: readonly ActivityKind[] = ["trivia", "arcade", "manual"];

/**
 * Kinds the engine holds exactly one of.
 *
 * `SessionState.trivia` and `SessionState.arcade` are single slots, not maps
 * keyed by activity id, and the reducer treats them that way: `loadTrivia`
 * writes `state.trivia` outright, so a second trivia activity's question set
 * silently replaces the first one's; `enterArcade` refuses outright when
 * `state.arcade` is already running for another id, so a second arcade
 * activity can never be opened at all. Neither failure has an error message
 * that names the real cause, and both happen in front of the room. So the list
 * is refused here, where the message can say what is wrong.
 *
 * `manual` has no slot — it is scores typed in against an id — so any number
 * of manual activities is fine.
 */
export const SINGLE_SLOT_KINDS: readonly ActivityKind[] = ["trivia", "arcade"];

/**
 * What an id may look like.
 *
 * Lowercase letters, digits, `-` and `_`, starting with a letter or a digit.
 * Narrower than `ActivityId`, which is a bare `string`, because an id is not
 * only a key into `state.scores`: it is an `<option value>` in the console's
 * Spot Award picker, half of the `id:spotsLeft` pairs that picker joins with
 * commas and colons to decide whether it needs redrawing, and a field on every
 * scoring event on the wire. Keeping it to this set means none of those has to
 * think about quoting, and it means `Trivia` and `trivia` cannot be two
 * scoring buckets that read as one on screen.
 */
export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export const MAX_ID_CHARS = 32;
/**
 * The longest title.
 *
 * A title is a column header — twice over in the CSV export, as `<title> Raw`
 * and `<title> Pts` — and a chip in the console's scoring grid. The longest
 * one anybody has used is "Agentic Security TTX", at 20.
 */
export const MAX_TITLE_CHARS = 40;

/**
 * How many activities one session may score.
 *
 * Not a technical limit. Every activity is two columns in the export, a row in
 * the console's grid and a term in the tiebreak walk, and an event that thinks
 * it has nine scored activities in a ninety-minute huddle has made a different
 * mistake than a validation error can fix.
 */
export const MAX_ACTIVITIES = 8;

/** Spot Awards a facilitator may grant, when the entry does not say. */
export const DEFAULT_SPOT_CAP = 2;
/** 0 is legal and means a facilitator who grants none. */
export const MAX_SPOT_CAP = 10;

/* ------------------------------------------------------------------ */
/* Result                                                              */
/* ------------------------------------------------------------------ */

export interface ActivityImportError {
  /** 1-based position in the list, or null for a whole-list problem. */
  readonly activity: number | null;
  /** The offending key, or null for a whole-entry problem. */
  readonly field: string | null;
  readonly message: string;
}

export type ActivityImportResult =
  | { readonly ok: true; readonly activities: readonly Activity[] }
  | { readonly ok: false; readonly errors: readonly ActivityImportError[] };

/**
 * One error per line, rendered the way staging prints them.
 *
 * Addressed by position rather than by id or title, for the question
 * importer's reason: the id is the thing most likely to be wrong, or missing,
 * in an entry that failed to load.
 */
export function formatErrors(errors: readonly ActivityImportError[]): string[] {
  return errors.map((e) => {
    if (e.activity === null) return e.field === null ? e.message : `${e.field}: ${e.message}`;
    const where = `Activity ${e.activity}`;
    return e.field === null ? `${where}: ${e.message}` : `${where}, ${e.field}: ${e.message}`;
  });
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

export function importActivities(raw: unknown): ActivityImportResult {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      errors: [{ activity: null, field: null, message: "This must be a list of activities." }],
    };
  }
  // A session that scores nothing has no leaderboard, no Spot Award picker and
  // no tiebreak — and an empty list is far likelier to be a half-finished edit
  // than a decision.
  if (raw.length === 0) {
    return {
      ok: false,
      errors: [
        {
          activity: null,
          field: null,
          message:
            "The list is empty. A session needs at least one activity to score; leave the key out to take the default set.",
        },
      ],
    };
  }
  if (raw.length > MAX_ACTIVITIES) {
    return {
      ok: false,
      errors: [
        {
          activity: null,
          field: null,
          message: `${raw.length} activities; the most is ${MAX_ACTIVITIES}.`,
        },
      ],
    };
  }

  const errors: ActivityImportError[] = [];
  const activities: Activity[] = [];
  /** id -> the 1-based position that first claimed it. */
  const idsSeen = new Map<string, number>();
  /** kind -> the 1-based position that first used it, for the single slots. */
  const slotsSeen = new Map<ActivityKind, number>();

  for (const [i, entry] of raw.entries()) {
    const at = i + 1;
    const before = errors.length;
    const activity = readActivity(at, entry, errors, idsSeen, slotsSeen);
    if (activity && errors.length === before) activities.push(activity);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, activities };
}

/* ------------------------------------------------------------------ */
/* One activity                                                        */
/* ------------------------------------------------------------------ */

function readActivity(
  at: number,
  raw: unknown,
  errors: ActivityImportError[],
  idsSeen: Map<string, number>,
  slotsSeen: Map<ActivityKind, number>,
): Activity | null {
  const fail = (field: string | null, message: string): void => {
    errors.push({ activity: at, field, message });
  };

  if (!isRecord(raw)) {
    fail(null, "This is not an activity object.");
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (!(ACTIVITY_KEYS as readonly string[]).includes(key)) {
      fail(key, `Nothing reads a "${key}" key. Check the spelling.`);
    }
  }

  /* id */
  const id = readId(at, raw["id"], fail, idsSeen);

  /* title */
  const rawTitle = raw["title"];
  let title: string | null = null;
  if (typeof rawTitle !== "string") {
    fail("title", "Missing, or not a string.");
  } else {
    const trimmed = rawTitle.trim();
    if (trimmed === "") {
      // The title is what the room and the export call this activity. A blank
      // one is a leaderboard column with no header.
      fail("title", "The title is blank.");
    } else if (glyphs(trimmed) > MAX_TITLE_CHARS) {
      fail("title", `${glyphs(trimmed)} characters; the limit is ${MAX_TITLE_CHARS}.`);
    } else {
      title = trimmed;
    }
  }

  /* kind */
  const kind = readKind(at, raw["kind"], fail, slotsSeen);

  /* spotCap */
  let spotCap = DEFAULT_SPOT_CAP;
  const rawCap = raw["spotCap"];
  if (rawCap !== undefined && rawCap !== null) {
    if (!isWholeNumber(rawCap) || rawCap < 0) {
      fail("spotCap", `${JSON.stringify(rawCap)} is not a whole number of awards.`);
    } else if (rawCap > MAX_SPOT_CAP) {
      fail("spotCap", `${rawCap} awards; the most is ${MAX_SPOT_CAP}.`);
    } else {
      spotCap = rawCap;
    }
  }

  if (id === null || title === null || kind === null) return null;
  return { id, title, kind, spotCap };
}

/**
 * The id, checked against `ID_PATTERN` and against every id before it.
 *
 * Two activities sharing an id is the failure worth the most care here: the id
 * is the key into `state.scores`, so the pair become one scoring bucket that
 * both write to and that the export prints twice. Nothing downstream would
 * report it — the session would simply score wrongly, in a way that only shows
 * up as a total nobody can reconstruct.
 */
function readId(
  at: number,
  raw: unknown,
  fail: (field: string | null, message: string) => void,
  idsSeen: Map<string, number>,
): string | null {
  if (typeof raw !== "string") {
    fail("id", 'Missing, or not a string. Give a short name like "trivia".');
    return null;
  }
  const id = raw.trim();
  if (id === "") {
    fail("id", "The id is blank.");
    return null;
  }
  if (glyphs(id) > MAX_ID_CHARS) {
    fail("id", `${glyphs(id)} characters; the limit is ${MAX_ID_CHARS}.`);
    return null;
  }
  if (!ID_PATTERN.test(id)) {
    fail(
      "id",
      `"${id}" is not a usable id. Use lowercase letters, digits, "-" and "_", starting with a letter or a digit.`,
    );
    return null;
  }
  const first = idsSeen.get(id);
  if (first !== undefined) {
    fail("id", `"${id}" is already activity ${first}. Two activities with one id share one score.`);
    return null;
  }
  idsSeen.set(id, at);
  return id;
}

/**
 * The kind, checked against the engine's list and against the single slots.
 *
 * See `SINGLE_SLOT_KINDS` for why a second `trivia` or a second `arcade` is an
 * error here rather than a surprise later.
 */
function readKind(
  at: number,
  raw: unknown,
  fail: (field: string | null, message: string) => void,
  slotsSeen: Map<ActivityKind, number>,
): ActivityKind | null {
  if (typeof raw !== "string") {
    fail("kind", `Missing, or not a string. One of ${ACTIVITY_KINDS.join(", ")}.`);
    return null;
  }
  if (!(ACTIVITY_KINDS as readonly string[]).includes(raw)) {
    fail("kind", `"${raw}" is not an activity kind. Use ${ACTIVITY_KINDS.join(", ")}.`);
    return null;
  }
  const kind = raw as ActivityKind;
  if (SINGLE_SLOT_KINDS.includes(kind)) {
    const first = slotsSeen.get(kind);
    if (first !== undefined) {
      fail(
        "kind",
        `Activity ${first} is already the ${kind}. A session runs one ${kind}, and the second would never open.`,
      );
      return null;
    }
    slotsSeen.set(kind, at);
  }
  return kind;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Code points, not UTF-16 units — the same count the other importers use. */
function glyphs(s: string): number {
  return [...s].length;
}

function isWholeNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
