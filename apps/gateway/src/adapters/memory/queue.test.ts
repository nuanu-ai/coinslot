import type { WorkerEnvelope } from "@coinslot/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Reminder } from "../../ports/queue.js";
import { MemoryQueue } from "./queue.js";

const envelope = (id: string): WorkerEnvelope => ({
  kind: "order_event",
  id,
  sent_at: "2026-08-26T00:00:00.000Z",
  payload: {
    type: "order.unpaid_after_confirmation",
    order_id: "ord_1",
    at: "2026-08-26T00:00:00.000Z",
  },
});

/** Whose stream. Every call names one, because there is one stream per merchant. */
const A = "mch_a";
const B = "mch_b";

const started = async (fire: (reminder: Reminder) => Promise<void> = async () => undefined) => {
  const queue = new MemoryQueue();
  queue.onReminder(fire);
  await queue.start();
  return queue;
};

describe("MemoryQueue delivery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("wakes a parked poll the moment something is published", async () => {
    // ADR-0004 §4: a worker that is connected and waiting receives a message
    // with no polling lag, because the poll is parked server-side. That is what
    // keeps the price question of a synchronous purchase — the one an agent is
    // sitting on — bounded by the network rather than by a poll interval.
    const queue = await started();
    const parked = queue.draw(A, 10, 25_000);

    await vi.advanceTimersByTimeAsync(5);
    await queue.publish(A, envelope("env_1"));

    const drawn = await parked;
    expect(drawn.map((d) => d.envelope.id)).toStrictEqual(["env_1"]);
  });

  it("answers a quiet window with an empty batch rather than a failure", async () => {
    // A worker that read an empty batch as a failure would tear down and
    // rebuild its subscription every time nothing happened.
    const queue = await started();
    const parked = queue.draw(A, 10, 1_000);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(await parked).toStrictEqual([]);
  });

  it("comes straight back with whatever is queued when no wait is asked for", async () => {
    // A worker shutting down asks for a drain, and a drain that parked for
    // twenty-five seconds would hold the shutdown open for twenty-five seconds.
    const queue = await started();
    await queue.publish(A, envelope("env_1"));

    expect((await queue.draw(A, 10, 0)).map((d) => d.envelope.id)).toStrictEqual(["env_1"]);
    expect(await queue.draw(A, 10, 0)).toStrictEqual([]);
  });

  it("hands out no more than the batch that was asked for, and keeps the rest", async () => {
    const queue = await started();
    await queue.publish(A, envelope("env_1"));
    await queue.publish(A, envelope("env_2"));
    await queue.publish(A, envelope("env_3"));

    expect((await queue.draw(A, 2, 0)).map((d) => d.envelope.id)).toStrictEqual(["env_1", "env_2"]);
    expect((await queue.draw(A, 2, 0)).map((d) => d.envelope.id)).toStrictEqual(["env_3"]);
  });

  it("keeps a delayed envelope back until its time", async () => {
    // The order machine's redelivery carries a wait, and a queue that ignored
    // it would hammer a merchant who is already failing.
    const queue = await started();
    await queue.publish(A, envelope("env_1"), 500);

    await vi.advanceTimersByTimeAsync(499);
    expect(await queue.draw(A, 10, 0)).toStrictEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect((await queue.draw(A, 10, 0)).map((d) => d.envelope.id)).toStrictEqual(["env_1"]);
  });

  it("does not put a drawn envelope back on the stream by itself", async () => {
    // Whether an unanswered delivery is repeated is the order machine's
    // decision: it is the one that knows how many attempts are left and
    // whether another could still land inside the deadline. A queue with its
    // own opinion would be a second one over the top of it.
    const queue = await started();
    await queue.publish(A, envelope("env_1"));

    expect(await queue.draw(A, 10, 0)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(600_000);
    expect(await queue.draw(A, 10, 0)).toStrictEqual([]);
  });

  it("takes a second answer to an answered delivery without complaining", async () => {
    // The portal promises the merchant that repeating a call is safe, and a
    // repeat carries the handle of a delivery that is already finished.
    const queue = await started();
    await queue.publish(A, envelope("env_1"));
    const [drawn] = await queue.draw(A, 10, 0);

    if (drawn === undefined) throw new Error("nothing was drawn");
    await queue.finish(A, drawn.handle);
    await expect(queue.finish(A, drawn.handle)).resolves.toBeUndefined();
    await expect(queue.finish(A, "a handle from nowhere")).resolves.toBeUndefined();
  });

  it("gives two deliveries of one envelope two handles", async () => {
    // Nothing here offers a drawn envelope again, but one envelope still
    // reaches a stream twice: the poll puts back the one whose hand-over it
    // could not record. A shared handle would let the answer to one of those
    // two arrivals finish the other, which nobody has answered.
    const queue = await started();
    await queue.publish(A, envelope("env_1"));
    await queue.publish(A, envelope("env_1"));

    const [first, second] = await queue.draw(A, 10, 0);
    expect(first?.handle).not.toBe(second?.handle);
  });

  it("never hands one merchant's envelope to another merchant's worker", async () => {
    // One stream per merchant, and not one stream filtered on the way out: a
    // filter would have to draw a stranger's envelope in order to look at it,
    // and a drawn envelope is one its own merchant is not offered until it is
    // finished. So the promise is two things at once — B never sees A's
    // envelope, and A still finds it afterwards.
    const queue = await started();
    await queue.publish(A, envelope("env_1"));

    expect(await queue.draw(B, 10, 0)).toStrictEqual([]);
    expect((await queue.draw(A, 10, 0)).map((d) => d.envelope.id)).toStrictEqual(["env_1"]);
  });

  it("does not send another merchant's parked worker back to an empty stream", async () => {
    // Waking every parked poll on every publish would have each of them come
    // back with nothing, over and over, on a busy gateway.
    const queue = await started();
    const parkedOnB = queue.draw(B, 10, 1_000);

    await vi.advanceTimersByTimeAsync(5);
    await queue.publish(A, envelope("env_1"));
    await vi.advanceTimersByTimeAsync(995);

    expect(await parkedOnB).toStrictEqual([]);
  });
});

