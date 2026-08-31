/**
 * The stand's append-only record of what crossed the wire in front of it.
 *
 * It is not the gateway's journal: the SDK unwraps envelopes before handing
 * their contents here, and gateway state-machine transitions and effect order
 * remain on the other side of the stand.
 */

export interface Entry {
  readonly id: number;
  readonly at: string;
  readonly kind: string;
  readonly title: string;
  readonly detail: unknown;
}

export interface Feed {
  write(kind: string, title: string, detail?: unknown): void;
  entries(): readonly Entry[];
  listen(to: (entry: Entry) => void): () => void;
}

/** Makes the stand's in-memory record for one run. */
export const makeFeed = (now: () => number = Date.now): Feed => {
  const entries: Entry[] = [];
  const listeners = new Set<(entry: Entry) => void>();

  return {
    write(kind, title, detail) {
      const entry: Entry = {
        id: entries.length + 1,
        at: new Date(now()).toISOString(),
        kind,
        title,
        detail,
      };
      entries.push(entry);
      for (const listener of listeners) {
        listener(entry);
      }
    },
    entries: () => entries,
    listen(to) {
      listeners.add(to);
      return () => listeners.delete(to);
    },
  };
};
