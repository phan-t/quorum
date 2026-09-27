/**
 * The arcade content importer.
 *
 * The bias is `trivia/import.test.ts`'s: a file that is wrong must fail *here*,
 * with a message naming the round, the item and the key, rather than load and
 * be discovered at 14:40 in front of the room. So most of these tests are about
 * rejection, and several are about rejecting things a laxer parser would take.
 *
 * Every rejection test asserts the **addressed** message rather than only the
 * fact of the rejection, because an error a host cannot act on is a file they
 * have to guess about — and four rounds in one file means "item 3" is four
 * different items.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GGANBU_PROMPTS } from "./gganbu.ts";
import { GLASS_BRIDGE_STEPS } from "./glass-bridge.ts";
import { RECRUITMENT_ITEMS } from "./recruitment.ts";
import { UNSEAL_ITEMS } from "./unseal.ts";
import { formatErrors, importArcadeJson } from "./import.ts";

function ok(text: string) {
  const result = importArcadeJson(text);
  assert.ok(
    result.ok,
    `expected a load, got: ${result.ok ? "" : formatErrors(result.errors).join(" / ")}`,
  );
  return result.content;
}

function errs(text: string): string[] {
  const result = importArcadeJson(text);
  assert.ok(!result.ok, "expected a rejection");
  return formatErrors(result.errors);
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const EMOJI = {
  cue: "🔐🏦",
  answer: "Vault",
  accept: [],
  note: "Encryption as a service, PKI, and credentials that arrive with an expiry.",
};

/** Three circles, because a tier of fewer than three is refused. */
const TINS = [
  { shape: "circle", cue: "T F A R", answer: "RAFT", note: "The consensus protocol." },
  { shape: "circle", cue: "R F S E", answer: "SERF", note: "The membership library." },
  { shape: "circle", cue: "F T D I R", answer: "DRIFT", note: "What the infrastructure did." },
];

const STEP = {
  product: "Packer",
  panes: [
    { label: "Packer Provisioner Mesh", note: "Packer has provisioners. It does not have a mesh." },
    { label: "Packer Builders", note: "A builder produces the image for one platform." },
  ],
  real: 1,
};

const PROMPT = {
  cue: "Terraform's default parallelism",
  threshold: "15",
  answer: "under",
  note: "10. Concurrent resource operations while Terraform walks the graph.",
  verify: false,
};

/** One Recruitment item, patched. */
function emoji(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({ recruitment: [{ ...EMOJI, ...patch }] });
}

/** Three tins, the first patched. */
function tin(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({ unseal: [{ ...TINS[0], ...patch }, TINS[1], TINS[2]] });
}

/** One Glass Bridge step, patched. */
function step(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({ glassBridge: [{ ...STEP, ...patch }] });
}

/** One Gganbu prompt, patched. */
function prompt(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({ gganbu: [{ ...PROMPT, ...patch }] });
}

/* ------------------------------------------------------------------ */
/* What loads                                                          */
/* ------------------------------------------------------------------ */

