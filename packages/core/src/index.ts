/**
 * The Coinslot domain core: orders, receipts, idempotency, the state machine.
 * Here lives what actually is the product, so the package knows nothing about
 * HTTP, nothing about the database and nothing about the queue — zero IO and
 * zero runtime dependencies (ADR-0003 §2 and §9). Everything external the core
 * receives as parameters and returns as values.
 */

/**
 * The exhaustiveness guard. It goes into the default branch of a `switch` over
 * the order state: while every state is handled, TypeScript sees `never` here
 * and stays silent, and the moment a new state appears the build breaks on
 * this line instead of breaking in production on an order nobody handled.
 *
 * If the types have been fooled after all — the value came from the database
 * or over the network — the work stops with an exception that names the
 * variant itself. A silent "nothing happened" next to someone else's money is
 * inadmissible.
 */
export function assertNever(value: never, context?: string): never {
  const where = context === undefined ? "" : ` (${context})`;
  throw new Error(`Unhandled variant${where}: ${JSON.stringify(value)}`);
}
