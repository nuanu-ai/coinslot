-- The orders verified before the address they were verified against was kept.
--
-- An order's document carries `payTo`: the address the buyer's authorisation
-- names, written when the payment is verified and read again at the charge, so
-- that a merchant who moves their wallet between the two is paid at the new one
-- on their next sale rather than on this one (ADR-0019). Every order verified
-- before that field existed has no such key, and it reads back as nothing.
--
-- Nothing about that is visible until the charge. On a deployment that settles
-- for real the address is then missing where one is required, and the refusal
-- says the merchant has set no wallet — which is not true of a merchant who has
-- one, and which arrives out of the effects loop as a five hundred inside the
-- merchant's own delivery call, after the goods have gone out.
--
-- So the repair is in the rows rather than in a branch in the reading code: the
-- window is a fixed set of orders that closes on its own, and a permanent
-- `?? the merchant's wallet` would go on quietly rewriting the address a payer
-- signed for long after the last of them is settled.
--
-- Written to touch as little as it can, and each clause is one of the rows it
-- must leave alone. Only orders still open: a closed one's charge is over, and
-- an address rewritten there would make the record disagree with the chain.
-- Only orders that carry a payment: without one nothing has been verified, and
-- the address arrives with the verification and not before, so writing one now
-- would claim a wallet had been checked when none had. Only where the key is
-- absent rather than where it is null: null is what the running gateway writes
-- for a sandbox that settles against nothing, and an order that carries an
-- address carries the one its payer actually signed for. And only where the
-- merchant has a wallet: for the rest there is no address to give and the
-- gateway will not stand the operator's own in for theirs, so the sentence
-- their charge is refused with is the true one.
UPDATE "orders"
SET "record" = jsonb_set("orders"."record", '{payTo}', to_jsonb("merchants"."payout_wallet"))
FROM "merchants"
WHERE "orders"."merchant_id" = "merchants"."id"
  AND "orders"."open"
  AND NOT ("orders"."record" ? 'payTo')
  AND "orders"."record" ->> 'payment' IS NOT NULL
  AND "merchants"."payout_wallet" IS NOT NULL;