describe("what loads", () => {
  it("stages all four rounds from one file, keyed the way ArcadeContent is", () => {
    const content = ok(
      JSON.stringify({
        title: "Sydney, October",
        recruitment: [EMOJI],
        unseal: TINS,
        glassBridge: [STEP],
        gganbu: [PROMPT],
      }),
    );
    assert.deepEqual(Object.keys(content).sort(), ["gganbu", "glassBridge", "recruitment", "unseal"]);
    assert.deepEqual(content.recruitment, [EMOJI]);
    assert.deepEqual(content.unseal, TINS);
    assert.deepEqual(content.glassBridge, [STEP]);
    assert.deepEqual(content.gganbu, [PROMPT]);
  });

  it("stages one round on its own and leaves the other three keys absent", () => {
    // Absent rather than empty: the event merges key by key, so a file carrying
    // only Gganbu must not clear a staged Unseal, and an `undefined` written
    // here is a key that merge would copy over one.
    const content = ok(prompt());
    assert.deepEqual(Object.keys(content), ["gganbu"]);
    assert.ok(!("unseal" in content));
  });

  it("accepts the compiled launch content of every round, unchanged", () => {
    // The importer's real acceptance test: what the build ships must be a legal
    // file. If this fails, either a rule here is stricter than the content the
    // repository committed on purpose, or the content has drifted.
    const content = ok(
      JSON.stringify({
        recruitment: RECRUITMENT_ITEMS,
        unseal: UNSEAL_ITEMS,
        glassBridge: GLASS_BRIDGE_STEPS,
        gganbu: GGANBU_PROMPTS,
      }),
    );
    assert.deepEqual(content.recruitment, RECRUITMENT_ITEMS);
    assert.deepEqual(content.unseal, UNSEAL_ITEMS);
    assert.deepEqual(content.glassBridge, GLASS_BRIDGE_STEPS);
    assert.deepEqual(content.gganbu, GGANBU_PROMPTS);
  });

  it("re-imports what it exported, so a staged file is a file a host can edit", () => {
    const once = ok(JSON.stringify({ unseal: UNSEAL_ITEMS, gganbu: GGANBU_PROMPTS }));
    assert.deepEqual(ok(JSON.stringify(once)), once);
  });

  it("treats an absent accept list as no aliases rather than refusing the item", () => {
    const content = ok(JSON.stringify({ recruitment: [{ ...EMOJI, accept: undefined }] }));
    assert.deepEqual(content.recruitment?.[0]?.accept, []);
    assert.deepEqual(ok(emoji({ accept: null })).recruitment?.[0]?.accept, []);
  });

  it("keeps an alias that is not the answer, which is what the list is for", () => {
    const content = ok(emoji({ answer: "Terraform", accept: [" tf "] }));
    assert.deepEqual(content.recruitment?.[0]?.accept, ["tf"]);
  });

  it("trims every string it keeps", () => {
    const content = ok(
      JSON.stringify({
        gganbu: [{ ...PROMPT, cue: "  Padded  ", threshold: " 15 ", note: "  A note.  " }],
      }),
    );
    assert.deepEqual(content.gganbu?.[0], {
      cue: "Padded",
      threshold: "15",
      answer: "under",
      note: "A note.",
      verify: false,
    });
  });

  it("carries a VERIFY flag both ways, because the flag is the point of staging", () => {
    assert.equal(ok(prompt({ verify: true })).gganbu?.[0]?.verify, true);
    assert.equal(ok(prompt({ verify: false })).gganbu?.[0]?.verify, false);
  });

  it("allows a tier the file leaves out entirely, which the picker greys", () => {
    // Three circles and nothing else. `unsealView` marks a shape with no tins
    // unavailable, so a host running one tier has made a choice.
    assert.equal(ok(tin()).unseal?.length, 3);
  });

  it("allows two steps on one product, and a threshold that is not a whole number", () => {
    const content = ok(
      JSON.stringify({
        glassBridge: [STEP, { ...STEP, panes: [
          { label: "Packer HCP Packer Registry", note: "Image metadata, channels and revocation." },
          { label: "Packer Artifact Ledger", note: "Packer has a registry. It has never had a ledger." },
        ], real: 0 }],
        gganbu: [{ ...PROMPT, threshold: "1.5" }],
      }),
    );
    assert.equal(content.glassBridge?.length, 2);
    assert.equal(content.gganbu?.[0]?.threshold, "1.5");
  });
});

/* ------------------------------------------------------------------ */
/* The file                                                            */
/* ------------------------------------------------------------------ */

