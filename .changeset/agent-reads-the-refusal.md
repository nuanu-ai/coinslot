---
"@nuanu-ai/coinslot-contracts": minor
"@nuanu-ai/coinslot": patch
---

Carry a merchant's refusal to the agent. The status document an agent reads
back for its own purchase grows an optional `refusal`, holding the two words
the merchant's handler actually answered with — the short code it branches on
and the sentence it can show a person — in the same shape the handler sends
them in. It is present wherever a merchant's refusal is what closed the order,
whichever word the order ended under, and absent everywhere else: an ending
nobody worded arrives with no pair rather than with an invented one.

`CONTRACT_VERSION` does not move. It is the handshake between a merchant's
installed SDK and the gateway, and no SDK reads this document — it travels only
on the agent's storefront, which carries no version by ADR-0006 §5. Nothing in
the SDK's own surface changes; its bump is the dependency's.
