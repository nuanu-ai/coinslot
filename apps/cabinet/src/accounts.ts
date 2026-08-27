/**
 * The people who sign into the cabinet, and the sessions they are signed in
 * with.
 *
 * This is the cabinet's own data and nothing to do with a merchant's. ADR-0005
 * §3 says the cabinet holds no database connection, and ADR-0009 narrows that
 * rather than leaving the two to drift: every card, every order and every
 * receipt on every screen still comes from the public API, because the reason
 * that section gives is dogfooding — a screen the cabinet cannot draw is API
 * the merchant does not have either. Accounts and sessions are neither, and no
 * API will ever carry them.
 *
 * A session is a row rather than a signature over a cookie, and that is the
 * whole decision. A signed cookie can only be revoked by rotating the secret
 * that signs every one of them, which ends everybody's session at once — the
 * same trap the merchant key was in, wearing different clothes. A row can be
 * deleted on its own.
 *
 * There are two stores behind this interface: Postgres, which the cabinet runs
 * on, and a map, which its own tests run on. `testing/accounts-contract.ts`
 * holds the promises both of them keep, and runs against both.
 */

/** A person who can sign in. */
export interface Account {
  readonly id: string;
  /** Lower case and trimmed, which is how it is stored and how it is looked up. */
  readonly email: string;
  /** Opaque here: what is inside it is `credentials.ts`'s business. */
  readonly passwordHash: string;
  readonly createdAt: Date;
}

/** A session that has not expired, and whose it is. */
export interface LiveSession {
  /** The identifier it was asked about under, so a caller can end this one. */
  readonly fingerprint: string;
  readonly account: Account;
}

/** What the command line prints about an account, which is never its password. */
export interface AccountSummary {
  readonly email: string;
  readonly createdAt: Date;
  /** How many of that person's sessions have not expired. */
  readonly sessions: number;
}

export interface Accounts {
  /**
   * Makes an account, or answers null when that address already has one.
   *
   * Null rather than an overwrite: the command that makes accounts is run by
   * hand, and running it twice by mistake must not replace somebody's password
   * with one they have not been told.
   */
  add(email: string, passwordHash: string, at: Date): Promise<Account | null>;
  byEmail(email: string): Promise<Account | null>;
  /**
   * Sets a new password and ends every session that person had, or answers
   * false when nobody has that address.
   *
   * The two are one operation on purpose. A password is set again because the
   * old one is not trusted any more, and a session opened with it is exactly
   * the thing that must not outlive it.
   */
  setPassword(email: string, passwordHash: string): Promise<boolean>;
  list(now: Date): Promise<readonly AccountSummary[]>;
  /**
   * Opens a session, and sweeps away the ones whose time is up.
   *
   * Nothing sweeps on a timer, so this is where it happens; the answer is how
   * many expired sessions went, which is what a test can hold onto. Without it
   * the table grows for the life of the deployment.
   */
  open(fingerprint: string, accountId: string, at: Date, until: Date): Promise<number>;
  /**
   * Which of these identifiers are sessions that are still alive, and whose.
   *
   * A list and not one at a time, because that is the question the caller
   * actually has: a browser can send several cookies of one name, and the
   * cabinet cannot decide who is asking until it knows about all of them. Asked
   * one at a time, a request carrying as many cookies as the runtime will read
   * turns one page view into that many round trips; asked together it is one
   * question whatever arrives. It is also one moment: a session ended between
   * two of those round trips would make the answer depend on which half of the
   * request it fell in.
   *
   * An identifier nothing was opened under, one that was ended and one whose
   * time is up are all simply absent from the answer, and the three are not
   * distinguished. Each identifier is answered at most once however many times
   * it was given, and the order is not promised.
   */
  whose(fingerprints: readonly string[], now: Date): Promise<readonly LiveSession[]>;
  /** Ends one session. Ending one that is not there is not an error. */
  end(fingerprint: string): Promise<void>;
  /** Ends every session one person has, and answers how many that was. */
  endEveryFor(email: string): Promise<number>;
  close(): Promise<void>;
}

