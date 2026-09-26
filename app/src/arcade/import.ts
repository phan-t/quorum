/**
 * `arcade-content.json` -> `ArcadeContent`. The arcade's half of what
 * `trivia/import.ts` does for a question file.
 *
 * All four rounds' content is a TypeScript literal in this directory, compiled
 * into the build, so changing an emoji cue or a Vault default has meant editing
 * `app/src` and deploying. Three of the six Gganbu prompts carry a VERIFY flag
 * *because their answers can move* — a release changes a configuration default
 * and says nothing — and needing a deploy to correct one of those is the
 * problem this removes. Trivia settled this shape long ago: stage the file over
 * HTTPS with the host token, validate it here, apply it as an engine event.
 *
 * Four rules, three of them `trivia/import.ts`'s own:
 *
 * 1. **Unknown keys are errors.** A file with `"timelimitSec"` in it is a file
 *    whose author believes they set a timer, and a file with `"verify_"` in it
 *    is a prompt whose author believes they flagged it. Silently defaulting
 *    either is how the room finds out.
 * 2. **All or nothing.** Every item in every staged round is validated and the
 *    file is rejected whole, rather than loading what parsed. A Gganbu bank
 *    with prompt 5 missing is discovered live, in front of everyone.
 * 3. **Every problem at once.** A host fixing one error per upload against a
 *    four-round file is a host reading the console instead of the room.
 * 4. **Addressed by round and index**, because a host stages four rounds in one
 *    file and "item 3" is four different items. The address is the path into the
 *    file they are editing — `gganbu[2]`, `glassBridge[4], panes[1].label` —
 *    which means the index is **0-based**: bracket notation that did not count
 *    the way the file's own array does would be a trap dressed as help.
 *
 * What this file does **not** do is decide what a round's content ought to say.
 * Every rule below is one of three things: a shape the types demand, an
 * invariant the engine already enforces at `startRound` and would rather
 * enforce at upload, or a property one of the round files argues for at length
 * in its own header. Where a round's reasoning is not mechanically checkable —
 * whether a Gganbu threshold really sits a plausible distance from its answer,
 * whether a "real" pane is real — this says so rather than approximating it.
 * See the comment above each round's reader.
 *
 * Pure. No fs: the caller supplies the text.
 */

import type {
  ArcadeContent,
  EmojiItem,
  GlassPane,
  GlassStep,
  OverUnder,
  OverUnderItem,
  UnsealItem,
  UnsealShape,
} from "../engine/types.ts";
import {
  UNSEAL_SHAPES,
  foldAnswer,
  isScrambleOf,
  unsealLetters,
} from "../engine/arcade.ts";

/* ------------------------------------------------------------------ */
/* The format                                                          */
/* ------------------------------------------------------------------ */

/** The rounds a file may stage. These are {@link ArcadeContent}'s keys. */
export const ROUND_KEYS = [
  "recruitment",
  "unseal",
  "glassBridge",
  "gganbu",
] as const;

export type ArcadeRound = (typeof ROUND_KEYS)[number];

/**
 * Keys the top-level object may carry.
 *
 * `title` is what the file is called, for the host's own benefit; nothing
 * reads it, exactly as nothing reads a question file's title. Everything else
 * is a round.
 */
export const FILE_KEYS = ["title", ...ROUND_KEYS] as const;

/** Keys a Recruitment item may carry. */
export const EMOJI_ITEM_KEYS = ["cue", "answer", "accept", "note"] as const;
/** Keys an Unseal tin may carry. */
export const UNSEAL_ITEM_KEYS = ["shape", "cue", "answer", "note"] as const;
/** Keys a Glass Bridge step may carry. */
export const GLASS_STEP_KEYS = ["product", "panes", "real"] as const;
/** Keys one pane of a step may carry. */
export const GLASS_PANE_KEYS = ["label", "note"] as const;
/** Keys a Gganbu prompt may carry. */
export const OVER_UNDER_KEYS = [
  "cue",
  "threshold",
  "answer",
  "note",
  "verify",
] as const;

