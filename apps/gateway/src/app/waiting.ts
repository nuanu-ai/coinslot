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

/** One caller parked under a key, with the timer that gives up on it. */
interface Waiter<T> {
  readonly resolve: (value: T | null) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class Waiting<T> {
  readonly #parked = new Map<string, Set<Waiter<T>>>();

  /**
   * Parks under `key` until somebody answers or `waitMs` runs out, and answers
   * with nothing when the wait runs out.
   *
   * More than one caller may park under one key at once, and an answer wakes
   * every one of them. That matters for the same buyer's own two concurrent
   * calls — a retry that raced the first request — which park on one key
   * because they carry one owner: both are woken with the goods, and neither is
   * told nothing happened while the other collected. Two different buyers
   * racing one order carry two owners and park on two keys, so neither can wake
   * the other's.
   */
  wait(key: string, waitMs: number): Promise<T | null> {
    return new Promise<T | null>((resolve) => {
      const set = this.#parked.get(key) ?? new Set<Waiter<T>>();
      this.#parked.set(key, set);

      const waiter: Waiter<T> = {
        resolve,
        timer: setTimeout(
          () => {
            set.delete(waiter);
            if (set.size === 0) {
              this.#parked.delete(key);
            }
            resolve(null);
          },
          Math.max(waitMs, 0),
        ),
      };
      set.add(waiter);
    });
  }

  /**
   * Answers everybody parked under `key`, and says whether anybody was.
   *
   * That answer is not bookkeeping: a merchant who set stock aside against a
   * price question needs to know whether his answer arrived in time to price
   * the purchase, so that he can release what he held if it did not.
   */
  answer(key: string, value: T): boolean {
    return this.#wakeAll(key, value);
  }

  /** Nobody is going to answer these; wake them with nothing. */
  giveUp(key: string): void {
    this.#wakeAll(key, null);
  }

  /** Wakes everybody with nothing. Used when the gateway is shutting down. */
  giveUpAll(): void {
    for (const key of [...this.#parked.keys()]) {
      this.#wakeAll(key, null);
    }
  }

  #wakeAll(key: string, value: T | null): boolean {
    const set = this.#parked.get(key);
    if (set === undefined || set.size === 0) {
      return false;
    }
    this.#parked.delete(key);
    for (const waiter of set) {
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    }
    return true;
  }
}

/**
 * The name a purchase is parked under: the order, and its owner.
 *
 * Two people holding one order identifier are not two people waiting on one
 * purchase. Parked under the order's own name, the second to arrive would take
 * the first one's place — and in the synchronous mode the goods reach an agent
 * through that park and nowhere else, so the one who paid would be told nothing
 * happened while the other collected. The owner is who the payment layer says
 * paid, so two different buyers get two different keys, and the same buyer's
 * two calls share one.
 */
export function purchaseOf(orderId: string, owner: string): string {
  return `${orderId}#${owner}`;
}
