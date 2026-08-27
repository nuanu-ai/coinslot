# 0007. The confirmation mode is built inward and closed outward

Date: 2026-08-27
Status: accepted (Dmitry, 2026-08-27: "нужно архитектурно предусмотреть, но делать пока не нужно")

## Context

Three fulfillment modes were designed together: the goods reach the agent
inside the answer to the purchase, later by a separate call, or after the
merchant is asked first and the payment follows their yes. The third is the
confirmation mode, and the pilot plan excludes it — there are no merchants in
the pilot who answer by hand.

Excluded, it was still built where building it was cheap. The state machine
implements it completely: `fromAwaitingConfirmation` and `fromConfirmed` are
real arms, the mode's deadlines are real deadlines, and twenty-seven test
references hold the behaviour. What was never built is everything the outside
world would need to reach it: the worker stream carries three kinds of
envelope and none of them is a confirmation request, so a merchant's handler
could not tell such a request from a paid order.

That leaves a capability half-built on purpose, which is an unusual enough
state to be worth writing down. Without this decision the next person to read
the machine finds states no wire path reaches and does one of two wrong
things: deletes them as dead code, losing a tested design, or completes them
quietly, putting the pilot into a mode nobody chose.

## Decision

1. **The mode stays built in the machine and closed on the wire.** Neither
   half moves without a decision: the arms are not deleted for being
   unreachable, and the wire is not opened for being nearly ready.

2. **Two doors hold it shut, and both are loud rather than silent.**
   `CardSchema` refuses to publish a card whose fulfillment is `confirm`,
   naming the reason in the refusal and in the exported description a client
   generator reads. And the two effects that belong to the mode —
   `invite_payment` and `dispatch_confirmation_request` — throw in the
   gateway's executor rather than inventing a message, because a document on a
   merchant's stream that no contract describes is worse than a stopped
   process. Reaching either means the first door failed.

3. **Every surface built from here keeps the seam mechanical.** Dispatch over
   the envelope kinds is an extensible map with an exhaustiveness guard, not a
   chain of three branches, so the compiler points at every place needing an
   arm the day a fourth kind exists. This binds the SDK's handler registration,
   the gateway's stream, and anything later that reads the kinds.

4. **What completing it touches is named now, while it is fresh**, so the work
   is an inventory rather than an investigation: a fourth kind and its payload
   schema in `packages/contracts/src/envelope.ts`; the route that carries the
   merchant's yes or no in `api.ts`; lifting the publish gate in `card.ts`,
   both the refinement and the description; executors for the two effects in
   the gateway's runner; a handler arm and its affordances in the SDK; and the
   mode's page in the portal, which today describes it in the abstract.

5. **The trigger is a merchant who answers by hand.** That is what the mode is
   for, and the pilot plan already says so. A merchant reached through a
   messaging channel rather than through code is the same trigger wearing
   different clothes — the design backlog holds that idea, and if it is taken
   up, the confirmation mode is completed with it rather than twice.

## Consequences

- Gained: the expensive half — the money-adjacent state transitions and their
  deadlines — is designed, tested and reviewed while the reasoning is fresh,
  and completing the mode later is a wiring job rather than a design job.
- Paid: a reader meets states no live path reaches, and every surface carries
  an arm for a kind that does not yet arrive. Both are the cost of the seam,
  and the alternative — discovering the design again in six months — is worse.
- The gateway will throw if a `confirm` card ever gets published by some other
  route. That is deliberate: it is a defect in the first door, and it should
  stop rather than improvise.