describe("the file as a whole", () => {
  it("names the JSON error rather than saying the file is bad", () => {
    assert.match(errs("{ nope")[0] ?? "", /not valid JSON/);
  });

  it("refuses a bare list, because four rounds in one file make it a guess", () => {
    assert.match(errs(JSON.stringify([EMOJI]))[0] ?? "", /must be an object with a round in it/);
    assert.match(errs('"just a string"')[0] ?? "", /must be an object with a round in it/);
  });

  it("refuses a file that stages no rounds at all, rather than loading nothing", () => {
    assert.match(errs("{}")[0] ?? "", /stages no rounds/);
    assert.match(errs('{"title":"Sydney"}')[0] ?? "", /stages no rounds/);
  });

  it("refuses a misspelled round rather than silently staging none of it", () => {
    // The single most important property, at the top level: a file with
    // "glassbridge" in it is a file whose author believes they staged a bridge.
    const lines = errs(JSON.stringify({ glassbridge: [STEP] }));
    assert.match(lines[0] ?? "", /"glassbridge" key, which nothing reads/);
    assert.match(lines[0] ?? "", /Expected title, recruitment, unseal, glassBridge, gganbu/);
  });

  it("refuses a round that is null, because no event can unstage a round", () => {
    assert.match(errs(JSON.stringify({ unseal: null }))[0] ?? "", /^unseal: This is null\./);
    assert.match(errs(JSON.stringify({ unseal: null }))[0] ?? "", /Leave the key out/);
  });

  it("refuses a round that is not a list, and one that is an empty list", () => {
    assert.match(errs(JSON.stringify({ gganbu: PROMPT }))[0] ?? "", /^gganbu: This must be a list\./);
    assert.match(errs(JSON.stringify({ gganbu: [] }))[0] ?? "", /^gganbu: This stages no items\./);
  });

  it("refuses an item that is not an object", () => {
    assert.match(errs(JSON.stringify({ gganbu: ["over"] }))[0] ?? "", /^gganbu\[0\]: This is not a prompt\./);
    assert.match(errs(JSON.stringify({ unseal: [null] }))[0] ?? "", /^unseal\[0\]: This is not a tin\./);
  });

  it("addresses an error by its round and its 0-based index in that round", () => {
    const lines = errs(
      JSON.stringify({ gganbu: [PROMPT, { ...PROMPT, answer: "over", threshold: "yes" }] }),
    );
    assert.match(lines[0] ?? "", /^gganbu\[1\], threshold: "yes" is not a number\./);
  });

  it("reports every problem at once, across every round", () => {
    const lines = errs(
      JSON.stringify({
        recruitment: [{ ...EMOJI, cue: "" }],
        unseal: [{ ...TINS[0], shape: "square" }, TINS[1], TINS[2]],
        glassBridge: [{ ...STEP, real: 2 }],
        gganbu: [{ ...PROMPT, verify: "yes" }],
      }),
    );
    assert.deepEqual(lines, [
      "recruitment[0], cue: This is blank.",
      'unseal[0], shape: "square" is not a tin. Use circle, triangle, star, umbrella.',
      "glassBridge[0], real: 2 is not 0 or 1. It is the index of the pane that is the real feature.",
      'gganbu[0], verify: "yes" is not true or false.',
    ]);
  });

  it("stages nothing at all when one item of one round is wrong", () => {
    // All or nothing, and across rounds: a good Recruitment set does not load
    // beside a broken Gganbu bank, because half a staged file is a file nobody
    // has read end to end.
    const result = importArcadeJson(
      JSON.stringify({ recruitment: [EMOJI], gganbu: [{ ...PROMPT, verify: undefined }] }),
    );
    assert.ok(!result.ok);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]?.round, "gganbu");
  });
});

/* ------------------------------------------------------------------ */
/* Recruitment                                                         */
/* ------------------------------------------------------------------ */