/** Panes per step. Not a tunable: `GlassStep.panes` is a two-tuple. */
export const GLASS_PANES_PER_STEP = 2;

/**
 * The fewest tins a tier may hold, for a shape that appears at all.
 *
 * `arcade/unseal.ts` and `engine/unseal.test.ts` both argue this number: a tier
 * with one word in it is solved for everybody in it the moment one person says
 * that word out loud, which is how the circle shipped holding only RAFT. Two
 * was not enough either, because the circle is the tier the cautious pick and
 * in a room of thirty it is where most of the room is. Three is the floor.
 *
 * A shape a file leaves out **entirely** is not an error: `unsealView` marks a
 * shape with no tins `available: false` and the picker shows it greyed, so a
 * host running three tiers has made a choice rather than a broken file. A shape
 * with one or two tins is the failure, because the picker offers it.
 */
export const MIN_TINS_PER_SHAPE = 3;

/**
 * Which word lengths each tin holds. SPEC.md: "the shapes are word lengths."
 *
 * The bands are the round's whole conceit — the shape is picked *before* the
 * word is known, so what the shape promises is a length — and they are also
 * what keeps the scoring honest: `UNSEAL_SHAPE_SCORE` pays 10 / 20 / 35 / 50 by
 * shape, and a host who drops an eleven-letter word into a circle has written a
 * 50-point puzzle that pays 10. `engine/unseal.test.ts` holds the same table
 * against the compiled content.
 */
export const UNSEAL_TIERS: Readonly<
  Record<UnsealShape, { readonly holds: (letters: number) => boolean; readonly says: string }>
> = {
  circle: { holds: (n) => n === 4 || n === 5, says: "four or five letters" },
  triangle: { holds: (n) => n === 6, says: "six letters" },
  star: { holds: (n) => n === 8, says: "eight letters" },
  umbrella: { holds: (n) => n >= 11, says: "eleven letters or more" },
};

/** `over` and `under`, the only two sides a wager has. */
export const OVER_UNDER: readonly OverUnder[] = ["over", "under"];

/* ------------------------------------------------------------------ */
/* Result                                                              */
/* ------------------------------------------------------------------ */

export interface ImportError {
  /** Which round, or null for a whole-file problem. */
  readonly round: ArcadeRound | null;
  /** 0-based position in that round's list, or null for a whole-round problem. */
  readonly index: number | null;
  /** The offending key, or null for a whole-item problem. */
  readonly field: string | null;
  readonly message: string;
}

export type ImportResult =
  | { readonly ok: true; readonly content: ArcadeContent }
  | { readonly ok: false; readonly errors: readonly ImportError[] };

/**
 * One error per line, rendered the way the host console lists them.
 *
 * `gganbu[2], threshold: …` is a path into the file the host has open, which is
 * the whole job: a host reading this is looking at JSON, not at a game, and the
 * fastest thing an error can do is say which line to put the cursor on.
 */
export function formatErrors(errors: readonly ImportError[]): string[] {
  return errors.map((e) => {
    if (e.round === null) return e.message;
    const where = e.index === null ? e.round : `${e.round}[${e.index}]`;
    return e.field === null ? `${where}: ${e.message}` : `${where}, ${e.field}: ${e.message}`;
  });
}

/** What a reader reports with: the field, or null for the whole item. */
type Fail = (field: string | null, message: string) => void;

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