/**
 * One address, however it was typed.
 *
 * Applied inside the stores rather than above them, so that no caller can be
 * the one that forgets. A person who signs in as "Dmitry@Example.com " is the
 * person whose account was made as "dmitry@example.com", and a store that
 * thought otherwise would quietly let one person have two accounts.
 */
export const emailAs = (raw: string): string => raw.trim().toLowerCase();

/** The account store the cabinet's own tests run on. */
export function memoryAccounts(): Accounts {
  const byId = new Map<string, Account>();
  const byAddress = new Map<string, string>();
  const sessions = new Map<string, { accountId: string; expiresAt: Date }>();
  let handedOut = 0;

  const endEvery = (accountId: string): number => {
    let ended = 0;
    for (const [fingerprint, session] of sessions) {
      if (session.accountId === accountId) {
        sessions.delete(fingerprint);
        ended += 1;
      }
    }
    return ended;
  };

  return {
    async add(email, passwordHash, at) {
      const address = emailAs(email);
      if (byAddress.has(address)) {
        return null;
      }
      handedOut += 1;
      const account: Account = {
        id: `acc_${handedOut}`,
        email: address,
        passwordHash,
        createdAt: new Date(at),
      };
      byId.set(account.id, account);
      byAddress.set(address, account.id);
      return account;
    },

    async byEmail(email) {
      const id = byAddress.get(emailAs(email));
      return id === undefined ? null : (byId.get(id) ?? null);
    },

    async setPassword(email, passwordHash) {
      const id = byAddress.get(emailAs(email));
      const account = id === undefined ? undefined : byId.get(id);
      if (account === undefined) {
        return false;
      }
      byId.set(account.id, { ...account, passwordHash });
      endEvery(account.id);
      return true;
    },

    async list(now) {
      return [...byId.values()]
        .map((account) => ({
          email: account.email,
          createdAt: account.createdAt,
          sessions: [...sessions.values()].filter(
            (session) => session.accountId === account.id && session.expiresAt > now,
          ).length,
        }))
        .sort((one, other) => one.email.localeCompare(other.email));
    },

    async open(fingerprint, accountId, at, until) {
      let swept = 0;
      for (const [held, session] of sessions) {
        if (session.expiresAt <= at) {
          sessions.delete(held);
          swept += 1;
        }
      }
      // Both of these are what the database refuses, and they are here so that
      // the two stores refuse the same things rather than one of them being
      // quietly more forgiving in the suite everybody develops against.
      if (!byId.has(accountId)) {
        throw new Error(`there is no account ${accountId} to open a session for`);
      }
      if (sessions.has(fingerprint)) {
        // Thirty-two random bytes twice. Improvising over it — by handing an
        // identifier somebody is already holding to a different person — is
        // worse than stopping.
        throw new Error("a session is already open under that identifier");
      }
      sessions.set(fingerprint, { accountId, expiresAt: new Date(until) });
      return swept;
    },

    async whose(fingerprints, now) {
      const live: LiveSession[] = [];
      // Over a set, because the database answers one row per identifier however
      // many times it was named and a store that answered twice would let a
      // caller count one session as two.
      for (const fingerprint of new Set(fingerprints)) {
        const session = sessions.get(fingerprint);
        if (session === undefined || session.expiresAt <= now) {
          continue;
        }
        // A session always has an account behind it: `open` refuses an
        // identifier for an account that is not here, and nothing removes an
        // account at all. This is the map's type being narrowed rather than a
        // case, which is why no test reaches the other side of it — in the
        // database the same thing is a foreign key that cascades.
        const account = byId.get(session.accountId);
        if (account !== undefined) {
          live.push({ fingerprint, account });
        }
      }
      return live;
    },

    async end(fingerprint) {
      sessions.delete(fingerprint);
    },

    async endEveryFor(email) {
      const id = byAddress.get(emailAs(email));
      return id === undefined ? 0 : endEvery(id);
    },

    async close() {
      // Nothing to let go of.
    },
  };
}