describe("MemoryQueue reminders", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires a reminder once, when its time comes", async () => {
    const fired: Reminder[] = [];
    const queue = await started(async (reminder) => {
      fired.push(reminder);
    });

    const reminder: Reminder = {
      kind: "deadline",
      orderId: "ord_1",
      deadline: "quote_response",
      at: 5_000,
    };
    await queue.remind(reminder, 1_000);

    await vi.advanceTimersByTimeAsync(999);
    expect(fired).toStrictEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toStrictEqual([reminder]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fired).toHaveLength(1);
  });

  it("will not start with nowhere to put reminders", async () => {
    // A gateway whose queue swallowed every deadline would look healthy and
    // would never close an overdue order.
    const queue = new MemoryQueue();
    await expect(queue.start()).rejects.toThrow(/nowhere to put reminders/);
  });

  it("refuses to be re-pointed once it is running", async () => {
    const queue = await started();
    expect(() => queue.onReminder(async () => undefined)).toThrow(/before the queue is started/);
  });

  it("drops the reminders it has not fired when it stops", async () => {
    const fired: Reminder[] = [];
    const queue = await started(async (reminder) => {
      fired.push(reminder);
    });

    await queue.remind({ kind: "delivery_unanswered", orderId: "ord_1", handOver: "dlv_1" }, 1_000);
    await queue.stop();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(fired).toStrictEqual([]);
  });

  it("lets go of a parked poll when it stops", async () => {
    const queue = await started();
    const parked = queue.draw(A, 10, 25_000);

    await queue.stop();

    expect(await parked).toStrictEqual([]);
  });
});
