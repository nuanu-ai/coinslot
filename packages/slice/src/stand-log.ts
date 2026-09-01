/**
 * The stand's append-only record of what crossed the wire in front of it.
 *
 * It is not the gateway's journal: the SDK unwraps envelopes before it calls
 * the handler, and gateway state-machine transitions and effect order remain on
 * the other side of the stand.
 *
 * Every line is stamped with the order it belongs to, and that stamp is the
 * thread the three tabs would otherwise cut: what the agent sent, what the
 * handler answered and what the gateway wrote about it are three seats' worth
 * of lines about one purchase, and grouped by the order they read as one
 * conversation. A line belonging to no order — connecting, publishing, pausing
 * — says so, which is true of it.
 */

/**
 * Which way a line went, from this console's side of the wire.
 *
 * Null is a line about the console itself — connecting, choosing, being told
 * something by its own machinery — which crossed nothing and must not be drawn
 * as though it had.
 */
export type Way = "sent" | "got" | null;

export interface Entry {
  readonly id: number;
  readonly at: string;
  readonly kind: string;
  readonly title: string;
  readonly detail: unknown;
  /** Sent by this console, received by it, or neither. */
  readonly way: Way;
  /**
   * The order this belongs to, or null where it belongs to no purchase.
   *
   * Not readonly, and that is the point: the lines that lead to an order are
   * written before it has a name — the unpaid call, the price question, the
   * challenge — and naming the order names them too. {@link Feed.about} does
   * that, so a purchase reads as one group rather than as a nameless run of
   * lines followed by the order they produced.
   */
  order: string | null;
}

export interface Feed {
  /**
   * A line about the console itself, which crossed no wire.
   *
   * The two beside it are the ones that did, and they are separate verbs rather
   * than a flag on this one so that every call site says which way it went at
   * the site — a direction worked out later from the wording is a guess, and
   * the wording is exactly what was unreadable before.
   */
  write(kind: string, title: string, detail?: unknown): void;
  /** Something this console put on the wire. */
  sent(kind: string, title: string, detail?: unknown): void;
  /** Something that came back to it, or arrived at it unasked. */
  got(kind: string, title: string, detail?: unknown): void;
  /**
   * Says which order the console is working on. Naming one also names the lines
   * written since the last time this was called, which are the lines that led
   * to it; naming none starts a fresh stretch.
   */
  about(order: string | null): void;
  entries(): readonly Entry[];
  listen(to: (entry: Entry) => void): () => void;
}

/** Makes the stand's in-memory record for one run of the process. */
export const makeFeed = (now: () => number = Date.now): Feed => {
  const entries: Entry[] = [];
  const listeners = new Set<(entry: Entry) => void>();
  let order: string | null = null;
  let sinceMark: Entry[] = [];

  const record = (kind: string, title: string, detail: unknown, way: Way): void => {
    const entry: Entry = {
      id: entries.length + 1,
      at: new Date(now()).toISOString(),
      kind,
      title,
      detail,
      order,
      way,
    };
    entries.push(entry);
    if (order === null) sinceMark.push(entry);
    for (const listener of listeners) {
      listener(entry);
    }
  };

  return {
    write(kind, title, detail) {
      record(kind, title, detail, null);
    },
    sent(kind, title, detail) {
      record(kind, title, detail, "sent");
    },
    got(kind, title, detail) {
      record(kind, title, detail, "got");
    },
    about(which) {
      if (which !== null) {
        for (const earlier of sinceMark) earlier.order = which;
      }
      sinceMark = [];
      order = which;
    },
    entries: () => entries,
    listen(to) {
      listeners.add(to);
      return () => listeners.delete(to);
    },
  };
};