export function importArcadeJson(text: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errors: [{ round: null, index: null, field: null, message: `This is not valid JSON — ${detail}` }],
    };
  }

  // No bare list here, unlike a question file. A question file is one list and
  // a list of questions is an unambiguous thing to write; this file is four
  // lists, and a bare one would be a guess about which round the host meant.
  if (!isRecord(parsed)) {
    return {
      ok: false,
      errors: [
        {
          round: null,
          index: null,
          field: null,
          message: `The file must be an object with a round in it: ${ROUND_KEYS.join(", ")}.`,
        },
      ],
    };
  }

  const errors: ImportError[] = [];

  // Unknown top-level keys are collected rather than returned on their own, so
  // that a file with a misspelled round *and* a bad item reports both — a
  // misspelling is exactly the kind of error that comes with company.
  for (const key of Object.keys(parsed)) {
    if (!(FILE_KEYS as readonly string[]).includes(key)) {
      errors.push({
        round: null,
        index: null,
        field: key,
        message: `The file has a "${key}" key, which nothing reads. Expected ${FILE_KEYS.join(", ")}.`,
      });
    }
  }

  const staged = ROUND_KEYS.filter((round) => round in parsed);
  if (staged.length === 0) {
    // Not an empty success. The reducer refuses a `loadArcadeContent` that
    // stages nothing, and a host who uploaded a file meant to change something.
    errors.push({
      round: null,
      index: null,
      field: null,
      message: `The file stages no rounds. Give it one of ${ROUND_KEYS.join(", ")}.`,
    });
    return { ok: false, errors };
  }

  const recruitment = readRound("recruitment", parsed, errors, readEmojiItem, checkEmojiItems);
  const unseal = readRound("unseal", parsed, errors, readUnsealItem, checkUnsealItems);
  const glassBridge = readRound("glassBridge", parsed, errors, readGlassStep, checkGlassSteps);
  const gganbu = readRound("gganbu", parsed, errors, readOverUnderItem, checkOverUnderItems);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    // Only the keys the file carried. `ArcadeContent` is partial on purpose and
    // the event merges key by key, so an absent round means "leave the staged
    // one, or the compiled one, alone" — writing `undefined` in here would be a
    // key the merge then copies over a round that was staged an upload ago.
    content: {
      ...(recruitment ? { recruitment } : {}),
      ...(unseal ? { unseal } : {}),
      ...(glassBridge ? { glassBridge } : {}),
      ...(gganbu ? { gganbu } : {}),
    },
  };
}

/**
 * One round's list: the array, then each item, then the properties that are
 * about the set rather than about an item.
 *
 * The cross-item checks run only when every item parsed cleanly. Their input is
 * the set — duplicate answers, thin tiers, a label used twice — so running them
 * over a set with holes in it reports collisions between the items that
 * survived, which is a second error about the first one.
 */
function readRound<T>(
  round: ArcadeRound,
  file: Record<string, unknown>,
  errors: ImportError[],
  readItem: (round: ArcadeRound, at: number, raw: unknown, errors: ImportError[]) => T | null,
  check: (round: ArcadeRound, items: readonly T[], errors: ImportError[]) => void,
): readonly T[] | null {
  if (!(round in file)) return null;
  const raw = file[round];

  if (raw === null) {
    // `"unseal": null` is ambiguous and the event cannot honour either reading:
    // absent keys are left alone, so there is no way to *unstage* a round. A
    // host who means "not this time" leaves the key out.
    errors.push({
      round,
      index: null,
      field: null,
      message: "This is null. Leave the key out of the file for a round you are not staging.",
    });
    return null;
  }
  if (!Array.isArray(raw)) {
    errors.push({ round, index: null, field: null, message: "This must be a list." });
    return null;
  }
  if (raw.length === 0) {
    // The reducer refuses an empty round at `startRound` — "that round has no
    // items" — so an empty list here is a round staged into a rejection the
    // host will not see until they press start.
    errors.push({ round, index: null, field: null, message: "This stages no items." });
    return null;
  }

  const items: T[] = [];
  let clean = true;
  for (const [i, entry] of raw.entries()) {
    const before = errors.length;
    const item = readItem(round, i, entry, errors);
    if (item !== null && errors.length === before) items.push(item);
    else clean = false;
  }
  if (!clean) return null;

  const before = errors.length;
  check(round, items, errors);
  return errors.length === before ? items : null;
}

/* ------------------------------------------------------------------ */
/* Round 0 — Recruitment                                               */
/* ------------------------------------------------------------------ */

