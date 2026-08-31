/**
 * The small amount of schema machinery this package needs, written against the
 * shape of a result rather than against the library that produces it.
 *
 * The reason is the dependency tree a merchant installs. The SDK declares one
 * runtime dependency, `@nuanu-ai/coinslot-contracts`, and zod arrives underneath it
 * (ADR-0003 §8). Importing zod here by name would add a package to that tree
 * without a recorded decision — and under a strict install it would not even
 * resolve, because zod is the contracts package's dependency and not ours. So
 * the schemas are used through the objects contracts exports, and where a type
 * has to be named at all it is named by its shape.
 *
 * Nothing here reimplements validation. The checking is the contracts
 * schemas', every time; this file only carries their findings across into the
 * shape a merchant reads.
 */

import type { PublishError } from "@nuanu-ai/coinslot-contracts";

/**
 * One finding of a schema, as much of it as this package reads.
 *
 * `code` is optional because it is optional on the shape zod produces, and a
 * finding with no code still has a path and a sentence. Where it is missing
 * the translation below supplies one rather than leaving the field out: a
 * consumer branching on the code should never have to tell "no code" from "the
 * field did not arrive".
 */
export interface SchemaIssue {
  readonly code?: string | undefined;
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/** The code a finding travels under when the schema did not name one. */
export const UNNAMED_FINDING = "invalid";

/**
 * A schema's findings, in the shape the publish call answers in.
 *
 * One shape for both sides is the point. A merchant who ran the check locally
 * and a merchant who published and was refused read the same object — a path
 * to the field, a code for their code, a sentence for the person fixing it —
 * so neither of the two has a reader of its own.
 *
 * The path is flattened to text because that is what the contract carries. An
 * index inside an array arrives as a number and would otherwise be a number in
 * one finding and a name in the next.
 */
export const problemsOf = (issues: readonly SchemaIssue[]): PublishError[] =>
  issues.map((issue) => ({
    path: issue.path.map(String),
    code: issue.code ?? UNNAMED_FINDING,
    message: issue.message,
  }));

/**
 * The findings of a schema rendered as one block of text, one finding a line,
 * each pointing at the field it is about.
 *
 * A finding about the whole document has an empty path and is written as such
 * rather than with a blank where the field would be, so that "this is about
 * the card" and "the path went missing" do not look the same.
 */
export const describeProblems = (problems: readonly PublishError[]): string =>
  problems
    .map((problem) =>
      problem.path.length === 0
        ? `  the card as a whole: ${problem.message}`
        : `  ${problem.path.join(".")}: ${problem.message}`,
    )
    .join("\n");
