/**
 * The two things the domain refuses to produce for itself.
 *
 * `@coinslot/core` reads no clock and invents no identifier: every event
 * carries the instant it happened at, so the same inputs always produce the
 * same order. That discipline only holds if the instant comes from somewhere,
 * and this is where. Both are parameters rather than imports so a test can
 * hold time still and name every order it makes.
 */

import { randomUUID } from "node:crypto";

/** The current instant, in milliseconds since the epoch. */
export type Clock = () => number;

/** A fresh identifier of the given kind. */
export type Ids = (kind: string) => string;

export const systemClock: Clock = () => Date.now();

/**
 * Identifiers that carry what they name. The kind is a courtesy to whoever
 * reads a log — "ord_" in front of a number is the difference between finding
 * an order and searching for a string — and the rest is random, because an
 * identifier a stranger can guess the next of is an identifier that leaks how
 * much we sold.
 */
export const randomIds: Ids = (kind) => `${kind}_${randomUUID().replaceAll("-", "")}`;

/** The instant, written the way every document on the wire writes one. */
export const asTimestamp = (at: number): string => new Date(at).toISOString();
