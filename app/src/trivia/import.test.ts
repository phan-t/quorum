/**
 * CSV import tests. See SPEC.md "Trivia > CSV format".
 *
 * The load-bearing test is the first one: the real 20-question set in
 * `activities/hashicorp-ibm-trivia/kahoot-import.csv`, copied verbatim into
 * ./fixtures, must import unchanged. The expected table below was produced
 * from that file by a different CSV reader (Python's `csv` module) rather than
 * by this importer, so it is an independent oracle and not a snapshot of
 * whatever the code happens to do.
 *
 * `fs` appears here and nowhere in the importer: the importer takes text.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { Question } from "../engine/types.ts";
import {
  formatErrors,
  importTriviaCsv,
  type ImportError,
  type ImportResult,
} from "./import.ts";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const HEADER =
  "Question,Answer 1,Answer 2,Answer 3,Answer 4,Time limit (sec),Correct answer(s)";
const HEADER_FULL = `${HEADER},Note,Round,Points`;

function ok(result: ImportResult): readonly Question[] {
  if (!result.ok) {
    assert.fail(`expected the import to succeed, got:\n${formatErrors(result.errors).join("\n")}`);
  }
  return result.questions;
}

function failed(result: ImportResult): readonly ImportError[] {
  assert.ok(!result.ok, "expected the import to fail");
  return result.errors;
}

/** One question imported from a single data row under the full header. */
function one(row: string): readonly Question[] {
  return ok(importTriviaCsv(`${HEADER_FULL}\n${row}\n`));
}

function errorsFor(row: string): readonly ImportError[] {
  return failed(importTriviaCsv(`${HEADER_FULL}\n${row}\n`));
}

/* ------------------------------------------------------------------ */
/* The real file                                                       */
/* ------------------------------------------------------------------ */

/** [question, answers, time limit, 0-based correct] — from Python's csv. */
const EXPECTED: readonly [string, readonly string[], number, readonly number[]][] = [
  ["In what year was HashiCorp founded?", ["2008", "2010", "2012", "2015"], 20, [2]],
  ["Which was HashiCorp's first product?", ["Terraform", "Vagrant", "Vault", "Consul"], 20, [1]],
  ["Who co-founded HashiCorp with Armon Dadgar?", ["Mitchell Hashimoto", "Solomon Hykes", "Kelsey Hightower", "Adam Jacob"], 20, [0]],
  ["Which HashiCorp product was released first?", ["Vault", "Consul", "Nomad", "Boundary"], 30, [1]],
  ["Which two products were announced together at HashiConf Digital 2020?", ["Vault & Consul", "Boundary & Waypoint", "Nomad & Packer", "Terraform & Sentinel"], 30, [1]],
  ["What is HashiCorp's published product design philosophy called?", ["The HashiCorp Way", "The Tao of HashiCorp", "The Blue Book", "Infrastructure Manifesto"], 20, [1]],
  ["Which product does secrets management, encryption as a service and dynamic credentials?", ["Consul", "Boundary", "Vault", "Nomad"], 20, [2]],
  ["Which product gives secure remote access to hosts without distributing SSH keys or VPNs?", ["Consul", "Boundary", "Vault", "Packer"], 20, [1]],
  ["Which product schedules containers, raw binaries, Java and VMs as workloads?", ["Nomad", "Consul", "Waypoint", "Terraform"], 20, [0]],
  ["Which product does service discovery, health checking and service mesh?", ["Nomad", "Boundary", "Consul", "Terraform"], 20, [2]],
  ["Which product builds identical machine images for many platforms from one config?", ["Vagrant", "Packer", "Waypoint", "Terraform"], 20, [1]],
  ["Which product creates reproducible dev environments, driven by a Vagrantfile?", ["Packer", "Waypoint", "Vagrant", "Nomad"], 20, [2]],
  ["What is HashiCorp's policy-as-code framework called?", ["Rego", "Gatekeeper", "Sentinel", "Guardrail"], 20, [2]],
  ["Which product scans code and systems for leaked secrets?", ["Vault Sentinel", "Vault Radar", "Consul Watch", "Vault Scout"], 30, [1]],
  ["Which Terraform command previews changes without applying them?", ["terraform preview", "terraform plan", "terraform dry-run", "terraform diff"], 20, [1]],
  ["By default, what is Terraform's state file called?", ["state.json", "terraform.tfstate", "tfstate.lock", "main.tfstate"], 20, [1]],
  ["What best describes a Vault dynamic secret?", ["A secret that rotates yearly", "A credential generated on demand, with a lease", "An encrypted static value", "A secret shared between two apps"], 30, [1]],
  ["Which consensus protocol backs integrated storage in Vault, Consul and Nomad?", ["Paxos", "Raft", "Zab", "Two-phase commit"], 20, [1]],
  ["What is IBM's long-standing nickname?", ["Big Iron", "Big Blue", "The Blue Giant", "Blue Sky"], 10, [1]],
  ["IBM's Deep Blue defeated which world chess champion in 1997?", ["Anatoly Karpov", "Magnus Carlsen", "Garry Kasparov", "Vladimir Kramnik"], 20, [2]],
];