describe("recruitment", () => {
  it("refuses a misspelled item key rather than defaulting it", () => {
    assert.match(errs(emoji({ accepts: ["tf"] }))[0] ?? "", /Nothing reads a "accepts" key/);
  });

  it("refuses a blank or missing cue, answer or note", () => {
    assert.match(errs(emoji({ cue: "   " }))[0] ?? "", /^recruitment\[0\], cue: This is blank\./);
    assert.match(errs(emoji({ answer: undefined }))[0] ?? "", /^recruitment\[0\], answer: Missing, or not a string\./);
    assert.match(errs(emoji({ note: 12 }))[0] ?? "", /^recruitment\[0\], note: Missing, or not a string\./);
  });

  it("refuses a letter in a cue, because the answer is typed", () => {
    assert.match(errs(emoji({ cue: "🔐 vault" }))[0] ?? "", /has a letter in it.*answer given away/);
  });

  it("refuses an answer that folds away to nothing, which nothing could match", () => {
    // `foldAnswer` keeps letters only, so "1.0" can never be typed correctly.
    assert.match(errs(emoji({ answer: "1.0" }))[0] ?? "", /folds away to nothing/);
  });

  it("refuses an accept list that is not a list, and a blank alias in one", () => {
    assert.match(errs(emoji({ accept: "tf" }))[0] ?? "", /accept: Not a list/);
    assert.match(errs(emoji({ accept: ["tf", " "] }))[0] ?? "", /Alias 2 is blank/);
    assert.match(errs(emoji({ accept: [7] }))[0] ?? "", /Alias 1 is not a string/);
    assert.match(errs(emoji({ accept: ["1.0"] }))[0] ?? "", /folds away to nothing/);
  });

  it("refuses an alias that is the answer again, which matching already covers", () => {
    // `matchesItem` folds the answer itself, so this is dead weight — and a
    // host who wrote it believes they added something.
    assert.match(errs(emoji({ accept: ["vault"] }))[0] ?? "", /is the answer again/);
    assert.match(errs(emoji({ accept: [" Vault! "] }))[0] ?? "", /is the answer again/);
  });

  it("refuses the same alias twice", () => {
    assert.match(errs(emoji({ answer: "Terraform", accept: ["tf", "TF"] }))[0] ?? "", /is accepted twice/);
  });

  it("refuses two items one typed word would answer, naming the item it collides with", () => {
    const lines = errs(JSON.stringify({ recruitment: [EMOJI, { ...EMOJI, cue: "🏦🔐" }] }));
    assert.match(lines[0] ?? "", /^recruitment\[1\], answer: "Vault" also matches recruitment\[0\], which is "Vault"\./);
  });

  it("refuses an alias that reaches another item's answer", () => {
    const lines = errs(
      JSON.stringify({
        recruitment: [EMOJI, { ...EMOJI, cue: "🌍🛠️", answer: "Terraform", accept: ["VAULT"] }],
      }),
    );
    assert.match(lines[0] ?? "", /^recruitment\[1\], accept: "VAULT" also matches recruitment\[0\]/);
  });
});

/* ------------------------------------------------------------------ */
/* Unseal                                                             */
/* ------------------------------------------------------------------ */

