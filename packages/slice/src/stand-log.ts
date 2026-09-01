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

export interface Entry {
  readonly id: number;
  readonly at: string;
  readonly kind: string;
  readonly title: string;
  readonly detail: unknown;
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
  write(kind: string, title: string, detail?: unknown): void;
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

  return {
    write(kind, title, detail) {
      const entry: Entry = {
        id: entries.length + 1,
        at: new Date(now()).toISOString(),
        kind,
        title,
        detail,
        order,
      };
      entries.push(entry);
      if (order === null) sinceMark.push(entry);
      for (const listener of listeners) {
        listener(entry);
      }
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
