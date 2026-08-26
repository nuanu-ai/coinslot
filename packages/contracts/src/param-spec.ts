/**
 * The small schema language a card writes its purchase parameters and its
 * delivery result in, and the compiler that turns one of those declarations
 * into a check.
 *
 * Both halves live here on purpose. The gateway validates an agent's purchase
 * against the card's `params`, and the SDK holds a merchant's delivery to the
 * card's `result`; if each side compiled the declaration its own way, a card
 * would mean two different things and the difference would only show up after
 * someone had paid.
 *
 * The language is deliberately small — four scalar types and nothing else.
 * The portal names the exact schema of parameters as still open, and a richer
 * language invented here (enumerations, lists, nested objects) would be a
 * contract nobody agreed to. It grows when a real card needs it to.
 */

import { z } from "zod";

/**
 * The types a card may declare.
 *
 * Every one of them has a check behind it in `paramSpecToValidator`. A type
 * this list does not carry would promise the agent a validation that nobody
 * performs, which is why the enumeration and the compiler sit in one file.
 */
export const ParamTypeSchema = z.enum(["string", "number", "integer", "boolean"]);

/**
 * The name of one parameter.
 *
 * A name becomes a property in JSON on both sides of the wire and a segment of
 * the error path a merchant reads, so it is held to the shape of a plain
 * identifier. Dots would collide with that path notation and spaces would make
 * the name unquotable in an error. Both `access_url` and `expiresAt` are fine:
 * which of the two a merchant writes is theirs to choose.
 *
 * One name never gets this far. A `__proto__` key is removed while the record
 * is parsed, before the name is checked at all, so a spec comes back without
 * it instead of being refused — zod's behaviour, and the reason the compiler
 * below cannot be handed a name that would set a prototype.
 */
export const ParamNameSchema = z
  .string()
  .regex(
    /^[A-Za-z][A-Za-z0-9_]*$/,
    "a parameter name starts with a letter and carries letters, digits and underscores",
  );

/**
 * One declared parameter: what type it holds, whether it has to be there, and
 * a line of human words explaining what it is for.
 *
 * `required` is absent far more often than it is present, and the portal
 * writes it only where it means it — so silence means optional. A default of
 * "required" would quietly break every card whose author left the flag off.
 */
export const FieldSpecSchema = z.strictObject({
  type: ParamTypeSchema,
  required: z.boolean().optional(),
  title: z.string().regex(/\S/, "a title must not be empty or blank").optional(),
});

/** A whole declaration: the parameters of a purchase, or a delivery result. */
export const ParamSpecSchema = z.record(ParamNameSchema, FieldSpecSchema);

export type ParamType = z.infer<typeof ParamTypeSchema>;
export type FieldSpec = z.infer<typeof FieldSpecSchema>;
export type ParamSpec = z.infer<typeof ParamSpecSchema>;

const checkFor = (type: ParamType): z.ZodType => {
  switch (type) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "integer":
      return z.int();
    case "boolean":
      return z.boolean();
  }
};

/**
 * Which of a card's two declarations is being compiled.
 *
 * It decides one thing: what silence about `required` means. In a purchase the
 * agent is being asked for input, and the portal writes `required: true` only
 * where it means it, so a field with no flag is one the agent may leave out.
 * In a delivery the card is making a promise about what the agent receives
 * before it pays, so a declared field is one that arrives — a flag-less field
 * treated as optional would make the promise unenforceable, and a merchant
 * could deliver an empty object against a card that advertised three fields.
 *
 * A delivery field that genuinely may be absent says so with `required: false`.
 */
export type ParamSpecDirection = "purchase" | "delivery";

/**
 * Turns a declaration into the check that an instance of it is held to.
 *
 * Keys the declaration does not carry are refused, in both directions. The two
 * alternatives both lie: stripping them is truncation that nobody is told
 * about, and passing them through hands the merchant's handler fields the card
 * never declared — a card that does not describe what arrives, and a way to
 * push input into someone else's code. In a delivery an undeclared field means
 * the agent paid for something other than the result it read before paying.
 *
 * One thing this cannot refuse is a key named `__proto__`: zod removes it
 * while parsing, before any check of ours runs, so it is dropped rather than
 * reported. The same note is on `ParamNameSchema` above, and a test holds that
 * behaviour in place.
 *
 * The spec is expected to have been parsed by `ParamSpecSchema` already; that
 * is what the parameter type says.
 */
export const paramSpecToValidator = (spec: ParamSpec, direction: ParamSpecDirection): z.ZodType => {
  const shape: Record<string, z.ZodType> = {};

  for (const [name, field] of Object.entries(spec)) {
    const check = checkFor(field.type);
    const required = field.required ?? direction === "delivery";
    shape[name] = required ? check : check.optional();
  }

  return z.strictObject(shape);
};
