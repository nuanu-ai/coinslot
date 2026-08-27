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
 * One name never gets this far: see `PROTOTYPE_KEY_IS_DROPPED` below.
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
 * What silence about `required` means depends on which of a card's two
 * declarations this is, and the compiler below is where that is decided. In
 * the purchase parameters a field with no flag is one the agent may leave out;
 * in the delivery result it is one that arrives. Setting the flag says the
 * same thing in both directions, and it is the only way to say the opposite.
 */
export const FieldSpecSchema = z.strictObject({
  type: ParamTypeSchema,
  required: z.boolean().optional(),
  title: z.string().regex(/\S/, "a title must not be empty or blank").optional(),
});

/**
 * The one silent loss in this contract, written down once because five places
 * have it and a note on one of them was worse than none.
 *
 * A key named `__proto__` is removed by zod while a record is parsed, before
 * any check of ours runs — so it is neither carried nor refused, and nobody is
 * told. It applies wherever this contract parses a record of free-form names,
 * and there are five of those: a card's `params` and `result` here, an order's
 * `params`, a purchase's `params`, a price question's `params`, and a delivery.
 * The check compiled below is not a sixth. It is built from a spec that has
 * already been through the record above, so a name that would have been
 * dropped is gone before the compiler ever sees it.
 *
 * Every one of those is a place the portal promises to pass values through
 * unchanged, so the loss is worth knowing about even though nothing can
 * legitimately reach it: no card can declare such a field, so a merchant only
 * meets this by sending a name nobody asked for. The behaviour is zod's, not
 * ours, and it is the reason the compiler below can never be handed a name
 * that would set a prototype instead of declaring a field. A test holds it in
 * place, so a change in zod is noticed here rather than in production.
 */
export const PROTOTYPE_KEY_IS_DROPPED = "__proto__";

/** A whole declaration: the parameters of a purchase, or a delivery result. */
export const ParamSpecSchema = z.record(ParamNameSchema, FieldSpecSchema);

export type ParamType = z.infer<typeof ParamTypeSchema>;
export type FieldSpec = z.infer<typeof FieldSpecSchema>;
export type ParamSpec = z.infer<typeof ParamSpecSchema>;

const checkFor = (type: ParamType, direction: ParamSpecDirection): z.ZodType => {
  switch (type) {
    case "string":
      // A delivered string carries something. This is the one place the two
      // directions hold the same declared type to different rules, and the
      // asymmetry is the point rather than an oversight.
      //
      // In a purchase, an empty string is input the agent chose to give: a
      // note left blank, a name it does not have. Refusing it would be this
      // package inventing a requirement no card asked for.
      //
      // In a delivery the field is a promise about what the buyer receives,
      // and an empty access code is not a shorter access code — it is nothing,
      // arriving under the name of something. Without this the check refuses
      // `{}` and accepts `{access_code: ""}`, which are the same outcome for
      // the buyer, and only one of them would be caught. Every other string on
      // this wire is already held this way — a title, a description, a refusal
      // code and its message all refuse to be blank — and the one the buyer
      // actually paid for was the exception.
      return direction === "delivery"
        ? z.string().regex(/\S/, "a delivered field carries something, and this one is blank")
        : z.string();
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
 * It decides two things, and both come from the same difference: a purchase is
 * input the agent is being asked for, and a delivery is a promise the card
 * made to it before it paid.
 *
 * What silence about `required` means. In a purchase the portal writes
 * `required: true` only where it means it, so a field with no flag is one the
 * agent may leave out. In a delivery a declared field is one that arrives — a
 * flag-less field treated as optional would make the promise unenforceable,
 * and a merchant could deliver an empty object against a card that advertised
 * three fields. A delivery field that genuinely may be absent says so with
 * `required: false`.
 *
 * And whether a string may be empty. It may in a purchase and may not in a
 * delivery, for the reason written beside the check itself.
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
 * One thing this cannot refuse is a key named `__proto__`; see
 * `PROTOTYPE_KEY_IS_DROPPED` above.
 *
 * The spec is expected to have been parsed by `ParamSpecSchema` already; that
 * is what the parameter type says.
 */
export const paramSpecToValidator = (spec: ParamSpec, direction: ParamSpecDirection): z.ZodType => {
  const shape: Record<string, z.ZodType> = {};

  for (const [name, field] of Object.entries(spec)) {
    const check = checkFor(field.type, direction);
    const required = field.required ?? direction === "delivery";
    shape[name] = required ? check : check.optional();
  }

  return z.strictObject(shape);
};