/**
 * Two emoji, one product, typed.
 *
 * Matching is `matchesItem` in engine/arcade.ts and nothing here may contradict
 * it: an answer is folded to lowercase letters and compared against the folded
 * answer **and** every folded alias. Three rules fall straight out of that
 * function, and none of them is inventable from the type:
 *
 * - An answer that folds to nothing can never be matched, so the item can never
 *   be got right. Digits fold away, so `"1.0"` is such an answer.
 * - An alias that folds to the answer's own form is dead weight: `matchesItem`
 *   already compares the answer itself. Refused rather than dropped, because a
 *   host who wrote it believes they added something.
 * - A folded form shared by two items makes one typed word correct for both,
 *   and `submitAnswer` judges against the item that is open. Whichever item
 *   that is, the other one's answer is now a word the room has already typed.
 *
 * Not checked: that a cue is two pictures. `recruitment.test.ts` argues the
 * count for the launch board — a third picture is a third clue — but a cue with
 * three emoji is an easier item, not a broken one, and the importer exists so a
 * host can write content without asking us. A letter in a cue is different: the
 * answer is *typed*, so "tf" in a Terraform cue is the item handed over, and
 * that is refused.
 */
function readEmojiItem(
  round: ArcadeRound,
  at: number,
  raw: unknown,
  errors: ImportError[],
): EmojiItem | null {
  const fail = failer(round, at, errors);
  if (!checkObject(raw, EMOJI_ITEM_KEYS, "an item", fail)) return null;

  const cue = readRequiredText(raw["cue"], "cue", fail);
  if (cue !== null && /\p{L}/u.test(cue)) {
    fail("cue", `"${cue}" has a letter in it. The answer is typed, so a letter in the cue is the answer given away.`);
  }

  const answer = readRequiredText(raw["answer"], "answer", fail);
  if (answer !== null && foldAnswer(answer) === "") {
    fail("answer", `"${answer}" folds away to nothing — matching keeps letters only, so nothing a player types could match it.`);
  }

  const note = readRequiredText(raw["note"], "note", fail);
  const accept = readAccept(raw["accept"], answer, fail);

  if (cue === null || answer === null || note === null) return null;
  return { cue, answer, accept, note };
}

/**
 * The aliases. Optional, and `[]` when absent.
 *
 * Optional where a question's `timeLimitSec` is mandatory, and the difference
 * is what an omission can cost. An absent timer has a *default*, so leaving it
 * out means accepting a number the author may not know; an absent alias list
 * has nothing behind it but the empty list, which is the only thing an author
 * who left it out can mean. Six of the seven launch items carry `accept: []`,
 * and a format that makes every item say "no aliases" out loud is a format
 * whose items are mostly ceremony.
 */
function readAccept(raw: unknown, answer: string | null, fail: Fail): readonly string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    fail("accept", "Not a list. Leave it out for an item with no aliases.");
    return [];
  }
  const answerFold = answer === null ? null : foldAnswer(answer);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [i, value] of raw.entries()) {
    if (typeof value !== "string") {
      fail("accept", `Alias ${i + 1} is not a string.`);
      continue;
    }
    const trimmed = value.trim();
    if (trimmed === "") {
      fail("accept", `Alias ${i + 1} is blank. Leave it out instead.`);
      continue;
    }
    const folded = foldAnswer(trimmed);
    if (folded === "") {
      fail("accept", `"${trimmed}" folds away to nothing, so nothing a player types could match it.`);
      continue;
    }
    if (folded === answerFold) {
      fail("accept", `"${trimmed}" is the answer again. Matching folds the answer itself, so the list does not need it.`);
      continue;
    }
    if (seen.has(folded)) {
      fail("accept", `"${trimmed}" is accepted twice.`);
      continue;
    }
    seen.add(folded);
    out.push(trimmed);
  }
  return out;
}

/** No typed word may reach two items. See `readEmojiItem`. */
function checkEmojiItems(
  round: ArcadeRound,
  items: readonly EmojiItem[],
  errors: ImportError[],
): void {
  const owner = new Map<string, { readonly at: number; readonly typed: string }>();
  items.forEach((item, at) => {
    for (const typed of [item.answer, ...item.accept]) {
      const folded = foldAnswer(typed);
      const first = owner.get(folded);
      if (first === undefined) {
        owner.set(folded, { at, typed });
        continue;
      }
      errors.push({
        round,
        index: at,
        field: typed === item.answer ? "answer" : "accept",
        message: `"${typed}" also matches ${round}[${first.at}], which is "${first.typed}". A typed answer has to reach one item.`,
      });
    }
  });
}

