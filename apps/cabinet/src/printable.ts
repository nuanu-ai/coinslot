/**
 * One line with nothing left in it that a terminal will act on.
 *
 * Two things in this cabinet write lines somebody reads in a terminal: the
 * account command, whose whole output is read there, and the process log, which
 * is the only record of who stopped a merchant's selling (ADR-0009 §7). Both
 * put text into those lines that somebody else wrote — an address out of a
 * form, the name a merchant gave a key — and a line is not a safe place for it
 * as it stands.
 *
 * What is taken out is the characters a terminal obeys instead of showing: an
 * escape that clears the line it is on, a carriage return that writes over the
 * row above, a newline that ends the line early so that whatever follows reads
 * as a line of its own, an override that reverses the direction text reads in.
 * A merchant who names a key with a newline and a plausible sentence after it
 * would otherwise write a second line into the record that answers "who stopped
 * the selling", in the cabinet's own voice and under somebody else's name.
 *
 * Shown rather than removed, so that a value with something odd in it looks
 * odd: text nobody can read is still better information than text that silently
 * painted over the line above it. Anything already printable is left exactly as
 * it is, so a name written in Cyrillic reads as itself — the contract lets a
 * key's label be written in any alphabet, and this must not be the thing that
 * quietly disagrees.
 */
export const printable = (line: string): string =>
  line.replaceAll(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (found) => {
    const at = found.codePointAt(0) ?? 0;
    return at <= 0xff ? `\\x${at.toString(16).padStart(2, "0")}` : `\\u{${at.toString(16)}}`;
  });
