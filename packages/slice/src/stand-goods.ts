/**
 * Values the stand puts into a card's declared purchase and delivery fields.
 *
 * The same filler serves both directions because it only answers a card's
 * declaration; the direction-specific validators decide whether those values
 * are acceptable at the boundary.
 */

import type { FieldSpec, ParamSpec } from "@nuanu-ai/coinslot-contracts";

const filledValueFor = (name: string, field: FieldSpec): unknown => {
  switch (field.type) {
    case "string":
      return `${name}-value`;
    case "integer":
      return 1;
    case "number":
      return 1.5;
    case "boolean":
      return true;
  }
};

/** Fills every field a card declares, and no field it does not. */
export function filledFrom(spec: ParamSpec | undefined): Record<string, unknown> {
  if (spec === undefined) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(spec).map(([name, field]) => [name, filledValueFor(name, field)]),
  );
}