/* ------------------------------------------------------------------ */
/* Round 2 — Unseal                                                    */
/* ------------------------------------------------------------------ */

/**
 * One tin: the shape, the scramble, the word, the note.
 *
 * Two of these rules are the engine's own. `startRound` already refuses a tin
 * whose cue is not a permutation of its answer — `invalid_round_config`, "tin 4's
 * scramble is not the letters of its word" — because the tiles a player taps
 * *are* the cue, so such a tin cannot be opened at all. Refusing it here moves
 * that discovery from the moment the host presses start to the moment they
 * upload, which is the only difference and the whole point.
 *
 * The tier band is the round's conceit rather than the engine's rule: a shape
 * is picked before the word is known, so what the shape promises is a length
 * and a price. See {@link UNSEAL_TIERS}.
 *
 * Not checked: that a cue is not its own word **backwards**. `T F A R` is RAFT
 * and it ships, deliberately — `unseal.ts` argues that a four-letter word has
 * twenty-four arrangements, one of them was always going to look like
 * something, and a player still has to notice. A host re-staging the launch
 * board must not be refused for content this repository committed on purpose.
 * A cue that spells its word out *forwards* is refused: there is nothing to
 * notice there.
 */
function readUnsealItem(
  round: ArcadeRound,
  at: number,
  raw: unknown,
  errors: ImportError[],
): UnsealItem | null {
  const fail = failer(round, at, errors);
  if (!checkObject(raw, UNSEAL_ITEM_KEYS, "a tin", fail)) return null;

  const rawShape = raw["shape"];
  let shape: UnsealShape | null = null;
  if (typeof rawShape !== "string") {
    fail("shape", "Missing, or not a string.");
  } else if (!(UNSEAL_SHAPES as readonly string[]).includes(rawShape)) {
    fail("shape", `"${rawShape}" is not a tin. Use ${UNSEAL_SHAPES.join(", ")}.`);
  } else {
    shape = rawShape as UnsealShape;
  }

  const cue = readRequiredText(raw["cue"], "cue", fail);
  const answer = readRequiredText(raw["answer"], "answer", fail);
  const note = readRequiredText(raw["note"], "note", fail);

  const letters = answer === null ? [] : unsealLetters(answer);
  if (answer !== null && letters.length === 0) {
    fail("answer", `"${answer}" has no letters in it, so there is nothing to unscramble.`);
  }

  if (cue !== null && answer !== null && letters.length > 0) {
    if (!isScrambleOf(cue, answer)) {
      fail("cue", `"${cue}" is not the letters of ${answer}. The tiles are the cue, so this tin cannot be opened.`);
    } else if (unsealLetters(cue).join("") === letters.join("")) {
      fail("cue", `"${cue}" spells ${answer} out in order.`);
    }
    if (shape !== null && !UNSEAL_TIERS[shape].holds(letters.length)) {
      fail(
        "shape",
        `${answer} is ${letters.length} letters; a ${shape} holds ${UNSEAL_TIERS[shape].says}.`,
      );
    }
  }

  if (shape === null || cue === null || answer === null || note === null) return null;
  return { shape, cue, answer, note };
}

/**
 * Properties of the set of tins rather than of a tin.
 *
 * A tier is dealt out by arcade player number — `tinIndexFor` — so two people
 * sitting together get different words. Both rules here are about that deal
 * still meaning something: a word in two tins defeats it directly, and a tier
 * of one or two words defeats it on the call, out loud, for free.
 */
