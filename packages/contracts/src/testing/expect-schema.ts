/**
 * Shared assertions for the contract tests.
 *
 * Why this file exists. The charter asks every required field of a schema for
 * a negative test with an intelligible error, and a schema with ten fields
 * then wants ten near-identical tests. Written by hand ten times, one of them
 * ends up asserting nothing; written once here, the shape of the assertion is
 * the same everywhere and the message it demands is the message a merchant
 * will actually read.
 *
 * This file is not part of the published surface: nothing in `index.ts`
 * re-exports it, and its name keeps it out of the test glob.
 */

import { expect } from "vitest";
import { z } from "zod";

/**
 * Drops one top-level field from an otherwise valid value and demands two
 * things of the schema: that it refuses the result, and that the error names
 * the field that went missing.
 *
 * The second half is the part that matters. "Invalid input" tells a merchant
 * that something is wrong with a card of nine fields and leaves them to guess
 * which one; naming the field turns the same failure into a one-line fix.
 *
 * Nested fields are not covered here on purpose — each nested object is a
 * schema of its own in this package and carries its own tests.
 */
export const expectMissingFieldRejected = (
  schema: z.ZodType,
  valid: Record<string, unknown>,
  field: string,
): void => {
  expect(Object.hasOwn(valid, field), `${field} is not present in the valid value`).toBe(true);

  const withoutField = Object.fromEntries(Object.entries(valid).filter(([name]) => name !== field));
  const result = schema.safeParse(withoutField);

  expect(result.success, `the schema accepted a value without "${field}"`).toBe(false);
  if (result.success) return;
  expect(z.prettifyError(result.error)).toContain(field);
};

/** The error a schema produced, rendered the way a consumer would read it. */
export const errorOf = (schema: z.ZodType, value: unknown): string => {
  const result = schema.safeParse(value);
  expect(result.success, "the schema accepted a value that the test expects it to reject").toBe(
    false,
  );
  return result.success ? "" : z.prettifyError(result.error);
};
