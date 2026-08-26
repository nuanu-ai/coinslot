/**
 * Callers parked waiting for something that has to come from somewhere else.
 *
 * Two waits in this gateway are the whole reason it is a resident process
 * rather than a function that runs and exits. An agent buying a synchronous
 * product sits on the HTTP request until the merchant's handler answers, and
 * the purchase of a product with a live price sits on the request until the
 * merchant says what it costs. Both are parked here and both are woken by
 * something arriving on a different connection entirely.
 *
 * One thing this does not do is survive a restart, and that is worth saying
 * rather than discovering. A parked caller lives in this process's memory, so
 * a second gateway process would park the purchase on one and receive the
 * merchant's answer on the other, and the answer would find nobody waiting.
 * Stage one of the pilot plan is one resident process, so today that cannot
 * happen; the day there are two, this is the thing that has to move into the
 * queue.
 *
 * Waking with nothing is an ordinary answer and not a failure — it is how a
 * silence reaches the flow that has to decide what a silence means.
 */

export class Waiting<T> {
  readonly #parked = new Map<string, (value: T | null) => void>();

  /**
   * Parks under `key` until somebody answers or `waitMs` runs out, and answers
   * with nothing when the wait runs out.
   *
   * A second wait on the same key replaces the first, which is woken with
   * nothing rather than left parked forever.
   */
  wait(key: string, waitMs: number): Promise<T | null> {
    this.#parked.get(key)?.(null);

    return new Promise<T | null>((resolve) => {
      const timer = setTimeout(
        () => {
          this.#parked.delete(key);
          resolve(null);
        },
        Math.max(waitMs, 0),
      );

      this.#parked.set(key, (value) => {
        clearTimeout(timer);
        this.#parked.delete(key);
        resolve(value);
      });
    });
  }

  /**
   * Answers whoever is parked under `key`, and says whether anybody was.
   *
   * That answer is not bookkeeping: a merchant who set stock aside against a
   * price question needs to know whether his answer arrived in time to price
   * the purchase, so that he can release what he held if it did not.
   */
  answer(key: string, value: T): boolean {
    const parked = this.#parked.get(key);
    if (parked === undefined) {
      return false;
    }
    parked(value);
    return true;
  }

  /** Nobody is going to answer this one; wake it with nothing. */
  giveUp(key: string): void {
    this.#parked.get(key)?.(null);
  }

  /** Wakes everybody with nothing. Used when the gateway is shutting down. */
  giveUpAll(): void {
    for (const parked of [...this.#parked.values()]) {
      parked(null);
    }
  }
}
