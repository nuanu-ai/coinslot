/**
 * The two secrets the cabinet mints and checks: a person's password and the
 * identifier of their session.
 *
 * Every test here answers the same question — which promise to a person breaks
 * if this fails — and the promises are unusually blunt for a unit test. A
 * password that survives in the stored value, a comparison that says how much
 * of a password was right, a sign-in that says out loud which addresses have
 * accounts: each is a door somebody walks through, and none of them shows up on
 * a screen.
 */

import { describe, expect, it } from "vitest";
import {
  fingerprintOf,
  hashPassword,
  MINIMUM_PASSWORD_LENGTH,
  newPassword,
  newSessionToken,
  passwordMatches,
} from "./credentials.js";

const PASSWORD = "a-password-nobody-guesses";

describe("a person's password", () => {
  it("is recognised again, and a different one is not", async () => {
    const stored = await hashPassword(PASSWORD);

    await expect(passwordMatches(PASSWORD, stored)).resolves.toBe(true);
    await expect(passwordMatches(`${PASSWORD}!`, stored)).resolves.toBe(false);
    await expect(passwordMatches(PASSWORD.slice(0, -1), stored)).resolves.toBe(false);
    await expect(passwordMatches("", stored)).resolves.toBe(false);
  });

  it("is not in the stored value, and no two people's stored values look alike", async () => {
    // Two accounts with the same password must not be visible as such in a
    // dump of the table: equal stored values would tell whoever holds the dump
    // which accounts to attack together.
    const first = await hashPassword(PASSWORD);
    const second = await hashPassword(PASSWORD);

    expect(first).not.toContain(PASSWORD);
    expect(second).not.toContain(PASSWORD);
    expect(first).not.toBe(second);
    await expect(passwordMatches(PASSWORD, second)).resolves.toBe(true);
  });

  it("says what it is, so the cost can be raised without a second field", async () => {
    // The parameters live in the value rather than in the code that wrote it.
    // Without that, raising the cost means either a migration of everybody's
    // password or a column that can disagree with the rows beside it.
    const stored = await hashPassword(PASSWORD);
    const [algorithm, work] = stored.split("$");

    expect(algorithm).toBe("scrypt");
    expect(Number(work)).toBeGreaterThanOrEqual(16_384);
  });

  it("refuses a stored value it cannot read instead of taking the process down", async () => {
    // A row that is truncated, from an older format, or simply wrong must read
    // as "this password does not match" — the sign-in page — rather than as an
    // exception on the error page, which is where a merchant gets stuck with a
    // cookie they cannot clear.
    for (const broken of [
      "",
      "not-a-stored-password",
      "scrypt$16384$8$1$onlyfourfields",
      "scrypt$16384$8$1$AAAA$AAAA",
      "argon2$16384$8$1$AAAA$AAAA",
      "scrypt$0$8$1$AAAA$AAAA",
      "scrypt$notanumber$8$1$AAAA$AAAA",
      // A cost nobody wrote and nothing should try to honour: at this N a
      // derivation would ask for terabytes. Refused rather than attempted.
      "scrypt$1073741824$8$1$AAAA$AAAA",
    ]) {
      await expect(passwordMatches(PASSWORD, broken), broken).resolves.toBe(false);
    }
  });

  it("does the same work for an address with no account as for a wrong password", async () => {
    // Otherwise the sign-in form is an oracle for which addresses have
    // accounts: the wrong-password answer takes a derivation and the
    // no-such-person answer returns at once, and the difference is plain from
    // outside without reading anything.
    const stored = await hashPassword(PASSWORD);
    await passwordMatches(PASSWORD, stored); // warm the pool before either clock

    const started = performance.now();
    const answered = await passwordMatches(PASSWORD, null);
    const took = performance.now() - started;

    expect(answered).toBe(false);
    // A short-circuited `return false` is thousandths of a millisecond. A
    // derivation is two orders of magnitude above this floor on any machine
    // that can run the cabinet at all.
    expect(took).toBeGreaterThan(5);
  });
});

describe("a password we generate", () => {
  it("is long, and is different every time", () => {
    const first = newPassword();
    const second = newPassword();

    expect(first.length).toBeGreaterThanOrEqual(MINIMUM_PASSWORD_LENGTH);
    expect(first).not.toBe(second);
    // Long enough that the absence of a rate limit on sign-in is a decision
    // rather than an accident (ADR-0009). Twenty characters out of an alphabet
    // of thirty-two is a hundred bits.
    expect(first.length).toBeGreaterThanOrEqual(20);
  });

  it("is made of characters a person can read out over a telephone", () => {
    // It is handed over by whoever runs the command that makes the account, and
    // it gets read aloud or copied by hand at least once. A character that can be
    // confused for another is a support conversation.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect(newPassword()).toMatch(/^[a-z2-9]+$/);
      expect(newPassword()).not.toMatch(/[lo]/);
    }
  });
});

describe("the identifier of a session", () => {
  it("is different every time and long enough not to be guessed", () => {
    const seen = new Set<string>();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      seen.add(newSessionToken());
    }

    expect(seen.size).toBe(100);
    // 32 bytes in base64url. A shorter one would be a session anybody with a
    // few million requests could walk into.
    for (const token of seen) {
      expect(token.length).toBeGreaterThanOrEqual(43);
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("is stored as something that cannot be spent", () => {
    // What the database holds is the fingerprint, so a dump of the table, a
    // backup or a query left in somebody's terminal history is not a pile of
    // live sessions.
    const token = newSessionToken();
    const held = fingerprintOf(token);

    expect(held).not.toBe(token);
    expect(held).not.toContain(token);
    expect(held).toBe(fingerprintOf(token));
    expect(held).not.toBe(fingerprintOf(newSessionToken()));
  });
});