describe("unseal", () => {
  it("refuses a shape that is not one of the four tins", () => {
    assert.match(errs(tin({ shape: "square" }))[0] ?? "", /"square" is not a tin\. Use circle, triangle, star, umbrella\./);
    assert.match(errs(tin({ shape: undefined }))[0] ?? "", /^unseal\[0\], shape: Missing, or not a string\./);
  });

  it("refuses a cue that is not the letters of its own word", () => {
    // The engine refuses this at `startRound` too: the tiles a player taps are
    // the cue, so such a tin cannot be opened at all. This is the same refusal
    // moved to the upload, where the host is still looking at the file.
    assert.match(errs(tin({ cue: "X Y Z Q" }))[0] ?? "", /is not the letters of RAFT.*cannot be opened/);
  });

  it("refuses a cue that spells its word out in order", () => {
    assert.match(errs(tin({ cue: "R A F T" }))[0] ?? "", /spells RAFT out in order/);
  });

  it("allows a cue that is its word backwards, which the launch board ships", () => {
    // `T F A R` is RAFT reversed and it is committed on purpose: a four-letter
    // word has twenty-four arrangements, one was always going to look like
    // something, and a player still has to notice. A host re-staging the board
    // must not be refused for it.
    assert.equal(ok(tin()).unseal?.[0]?.cue, "T F A R");
  });

  it("refuses a word whose length is not the length its shape promises", () => {
    assert.match(
      errs(tin({ shape: "triangle" }))[0] ?? "",
      /^unseal\[0\], shape: RAFT is 4 letters; a triangle holds six letters\./,
    );
    assert.match(errs(tin({ shape: "umbrella" }))[0] ?? "", /a umbrella holds eleven letters or more/);
  });

  it("refuses an answer with no letters in it", () => {
    assert.match(errs(tin({ answer: "1234", cue: "1 2 3 4" }))[0] ?? "", /has no letters in it/);
  });

  it("refuses two tins holding the same word", () => {
    const lines = errs(JSON.stringify({ unseal: [TINS[0], TINS[1], TINS[2], TINS[0]] }));
    assert.match(lines[0] ?? "", /^unseal\[3\], answer: RAFT is already in unseal\[0\]\./);
  });

  it("refuses a tier the picker offers with fewer than three tins in it", () => {
    // One shout on the call solves a thin tier for everybody who picked that
    // shape, which is how the circle shipped holding only RAFT.
    const lines = errs(JSON.stringify({ unseal: [TINS[0], TINS[1]] }));
    assert.match(lines[0] ?? "", /^unseal, shape: The circle tier has 2 tins; a tier needs 3/);
    assert.match(
      errs(
        JSON.stringify({
          unseal: [...TINS, { shape: "triangle", cue: "D U E L M O", answer: "MODULE", note: "Reusable Terraform." }],
        }),
      )[0] ?? "",
      /^unseal, shape: The triangle tier has one tin;/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* The Glass Bridge                                                    */
/* ------------------------------------------------------------------ */

describe("the glass bridge", () => {
  it("refuses anything but two panes", () => {
    assert.match(errs(step({ panes: [STEP.panes[0]] }))[0] ?? "", /^glassBridge\[0\], panes: 1 panes; a step has 2\./);
    assert.match(errs(step({ panes: [...STEP.panes, STEP.panes[0]] }))[0] ?? "", /3 panes; a step has 2\./);
    assert.match(errs(step({ panes: undefined }))[0] ?? "", /^glassBridge\[0\], panes: Missing, or not a list\./);
  });

  it("refuses a real that is not 0 or 1, which would drain a wave for being right", () => {
    assert.match(errs(step({ real: 2 }))[0] ?? "", /2 is not 0 or 1/);
    assert.match(errs(step({ real: "1" }))[0] ?? "", /"1" is not 0 or 1/);
    assert.match(errs(step({ real: undefined }))[0] ?? "", /^glassBridge\[0\], real: Missing\./);
  });

  it("refuses a pane with no label or no note, addressed to the pane", () => {
    // The reveal reads both notes out — the fake's is the joke and the real
    // one's is the thing somebody learns — so a pane without one is half a
    // reveal.
    const lines = errs(step({ panes: [STEP.panes[0], { label: "Packer Builders" }] }));
    assert.match(lines[0] ?? "", /^glassBridge\[0\], panes\[1\]\.note: Missing, or not a string\./);
    assert.match(
      errs(step({ panes: [{ label: "  ", note: "A note." }, STEP.panes[1]] }))[0] ?? "",
      /^glassBridge\[0\], panes\[0\]\.label: This is blank\./,
    );
  });

  it("refuses a pane that is not the step's product", () => {
    // SPEC pairs within a product: *Vault Transit Secrets Engine* beside
    // *Packer Provisioner Mesh* is a question about which product you have
    // heard of, which is the step given away.
    assert.match(
      errs(step({ panes: [STEP.panes[0], { label: "Vault Cubbyhole", note: "Token-scoped storage." }] }))[0] ?? "",
      /^glassBridge\[0\], panes\[1\]\.label: "Vault Cubbyhole" is not a Packer pane\./,
    );
    // The product's own name with nothing after it is not a feature either.
    assert.match(errs(step({ panes: [{ label: "Packer", note: "A note." }, STEP.panes[1]] }))[0] ?? "", /is not a Packer pane/);
  });

  it("refuses two panes that read the same, whichever one is marked real", () => {
    assert.match(
      errs(step({ panes: [STEP.panes[1], { label: "Packer BUILDERS ", note: "Another note." }] }))[0] ?? "",
      /^glassBridge\[0\], panes: Both panes read "Packer Builders"\./,
    );
  });

  it("refuses a label used at two steps, which would be real once and fake once", () => {
    const lines = errs(JSON.stringify({ glassBridge: [STEP, { ...STEP, real: 0 }] }));
    assert.match(lines[0] ?? "", /^glassBridge\[1\], panes\[0\]\.label: "Packer Provisioner Mesh" is already a pane in glassBridge\[0\]\./);
  });

  it("refuses a misspelled step or pane key", () => {
    assert.match(errs(step({ products: "Packer" }))[0] ?? "", /Nothing reads a "products" key/);
    assert.match(
      errs(step({ panes: [STEP.panes[0], { label: "Packer Builders", note: "A note.", real: true }] }))[0] ?? "",
      /^glassBridge\[0\], panes\[1\]\.real: Nothing reads a "real" key/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Gganbu                                                              */
/* ------------------------------------------------------------------ */

describe("gganbu", () => {
  it("refuses an answer that is not over or under", () => {
    assert.match(errs(prompt({ answer: "higher" }))[0] ?? "", /"higher" is not over or under\./);
    assert.match(errs(prompt({ answer: undefined }))[0] ?? "", /^gganbu\[0\], answer: Missing\. Give the side/);
  });

  it("insists a prompt says whether its answer was checked, either way", () => {
    // The field this importer exists for. Three of the six compiled prompts are
    // flagged because their answers are configuration defaults a release can
    // move without announcing it, and a defaulted `false` on a prompt whose
    // answer has moved is the exact failure the flag is for.
    assert.match(errs(prompt({ verify: undefined }))[0] ?? "", /^gganbu\[0\], verify: Missing\. Say whether this answer was checked/);
    assert.match(errs(prompt({ verify: "yes" }))[0] ?? "", /"yes" is not true or false\./);
    assert.match(errs(prompt({ verify: 1 }))[0] ?? "", /1 is not true or false\./);
  });

  it("refuses a threshold that is not a number, because over and under need a line", () => {
    assert.match(errs(prompt({ threshold: "about twenty" }))[0] ?? "", /is not a number\. Over or under needs a line/);
    assert.match(errs(prompt({ threshold: "1,024" }))[0] ?? "", /is not a number/);
    assert.match(errs(prompt({ threshold: 15 }))[0] ?? "", /^gganbu\[0\], threshold: Missing, or not a string\./);
    assert.match(errs(prompt({ threshold: "" }))[0] ?? "", /^gganbu\[0\], threshold: This is blank\./);
  });

  it("refuses a blank cue or note", () => {
    assert.match(errs(prompt({ cue: " " }))[0] ?? "", /^gganbu\[0\], cue: This is blank\./);
    assert.match(errs(prompt({ note: undefined }))[0] ?? "", /^gganbu\[0\], note: Missing, or not a string\./);
  });

  it("refuses a bank whose every answer is the same side", () => {
    // The prompts settle one at a time and each reveal reads its note out, so
    // one settlement would hand the rest of the round away — in the one round
    // where being certain is worth five tokens.
    const lines = errs(
      JSON.stringify({ gganbu: [{ ...PROMPT, answer: "over" }, { ...PROMPT, cue: "Another", answer: "over" }] }),
    );
    assert.match(lines[0] ?? "", /^gganbu, answer: Every prompt answers "over"\./);
  });

  it("allows a single prompt, which has no second prompt to give away", () => {
    assert.equal(ok(prompt({ answer: "over" })).gganbu?.length, 1);
  });

  it("allows answers that alternate, which is a shape and not the answer", () => {
    // `gganbu.ts` argues that a player who works out that the round alternates
    // has stopped reading the prompts — and also that where the answers sit is
    // content. A run of two is not a rule the format may demand of a host.
    const content = ok(
      JSON.stringify({
        gganbu: [
          { ...PROMPT, answer: "over" },
          { ...PROMPT, cue: "Two", answer: "under" },
          { ...PROMPT, cue: "Three", answer: "over" },
        ],
      }),
    );
    assert.deepEqual(content.gganbu?.map((p) => p.answer), ["over", "under", "over"]);
  });
});
