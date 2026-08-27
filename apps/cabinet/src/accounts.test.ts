/**
 * The account store the cabinet's own tests run on.
 *
 * It keeps the same promises the Postgres one does, and the file next door
 * (`accounts.db-test.ts`) runs this same suite against a real database to say
 * so. What is checked lives in `testing/accounts-contract.ts`, written once
 * rather than twice, because two copies of a conformance suite are two suites
 * that drift.
 */

import { memoryAccounts } from "./accounts.js";
import { describeAccounts } from "./testing/accounts-contract.js";

describeAccounts("the account store in memory", async () => memoryAccounts());