describe("the real Kahoot file", () => {
  const text = readFileSync(
    new URL("./fixtures/kahoot-import.csv", import.meta.url),
    "utf8",
  );

  test("loads unchanged", () => {
    const questions = ok(importTriviaCsv(text));
    assert.equal(questions.length, 20);
    assert.deepEqual(
      questions.map((q) => [q.text, q.answers, q.timeLimitSec, q.correct]),
      EXPECTED.map(([t, a, l, c]) => [t, a, l, c]),
    );
  });

  test("quoted fields containing commas survive whole", () => {
    const questions = ok(importTriviaCsv(text));
    assert.equal(
      questions[6]?.text,
      "Which product does secrets management, encryption as a service and dynamic credentials?",
    );
    assert.equal(
      questions[16]?.answers[1],
      "A credential generated on demand, with a lease",
    );
  });

  test("it has only the seven Kahoot columns, so the extras take their defaults", () => {
    for (const q of ok(importTriviaCsv(text))) {
      assert.equal(q.note, null);
      assert.equal(q.round, null);
      assert.equal(q.basePoints, 1000, "Points defaults to 1000");
    }
  });

  test("a Windows line ending or an Excel BOM does not change the result", () => {
    const plain = ok(importTriviaCsv(text));
    assert.deepEqual(ok(importTriviaCsv(text.replace(/\n/g, "\r\n"))), plain);
    assert.deepEqual(ok(importTriviaCsv(`\uFEFF${text}`)), plain);
  });
});

/* ------------------------------------------------------------------ */
/* The optional columns                                                */
/* ------------------------------------------------------------------ */

