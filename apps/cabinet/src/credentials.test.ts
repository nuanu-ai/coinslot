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

import { scrypt } from "node:crypto";
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

/**
 * The cost the stored rows in a running cabinet were written at.
 *
 * A literal here rather than the constant `credentials.ts` uses, and that is
 * the entire point of it. The decoy an unknown address is derived against is
 * built at whatever that constant says today; the rows in a database were built
 * at whatever it said when each password was set. Raise the constant alone and
 * an address with an old row answers a wrong password visibly faster than an
 * address with no account at all — which is the sign-in form telling anybody
 * who asks which addresses have accounts here, the one thing the decoy exists
 * to prevent.
 *
 * So this number moves only in a change that also re-derives the stored rows,
 * which for accounts we make by hand is the `account password` command run once
 * per person (ADR-0009 §2). A run that fails here is that change being asked
 * whether the rows were done.
 */
const ROWS_ARE_AT = { N: 32_768, r: 8, p: 1 } as const;

/** A stored value built at a cost this test names, rather than at the code's. */
const storedAt = async (
  password: string,
  cost: { N: number; r: number; p: number },
  length = 32,
): Promise<string> => {
  const salt = Buffer.from("c2FsdGVkc2FsdGVkc2E", "base64url");
  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, length, { ...cost, maxmem: 256 * 1024 * 1024 }, (failed, derived) =>
      failed === null ? resolve(derived) : reject(failed),
    );
  });
  return [
    "scrypt",
    cost.N,
    cost.r,
    cost.p,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
};

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

describe("a stored value whose key is too short to be one", () => {
  it("is refused rather than compared against its first byte", async () => {
    // At one byte, one guess in 256 matches — which is not a password. The
    // first version of this guarded only the zero-length case, one byte short
    // of the reasoning its own comment gave, and a test that merely tried a
    // wrong password against such a row passed 255 times in 256.
    //
    // So the row here is built to match: the key in it is the first byte of the
    // derivation of a password this test knows. Refused, that password does not
    // match. Compared, it does, and there is no luck in it either way.
    const cheap = { N: 2, r: 1, p: 1 };
    const shortened = (length: number): Promise<string> => storedAt(PASSWORD, cheap, length);

    for (const length of [1, 8, 16, 31]) {
      await expect(
        passwordMatches(PASSWORD, await shortened(length)),
        `${length} bytes`,
      ).resolves.toBe(false);
    }
    // And at the length we actually write, the same construction matches — so
    // what is refused above is the shortness and not the construction.
    await expect(passwordMatches(PASSWORD, await shortened(32))).resolves.toBe(true);
  });
});

describe("what an address with no account costs", () => {
  it("is derived at the cost the stored rows are written at", async () => {
    // The deterministic half, and the one that actually holds ADR-0009 §2. The
    // decoy is derived at whatever cost this file's constant says, and so is a
    // password set today; the rows already in a database are not. Written the
    // obvious way — build a row with `hashPassword`, time it against the decoy
    // — the two move together and the comparison says nothing about the risk
    // it names: raising the constant leaves such a test green while an address
    // with an old row answers in a third of the time an unknown one does.
    //
    // So what is pinned is the cost itself, against a number this test names.
    // Raising it is then a change that fails here until somebody also re-derives
    // the rows, which is exactly the ritual that decision asks for.
    const [algorithm, work, block, parallel] = (await hashPassword(PASSWORD)).split("$");

    expect(algorithm).toBe("scrypt");
    expect([Number(work), Number(block), Number(parallel)]).toStrictEqual([
      ROWS_ARE_AT.N,
      ROWS_ARE_AT.r,
      ROWS_ARE_AT.p,
    ]);
  });

  it("costs what a wrong password against a row in the database costs", async () => {
    // Not merely "some work" — the same work. One request, and two answers that
    // take visibly different times is a sign-in form that says which addresses
    // have accounts.
    //
    // The row here is built at the cost above rather than by `hashPassword`, so
    // that what is being compared is the decoy against a row as a database
    // holds it and not the constant against itself. The bounds are generous
    // because a clock in a test suite is: what they catch is gross drift, and
    // the test above is what catches drift of any size at all.
    const stored = await storedAt(PASSWORD, ROWS_ARE_AT);
    await passwordMatches(PASSWORD, stored); // warm the pool before either clock

    const timed = async (against: string | null): Promise<number> => {
      const started = performance.now();
      await passwordMatches("whatever-was-typed", against);
      return performance.now() - started;
    };

    const known = Math.min(await timed(stored), await timed(stored));
    const unknown = Math.min(await timed(null), await timed(null));

    expect(unknown / known).toBeGreaterThan(0.4);
    expect(unknown / known).toBeLessThan(2.5);
  });
});

describe("a password we generate", () => {
  it("is long, and is different every time", () => {
    const first = newPassword();
    const second = newPassword();

    expect(first.length).toBeGreaterThanOrEqual(MINIMUM_PASSWORD_LENGTH);
    expect(first).not.toBe(second);
    // The exact length, not a floor. ADR-0009 leaves the sign-in form without a
    // rate limit on purpose — a lockout would hand anybody who knows an address
    // a way to shut the merchant out of the control that stops their selling —
    // and what stands in the way instead is this number. Twenty-four characters
    // out of an alphabet of thirty-two is a hundred and twenty bits; a floor of
    // twenty would have let the code shrink to a hundred without a word.
    expect(first.length).toBe(24);
    expect(second.length).toBe(24);
  });

  it("is made of characters a person can read out over a telephone", () => {
    // It is handed over by whoever runs the command that makes the account, and
    // it gets read aloud or copied by hand at least once. A character that can be
    // confused for another is a support conversation.
    // One password per round, held to both rules. Written as two calls it read
    // as one check of two things and was two checks of two different passwords,
    // which is half the coverage for twice the work.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const password = newPassword();
      expect(password, password).toMatch(/^[a-z2-9]+$/);
      expect(password, password).not.toMatch(/[lo]/);
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
