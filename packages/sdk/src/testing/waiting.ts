/**
 * Waiting for something the worker did, without waiting for a fixed time.
 *
 * The loop runs on its own turns: a poll comes back, a handler runs, an answer
 * is posted, and none of that is something a test can await directly. A fixed
 * `setTimeout` in its place is the worst of both — long enough to slow every
 * run on a fast machine, short enough to fail on a loaded one — so this asks
 * the question every millisecond instead and gives up eventually.
 *
 * Three copies of it lived in three test files and one of them gave up a second
 * earlier than the others, which is a difference nobody chose. The cap here is
 * the longest of the three: it is only ever reached by a test that is failing,
 * and a failing test is allowed the extra second if it buys a clearer message.
 *
 * The message is why this takes `what` rather than being a bare predicate. A
 * timeout that says only "waited and it never happened" sends whoever reads it
 * back into the test to work out what was being waited for.
 */

/** How long the wait goes on before it is a failure, in millisecond attempts. */
const ATTEMPTS = 3_000;

export const waitUntil = async (ready: () => boolean, what: string): Promise<void> => {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`waited for ${what} and it never happened`);
};