describe("the optional columns", () => {
  test("Note, Round and Points are read when present", () => {
    const [q] = one(
      'Why?,a,b,c,d,20,2,"Dynamic credentials are the bit people forget.",Name that product,500',
    );
    assert.equal(q?.note, "Dynamic credentials are the bit people forget.");
    assert.equal(q?.round, "Name that product");
    assert.equal(q?.basePoints, 500);
  });

  test("blank Note and Round are null, not empty strings", () => {
    const [q] = one("Why?,a,b,c,d,20,2,,,");
    assert.equal(q?.note, null);
    assert.equal(q?.round, null);
  });

  test("Points defaults to 1000 and 0 is a legal warm-up", () => {
    assert.equal(one("Why?,a,b,c,d,20,2,,,")[0]?.basePoints, 1000);
    assert.equal(one("Why?,a,b,c,d,20,2,,,0")[0]?.basePoints, 0);
  });

  test("a file with only the seven Kahoot columns is valid", () => {
    const questions = ok(importTriviaCsv(`${HEADER}\nWhy?,a,b,c,d,20,2\n`));
    assert.equal(questions.length, 1);
    assert.equal(questions[0]?.basePoints, 1000);
  });

  test("columns Kahoot adds that we do not know about are ignored", () => {
    const questions = ok(
      importTriviaCsv(`${HEADER},Media,Image\nWhy?,a,b,c,d,20,2,gif,pic.png\n`),
    );
    assert.equal(questions.length, 1);
  });

  test("Points must be a whole number", () => {
    for (const bad of ["-100", "1e3", "500.5", "lots"]) {
      const errors = errorsFor(`Why?,a,b,c,d,20,2,,,${bad}`);
      assert.equal(errors[0]?.column, "Points");
      assert.equal(errors[0]?.line, 2);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Answers                                                             */
/* ------------------------------------------------------------------ */

describe("answers", () => {
  test("a two-answer question is made by leaving Answer 3 and 4 blank", () => {
    const [q] = one("True or false?,True,False,,,20,1,,,");
    assert.deepEqual(q?.answers, ["True", "False"]);
    assert.deepEqual(q?.correct, [0]);
  });

  test("a three-answer question leaves only Answer 4 blank", () => {
    const [q] = one("Pick one,a,b,c,,20,3,,,");
    assert.deepEqual(q?.answers, ["a", "b", "c"]);
    assert.deepEqual(q?.correct, [2]);
  });

  test("the Answer 3 and Answer 4 columns may be absent altogether", () => {
    const questions = ok(
      importTriviaCsv(
        'Question,Answer 1,Answer 2,Time limit (sec),Correct answer(s)\nTrue or false?,True,False,20,2\n',
      ),
    );
    assert.deepEqual(questions[0]?.answers, ["True", "False"]);
    assert.deepEqual(questions[0]?.correct, [1]);
  });

  test("one answer is not a question", () => {
    const errors = errorsFor("Why?,only,,,,20,1,,,");
    assert.equal(errors.length, 1);
    assert.match(errors[0]?.message ?? "", /at least 2 answers/);
  });

  test("a blank in the middle is refused — it would shift every index", () => {
    const errors = errorsFor("Why?,a,,c,d,20,1,,,");
    assert.ok(
      errors.some((e) => /no blanks in between/.test(e.message)),
      formatErrors(errors).join("\n"),
    );
  });

  test("an answer longer than 80 characters is refused, naming the column", () => {
    const long = "x".repeat(81);
    const errors = errorsFor(`Why?,a,${long},c,d,20,1,,,`);
    assert.equal(errors[0]?.column, "Answer 2");
    assert.match(errors[0]?.message ?? "", /81 characters/);
    // 80 exactly is fine.
    assert.equal(one(`Why?,a,${"x".repeat(80)},c,d,20,1,,,`)[0]?.answers[1]?.length, 80);
  });
});

/* ------------------------------------------------------------------ */
/* Correct answer(s)                                                   */
/* ------------------------------------------------------------------ */

describe("correct answer(s)", () => {
  test("1-based in the file, 0-based in the engine", () => {
    assert.deepEqual(one("Why?,a,b,c,d,20,1,,,")[0]?.correct, [0]);
    assert.deepEqual(one("Why?,a,b,c,d,20,4,,,")[0]?.correct, [3]);
  });

  test("several, separated by semicolons — any of them is correct", () => {
    assert.deepEqual(one("Why?,a,b,c,d,20,2;4,,,")[0]?.correct, [1, 3]);
    assert.deepEqual(one('Why?,a,b,c,d,20," 2 ; 3 ",,,')[0]?.correct, [1, 2]);
    assert.deepEqual(one("Why?,a,b,c,d,20,4;2;1,,,")[0]?.correct, [0, 1, 3]);
  });

  test("a repeated index is not an error, and appears once", () => {
    assert.deepEqual(one("Why?,a,b,c,d,20,2;2,,,")[0]?.correct, [1]);
  });

  test("0 is refused: the file is 1-based", () => {
    const errors = errorsFor("Why?,a,b,c,d,20,0,,,");
    assert.equal(errors[0]?.column, "Correct answer(s)");
    assert.match(errors[0]?.message ?? "", /Answer 0 does not exist/);
  });

  test("an index past the answers this question has is refused", () => {
    const errors = errorsFor("Why?,a,b,,,20,3,,,");
    assert.match(errors[0]?.message ?? "", /this question has 2/);
  });

  test("blank or unreadable is refused", () => {
    assert.match(errorsFor("Why?,a,b,c,d,20,,,,")[0]?.message ?? "", /No correct answer/);
    assert.match(errorsFor("Why?,a,b,c,d,20,two,,,")[0]?.message ?? "", /not an answer number/);
    assert.match(errorsFor("Why?,a,b,c,d,20,2;,,,")[0]?.message ?? "", /not an answer number/);
  });
});

/* ------------------------------------------------------------------ */
/* Question text and time limit                                        */
/* ------------------------------------------------------------------ */

describe("question text", () => {
  test("200 characters is fine and 201 is not", () => {
    assert.equal(one(`${"x".repeat(200)},a,b,c,d,20,1,,,`)[0]?.text.length, 200);
    const errors = errorsFor(`${"x".repeat(201)},a,b,c,d,20,1,,,`);
    assert.equal(errors[0]?.column, "Question");
    assert.match(errors[0]?.message ?? "", /201 characters/);
  });

  test("characters are counted as people see them, not as UTF-16 units", () => {
    // 150 emoji are 300 UTF-16 units but 150 characters, and fit the limit.
    assert.equal(one(`${"🙂".repeat(150)},a,b,c,d,20,1,,,`).length, 1);
  });

  test("a blank question is refused", () => {
    assert.match(errorsFor(",a,b,c,d,20,1,,,")[0]?.message ?? "", /blank/);
  });
});

describe("time limit", () => {
  test("5 and 120 are the edges", () => {
    assert.equal(one("Why?,a,b,c,d,5,1,,,")[0]?.timeLimitSec, 5);
    assert.equal(one("Why?,a,b,c,d,120,1,,,")[0]?.timeLimitSec, 120);
  });

  test("outside 5–120 is refused", () => {
    for (const bad of ["4", "0", "121", "600"]) {
      const errors = errorsFor(`Why?,a,b,c,d,${bad},1,,,`);
      assert.equal(errors[0]?.column, "Time limit (sec)");
      assert.match(errors[0]?.message ?? "", /outside 5–120/);
    }
  });

  test("blank or not a number is refused", () => {
    assert.match(errorsFor("Why?,a,b,c,d,,1,,,")[0]?.message ?? "", /blank/);
    assert.match(errorsFor("Why?,a,b,c,d,20.5,1,,,")[0]?.message ?? "", /not a whole number/);
    assert.match(errorsFor("Why?,a,b,c,d,twenty,1,,,")[0]?.message ?? "", /not a whole number/);
  });
});

/* ------------------------------------------------------------------ */
/* The header                                                          */
/* ------------------------------------------------------------------ */

describe("the header", () => {
  test("a missing required column is named, on line 1", () => {
    const errors = failed(
      importTriviaCsv("Question,Answer 1,Answer 2,Answer 3,Answer 4,Time limit (sec)\nWhy?,a,b,c,d,20\n"),
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.line, 1);
    assert.equal(errors[0]?.column, "Correct answer(s)");
  });

  test("header names match by exact text, so the file stays a Kahoot import", () => {
    for (const wrong of ["Time Limit (sec)", "Time limit (s)", "time limit (sec)"]) {
      const errors = failed(
        importTriviaCsv(
          `Question,Answer 1,Answer 2,Answer 3,Answer 4,${wrong},Correct answer(s)\nWhy?,a,b,c,d,20,2\n`,
        ),
      );
      assert.equal(errors[0]?.column, "Time limit (sec)");
    }
  });

  test("a duplicated column is refused rather than silently resolved", () => {
    const errors = failed(
      importTriviaCsv(`${HEADER},Question\nWhy?,a,b,c,d,20,2,Why again?\n`),
    );
    assert.match(errors[0]?.message ?? "", /appears twice/);
  });

  test("an empty file, and a file with nothing but a header", () => {
    assert.match(failed(importTriviaCsv(""))[0]?.message ?? "", /empty/);
    assert.match(failed(importTriviaCsv(`${HEADER}\n`))[0]?.message ?? "", /no questions/);
  });
});

/* ------------------------------------------------------------------ */
/* All or nothing                                                      */
/* ------------------------------------------------------------------ */

describe("all or nothing", () => {
  const good = (n: number) => `Question ${n}?,a,b,c,d,20,2`;

  test("one bad row rejects the whole file, not just that row", () => {
    const result = importTriviaCsv(
      [HEADER, good(1), good(2), "Question 3?,a,b,c,d,999,2", good(4)].join("\n") + "\n",
    );
    const errors = failed(result);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.line, 4, "the header is line 1, so row 3 is line 4");
    assert.ok(!("questions" in result), "no questions come back from a failed import");
  });

  test("every bad row is reported, not just the first", () => {
    const errors = failed(
      importTriviaCsv(
        [HEADER, good(1), ",a,b,c,d,20,2", good(3), "Question 4?,a,b,c,d,20,9"].join("\n") + "\n",
      ),
    );
    assert.deepEqual(errors.map((e) => e.line), [3, 5]);
  });

  test("a row can produce more than one error", () => {
    const errors = errorsFor(`${"x".repeat(201)},a,,,,1,7,,,`);
    assert.ok(errors.length >= 3, formatErrors(errors).join("\n"));
    assert.deepEqual(new Set(errors.map((e) => e.line)), new Set([2]));
  });

  test("errors are line-numbered for a human reading the file", () => {
    const errors = errorsFor("Why?,a,b,c,d,600,2,,,");
    assert.deepEqual(formatErrors(errors), [
      "Line 2, Time limit (sec): 600 is outside 5–120 seconds.",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* CSV mechanics                                                       */
/* ------------------------------------------------------------------ */

describe("CSV mechanics", () => {
  test("a doubled quote inside a quoted field is one quote", () => {
    const [q] = one('"What does ""terraform plan"" do?",a,b,c,d,20,1,,,');
    assert.equal(q?.text, 'What does "terraform plan" do?');
  });

  test("a newline inside a quoted field does not break the line numbering", () => {
    const errors = failed(
      importTriviaCsv(
        `${HEADER}\n"Two\nlines?",a,b,c,d,20,2\nWhy?,a,b,c,d,600,2\n`,
      ),
    );
    // The good row spans lines 2 and 3; the bad row starts on line 4.
    assert.equal(errors[0]?.line, 4);
  });

  test("a row with more values than the header has columns is refused", () => {
    const errors = failed(importTriviaCsv(`${HEADER}\nWhy?,a,b,c,d,20,2,extra\n`));
    assert.match(errors[0]?.message ?? "", /8 values but the header has 7 columns/);
  });

  test("trailing empty values are tolerated", () => {
    assert.equal(ok(importTriviaCsv(`${HEADER}\nWhy?,a,b,c,d,20,2,\n`)).length, 1);
  });

  test("blank lines anywhere are skipped", () => {
    const questions = ok(
      importTriviaCsv(`${HEADER}\n\nWhy?,a,b,c,d,20,2\n\n\nWhy not?,a,b,c,d,20,2\n\n`),
    );
    assert.equal(questions.length, 2);
  });

  test("an unclosed quote is reported against the line it opened on", () => {
    const errors = failed(
      importTriviaCsv(`${HEADER}\nWhy?,a,b,c,d,20,2\n"Never closed,a,b,c,d,20,2\n`),
    );
    assert.equal(errors[0]?.line, 3);
    assert.match(errors[0]?.message ?? "", /never closed/);
  });

  test("surrounding whitespace in a cell is trimmed", () => {
    const [q] = one("  Why?  , a , b ,,, 20 , 1 ,  ,  ,  ");
    assert.equal(q?.text, "Why?");
    assert.deepEqual(q?.answers, ["a", "b"]);
    assert.equal(q?.timeLimitSec, 20);
    assert.equal(q?.note, null);
  });
});
