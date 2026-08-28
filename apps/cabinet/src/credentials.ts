/**
 * The two things about a password that are still the cabinet's own: how short
 * one is allowed to be, and how one is generated when nobody is there to choose
 * it.
 *
 * Everything else that used to be in this file has gone. ADR-0009 hands the
 * deriving, the comparing and the session identifiers to a component, and what
 * is left is the pair of decisions that component has no opinion about — the
 * floor a person's own password has to clear, and the alphabet a password
 * printed to a terminal is spelled in.
 */

import { randomInt } from "node:crypto";

/** The floor under a password somebody chooses for themselves. */
export const MINIMUM_PASSWORD_LENGTH = 12;

/**
 * The alphabet a generated password is spelled in.
 *
 * Lower case, no digits that look like letters and no letters that look like
 * digits: no `l`, no `o`, no `0`, no `1`. It gets read aloud or copied by hand
 * at least once, by whoever runs the command that makes an account, and a
 * character that can be mistaken for another is a conversation about why the
 * sign-in does not work.
 */
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** How many characters a generated password gets: 32^24, which is 120 bits. */
const GENERATED_LENGTH = 24;

/**
 * A password nobody chose and nobody will reuse.
 *
 * ADR-0009 leaves the sign-in form without a rate limit on purpose — a lockout
 * would hand anybody who knows an address a way to shut the merchant out of the
 * control that stops their selling. This is the other half of that argument:
 * the password guessing has to get through is not one a person thought of.
 */
export const newPassword = (): string => {
  let password = "";
  for (let taken = 0; taken < GENERATED_LENGTH; taken += 1) {
    // randomInt rather than a byte modulo the alphabet: 256 does not divide 32
    // evenly in the general case, and the bias that leaves is exactly the kind
    // of thing nobody notices in a password that still looks random.
    password += ALPHABET[randomInt(ALPHABET.length)];
  }
  return password;
};
