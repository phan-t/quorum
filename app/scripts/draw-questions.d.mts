/**
 * Types for `draw-questions.mjs`, so `draw-questions.test.ts` can import it
 * under `strict`. Hand-written for the reason `strip-comments.d.mts` is: the
 * staging script runs under plain `node` and cannot import a `.ts`.
 */
export declare const QUESTION_COUNT: number;
export declare function readBank(
  raw: string,
  name: string,
):
  | { ok: true; bank: Record<string, unknown>; questions: unknown[] }
  | { ok: false; error: string };
export declare function drawQuestions(
  shared: { bank: Record<string, unknown>; questions: unknown[] },
  additional: unknown[],
  count: number,
  pick?: (n: number) => number,
): {
  raw: string;
  drawn: number;
  of: number;
  additional: number;
  tiebreakers: number;
};
