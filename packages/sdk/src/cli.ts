#!/usr/bin/env node
/**
 * The command behind `npx coinslot`.
 *
 * It is glue and nothing else: the work is in `verify.ts`, which answers with
 * a number and a stream of lines, so that everything the command does can be
 * tested without a process, a shell or a temporary directory of output.
 *
 * One thing about it is not true yet and is better said here than discovered.
 * This workspace publishes TypeScript sources with `.js` specifiers in them
 * and has no build step, and Node's own type stripping does not rewrite such a
 * specifier — it looks for the `.js` file, does not find it, and stops. So
 * `npx coinslot verify` will not run against these sources under a plain
 * `node`; it needs either a TypeScript-aware runner or the build this package
 * does not yet have. That is a property of the whole workspace rather than of
 * this file, and fixing it is a decision about how these packages are built
 * and published, not a line to add here.
 */

import { runVerify } from "./verify.js";

process.exitCode = await runVerify(process.argv.slice(2), (line) => {
  process.stdout.write(`${line}\n`);
});
