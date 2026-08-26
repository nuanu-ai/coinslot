#!/usr/bin/env node
/**
 * The command behind `npx coinslot`.
 *
 * It is glue and nothing else: the work is in `verify.ts`, which answers with
 * a number and a stream of lines, so that everything the command does can be
 * tested without a process, a shell or a temporary directory of output.
 *
 * The package deliberately does not declare this file as its command yet, and
 * the reason is worth having in front of whoever adds the line. This workspace
 * publishes TypeScript sources with `.js` specifiers in them and has no build
 * step, and Node's own type stripping does not rewrite such a specifier — it
 * looks for the `.js` file, does not find it, and stops. So `npx coinslot
 * verify` cannot start against these sources under a plain `node`, and a `bin`
 * entry pointing here would be advertising a command that fails on a
 * merchant's machine and nowhere else. What the package does offer meanwhile
 * is `runVerify` and `checkCard`, which are the whole of the work.
 *
 * The line goes in with the build, and the build is a decision about how these
 * packages are compiled and published rather than something to settle here.
 */

import { runVerify } from "./verify.js";

process.exitCode = await runVerify(process.argv.slice(2), (line) => {
  process.stdout.write(`${line}\n`);
});