function checkUnsealItems(
  round: ArcadeRound,
  items: readonly UnsealItem[],
  errors: ImportError[],
): void {
  const owner = new Map<string, number>();
  items.forEach((item, at) => {
    const key = unsealLetters(item.answer).join("");
    const first = owner.get(key);
    if (first === undefined) {
      owner.set(key, at);
      return;
    }
    errors.push({
      round,
      index: at,
      field: "answer",
      message: `${item.answer} is already in ${round}[${first}]. Two tins holding one word is two people unscrambling it.`,
    });
  });

  const perShape = new Map<UnsealShape, number>();
  for (const item of items) {
    perShape.set(item.shape, (perShape.get(item.shape) ?? 0) + 1);
  }
  for (const shape of UNSEAL_SHAPES) {
    const n = perShape.get(shape) ?? 0;
    // Zero is a tier the host did not stage, which the picker greys out. One or
    // two is a tier it offers and one shout solves.
    if (n === 0 || n >= MIN_TINS_PER_SHAPE) continue;
    errors.push({
      round,
      index: null,
      field: "shape",
      message: `The ${shape} tier has ${n === 1 ? "one tin" : `${n} tins`}; a tier needs ${MIN_TINS_PER_SHAPE}, or one person saying the word out loud solves it for everybody who picked that shape.`,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Round 5 — The Glass Bridge                                          */
/* ------------------------------------------------------------------ */

/**
 * One step: a product, two panes, and which pane is the real feature.
 *
 * `startRound` already refuses a step without two labelled panes and a `real`
 * of 0 or 1 — a step saying `real: 2` would drain the whole wave for answering
 * correctly — and this refuses the same things at upload.
 *
 * **Both panes are the same product**, which `glass-bridge.ts` argues at
 * length: pairing across products makes the step a question about which product
 * you have heard of, so *Vault Transit Secrets Engine* beside *Packer
 * Provisioner Mesh* is the answer given away. The mechanically checkable form
 * of that is the one the compiled board already satisfies and
 * `glass-bridge.test.ts` already asserts — a pane's label begins with the
 * step's product and a space. It is a real constraint on a host's wording, and
 * it is the only version of "the same product" that is a fact about the file
 * rather than about HashiCorp.
 *
 * Not checked, and not checkable here: that the real pane is real. That is the
 * round's one true failure and the ⚠️ VERIFY discipline is the only defence
 * against it — a validator that could tell a documented feature from a
 * plausible invention would not need the round. Also not checked: that the two
 * notes are the right way round, that the board's *tell* stays broken (four
 * pairs inverted, two not — `glass-bridge.test.ts` holds that against the
 * compiled board, where it is a property of six specific pairs and not of the
 * format), and that no two steps share a product. Two Vault steps is a content
 * decision; two identical labels is not, and that is refused below.
 */
function readGlassStep(
  round: ArcadeRound,
  at: number,
  raw: unknown,
  errors: ImportError[],
): GlassStep | null {
  const fail = failer(round, at, errors);
  if (!checkObject(raw, GLASS_STEP_KEYS, "a step", fail)) return null;

  const product = readRequiredText(raw["product"], "product", fail);
  const panes = readPanes(raw["panes"], product, fail);

  const rawReal = raw["real"];
  let real: 0 | 1 | null = null;
  if (rawReal === 0 || rawReal === 1) {
    real = rawReal;
  } else if (rawReal === undefined) {
    fail("real", "Missing. Give the index of the pane that is the real feature, 0 or 1.");
  } else {
    fail("real", `${JSON.stringify(rawReal)} is not 0 or 1. It is the index of the pane that is the real feature.`);
  }

  if (product === null || panes === null || real === null) return null;
  return { product, panes, real };
}

/** The two panes, in display order. */
function readPanes(
  raw: unknown,
  product: string | null,
  fail: Fail,
): readonly [GlassPane, GlassPane] | null {
  if (!Array.isArray(raw)) {
    fail("panes", "Missing, or not a list.");
    return null;
  }
  if (raw.length !== GLASS_PANES_PER_STEP) {
    // A step is a choice between two panes, and that is the type as well as the
    // round: one pane is a step nobody can fall at, three is a board the waves
    // cannot be timed against.
    fail("panes", `${raw.length} panes; a step has ${GLASS_PANES_PER_STEP}.`);
    return null;
  }

  const panes: GlassPane[] = [];
  for (const [i, entry] of raw.entries()) {
    const at = `panes[${i}]`;
    const paneFail: Fail = (field, message) => fail(field === null ? at : `${at}.${field}`, message);
    if (!checkObject(entry, GLASS_PANE_KEYS, "a pane", paneFail)) continue;
    const label = readRequiredText(entry["label"], "label", paneFail);
    // The fake's note is the joke and the real one's is the thing somebody
    // learns, so the big screen reads both out at the reveal. A pane with no
    // note is half a reveal.
    const note = readRequiredText(entry["note"], "note", paneFail);
    if (label !== null && product !== null && !label.startsWith(`${product} `)) {
      paneFail(
        "label",
        `"${label}" is not a ${product} pane. Both panes are the same product, or the step is won by recognising the product line instead of the feature.`,
      );
      continue;
    }
    if (label === null || note === null) continue;
    panes.push({ label, note });
  }
  if (panes.length !== GLASS_PANES_PER_STEP) return null;

  const [first, second] = panes as [GlassPane, GlassPane];
  if (labelKey(first.label) === labelKey(second.label)) {
    // Two panes reading the same is a step where the reveal contradicts half
    // the wave whichever pane is marked real.
    fail("panes", `Both panes read "${first.label}".`);
    return null;
  }
  return [first, second];
}

/**
 * No label twice on the whole bridge.
 *
 * A label that is the real pane at one step and the fake at another is content
 * that contradicts itself, and the room hears both notes read out.
 */
function checkGlassSteps(
  round: ArcadeRound,
  steps: readonly GlassStep[],
  errors: ImportError[],
): void {
  const owner = new Map<string, number>();
  steps.forEach((step, at) => {
    step.panes.forEach((pane, i) => {
      const key = labelKey(pane.label);
      const first = owner.get(key);
      if (first === undefined) {
        owner.set(key, at);
        return;
      }
      errors.push({
        round,
        index: at,
        field: `panes[${i}].label`,
        message: `"${pane.label}" is already a pane in ${round}[${first}].`,
      });
    });
  });
}

function labelKey(label: string): string {
  return label.trim().toLocaleLowerCase();
}

/* ------------------------------------------------------------------ */
/* Round 4 — Gganbu                                                    */
/* ------------------------------------------------------------------ */

/**
 * One Over/Under prompt.
 *
 * `verify` is **mandatory**, where a question file's `tiebreak` is optional and
 * false by omission. This is the field the whole importer was built for: three
 * of the six compiled prompts carry the flag because their answers are
 * configuration defaults a release can move without announcing it, and the flag
 * is how whoever runs the next event knows which three to check again. A
 * defaulted `false` on a prompt whose answer has moved is the exact failure the
 * flag exists to prevent, so a prompt has to say, out loud, either way.
 *
 * The threshold is text — it is displayed, not computed — but it has to read as
 * a number, because "over or under 720" is a line and a thing that is not a
 * number has no sides. `gganbu.test.ts` asserts the same of the compiled bank.
 *
 * **Not checked: that a threshold sits a plausible distance from its answer.**
 * That is the argument `gganbu.ts` spends half its header on, and it is the one
 * rule here that matters most and cannot be mechanised. The importer holds the
 * prompt, the threshold and the claimed side; the *true figure* is in the world.
 * `threshold: "768"` with `answer: "over"` on Vault's max lease TTL is a prompt
 * that is both wrong and a certainty, and nothing in this file can tell. Two
 * things follow from that and neither is code: the flag is carried in the data
 * so the console can show it, and `gganbu.test.ts` pins the compiled bank's six
 * answers against figures a person verified against a published source on a
 * dated pass. A staged bank gets neither, which is why the flag travels with it.
 *
 * Also not checked: whether the cue is a fact the room can recite. A prompt
 * both halves of a pair know cold produces two minimum wagers and a tie, which
 * `gganbu.ts` calls the defect that replaced the port-era bank — and "is this
 * common knowledge" is a judgement about a room, not a property of a string.
 */
function readOverUnderItem(
  round: ArcadeRound,
  at: number,
  raw: unknown,
  errors: ImportError[],
): OverUnderItem | null {
  const fail = failer(round, at, errors);
  if (!checkObject(raw, OVER_UNDER_KEYS, "a prompt", fail)) return null;

  const cue = readRequiredText(raw["cue"], "cue", fail);
  const note = readRequiredText(raw["note"], "note", fail);

  const threshold = readRequiredText(raw["threshold"], "threshold", fail);
  if (threshold !== null && !Number.isFinite(Number(threshold))) {
    fail("threshold", `"${threshold}" is not a number. Over or under needs a line to be on one side of.`);
  }

  const rawAnswer = raw["answer"];
  let answer: OverUnder | null = null;
  if (rawAnswer === "over" || rawAnswer === "under") {
    answer = rawAnswer;
  } else if (rawAnswer === undefined) {
    fail("answer", `Missing. Give the side the real figure is on: ${OVER_UNDER.join(" or ")}.`);
  } else {
    fail("answer", `${JSON.stringify(rawAnswer)} is not ${OVER_UNDER.join(" or ")}.`);
  }

  const rawVerify = raw["verify"];
  let verify: boolean | null = null;
  if (typeof rawVerify === "boolean") {
    verify = rawVerify;
  } else if (rawVerify === undefined) {
    fail("verify", "Missing. Say whether this answer was checked before the session: an answer that can move and does not say so is what the flag is for.");
  } else {
    fail("verify", `${JSON.stringify(rawVerify)} is not true or false.`);
  }

  if (cue === null || note === null || threshold === null || answer === null || verify === null) {
    return null;
  }
  return { cue, threshold, answer, note, verify };
}

/**
 * The bank cannot be all one way.
 *
 * The prompts settle one at a time and each reveal reads its note out, so a
 * bank whose every answer is `over` hands the rest of the round away with the
 * first settlement — and this round is the one where the giveaway is worth
 * something, because a player who is certain stakes five tokens. `gganbu.ts`
 * makes the same argument about alternation: "a player who works out that the
 * round alternates has stopped reading the prompts." Alternation itself is not
 * refused, because a run of answers is a shape a host may not have chosen and
 * three of six either way is arithmetic the format has no business demanding.
 * One side for every prompt is not a shape; it is the answer, printed once.
 *
 * A single prompt has no second prompt to give away, so the rule starts at two.
 */
function checkOverUnderItems(
  round: ArcadeRound,
  prompts: readonly OverUnderItem[],
  errors: ImportError[],
): void {
  if (prompts.length < 2) return;
  const first = prompts[0]!.answer;
  if (prompts.some((p) => p.answer !== first)) return;
  errors.push({
    round,
    index: null,
    field: "answer",
    message: `Every prompt answers "${first}". The first reveal would give away the rest of the round.`,
  });
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function failer(round: ArcadeRound, at: number, errors: ImportError[]): Fail {
  return (field, message) => {
    errors.push({ round, index: at, field, message });
  };
}

/**
 * It is an object, and every key in it is one we read.
 *
 * The unknown-key sweep is here rather than in each reader because it is the
 * rule the whole format turns on and four copies of it is four chances to
 * leave one out.
 */
function checkObject(
  raw: unknown,
  keys: readonly string[],
  what: string,
  fail: Fail,
): raw is Record<string, unknown> {
  if (!isRecord(raw)) {
    fail(null, `This is not ${what}.`);
    return false;
  }
  for (const key of Object.keys(raw)) {
    if (!keys.includes(key)) {
      fail(key, `Nothing reads a "${key}" key. Check the spelling.`);
    }
  }
  return true;
}

/**
 * A string that has to be there and has to say something.
 *
 * Every text field in every arcade item is like this. There are no optional
 * strings: a cue, a label, a threshold and a note are each read out or shown to
 * somebody, and a blank one is a screen with a gap in it at the moment the
 * House is meant to be saying the thing people learn from.
 */
function readRequiredText(raw: unknown, field: string, fail: Fail): string | null {
  if (typeof raw !== "string") {
    fail(field, "Missing, or not a string.");
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    fail(field, "This is blank.");
    return null;
  }
  return trimmed;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
