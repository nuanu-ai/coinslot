import { describe, expect, it } from "vitest";
import {
  DisabledKeySchema,
  IssuedKeySchema,
  IssueKeyRequestSchema,
  MerchantKeyListSchema,
  MerchantKeySchema,
  PayoutWalletRequestSchema,
  PayoutWalletSchema,
  RegisteredMerchantSchema,
  RegistrationRequestSchema,
  SellerNameRequestSchema,
  SellerNameSchema,
} from "./merchant.js";
import { errorOf, expectMissingFieldRejected } from "./testing/expect-schema.js";

const working = {
  id: "mk_4d21bb",
  label: "the shop's own worker",
  created_at: "2026-08-26T09:00:00Z",
  disabled_at: null,
};

const revoked = { ...working, id: "mk_9f2c4a", disabled_at: "2026-08-27T10:20:00Z" };

const secret = "csk_9tGqk3xLm2QvR8bN4pZs7YwF1cJd6HeA";

describe("one of a merchant's keys", () => {
  // The promise: a merchant can see the keys they hold, tell one from another,
  // and tell which of them still opens the door. Everything below is a way that
  // stops being true.

  it("accepts a key that still opens the door", () => {
    expect(MerchantKeySchema.parse(working)).toStrictEqual(working);
  });

  it("accepts a revoked key and says when it stopped", () => {
    // Revoked keys stay in the list. A merchant working out what happened after
    // an incident asks when a key stopped, and a list that dropped it answers
    // nothing at all.
    expect(MerchantKeySchema.parse(revoked)).toStrictEqual(revoked);
  });

  for (const field of ["id", "label", "created_at", "disabled_at"]) {
    it(`refuses a key without ${field} and names it`, () => {
      expectMissingFieldRejected(MerchantKeySchema, working, field);
    });
  }

  it("says a key works rather than leaving the field out", () => {
    // Null is the fact "this key has not been revoked". An absent field is a
    // silence, and a screen cannot tell a silence from an oversight — it would
    // have to guess, and guessing wrong means showing a revoked key as live.
    const { disabled_at, ...withoutIt } = working;

    expect(disabled_at).toBeNull();
    expect(MerchantKeySchema.safeParse(withoutIt).success).toBe(false);
    expect(MerchantKeySchema.parse(working).disabled_at).toBeNull();
  });

  it("refuses a label nobody could tell from another", () => {
    // A blank label is a row in a list of keys with nothing in it, and a padded
    // one is two labels that look identical wherever they are printed. Both
    // defeat the only thing a label is for.
    expect(MerchantKeySchema.safeParse({ ...working, label: "" }).success).toBe(false);
    expect(MerchantKeySchema.safeParse({ ...working, label: "   " }).success).toBe(false);
    expect(MerchantKeySchema.safeParse({ ...working, label: "the worker " }).success).toBe(false);
    expect(errorOf(MerchantKeySchema, { ...working, label: "" })).toContain("label");
  });

  it("takes a label in whatever alphabet its owner writes in", () => {
    // Unlike the name a discovery catalog lists a seller under, a label never
    // leaves the merchant's own screens, so nothing about it is held to ASCII.
    expect(MerchantKeySchema.safeParse({ ...working, label: "рабочий магазина" }).success).toBe(
      true,
    );
  });

  it("refuses an instant that names no moment in time", () => {
    // A local time with no offset is an hour of the day rather than a moment,
    // and "when did this key stop" cannot be answered by one.
    expect(MerchantKeySchema.safeParse({ ...working, created_at: "2026-08-26" }).success).toBe(
      false,
    );
    expect(
      MerchantKeySchema.safeParse({ ...working, disabled_at: "2026-08-27T10:20:00" }).success,
    ).toBe(false);
  });

  it("carries no secret, whatever is put beside it", () => {
    // This document is what a screen lists, and the secret is shown once by the
    // one call that made it. A key document that could carry a secret is a key
    // document that eventually does, on a page that is drawn again and again.
    expect(errorOf(MerchantKeySchema, { ...working, secret })).toContain("secret");
    expect(errorOf(MerchantKeySchema, { ...working, digest: "9f2c4a" })).toContain("digest");
  });
});

describe("the keys a merchant holds", () => {
  const list = { keys: [working, revoked], this_call: working.id };

  it("accepts a merchant's keys, working and revoked together", () => {
    expect(MerchantKeyListSchema.parse(list)).toStrictEqual(list);
  });

  it("names the key this very call was made with", () => {
    // The one fact the list cannot be assembled without. A merchant cannot
    // disable the key their own cabinet is holding, so a screen that did not
    // know which key that was would offer a button the route refuses.
    // Its absence is covered by the loop below, with every other required
    // field; what is here is that it survives a parse and that a blank one is
    // refused, because an empty identifier names no key and a screen reading it
    // would match none of the rows beside it.
    expect(MerchantKeyListSchema.parse(list).this_call).toBe(working.id);
    expect(MerchantKeyListSchema.safeParse({ ...list, this_call: "" }).success).toBe(false);
  });

  for (const field of ["keys", "this_call"]) {
    it(`refuses the list without ${field} and names it`, () => {
      expectMissingFieldRejected(MerchantKeyListSchema, list, field);
    });
  }

  it("is an object rather than a bare array", () => {
    // A bare array has nowhere to put the key the call was made with, and could
    // never grow one without breaking every reader that already parses it.
    expect(MerchantKeyListSchema.safeParse([working]).success).toBe(false);
  });

  it("holds every key in the list to the key document", () => {
    expect(
      MerchantKeyListSchema.safeParse({ keys: [{ id: working.id }], this_call: working.id })
        .success,
    ).toBe(false);
  });

  it("refuses a field it does not know", () => {
    expect(errorOf(MerchantKeyListSchema, { ...list, merchant_id: "mch_1" })).toContain(
      "merchant_id",
    );
  });
});

describe("asking for a key", () => {
  it("takes the name its owner will know it by", () => {
    expect(IssueKeyRequestSchema.parse({ label: "the shop's own worker" })).toStrictEqual({
      label: "the shop's own worker",
    });
  });

  it("refuses a request with no label and names it", () => {
    expectMissingFieldRejected(IssueKeyRequestSchema, { label: "a worker" }, "label");
  });

  it("refuses a label that names nothing", () => {
    expect(IssueKeyRequestSchema.safeParse({ label: "" }).success).toBe(false);
    expect(IssueKeyRequestSchema.safeParse({ label: " " }).success).toBe(false);
  });

  it("refuses a secret somebody chose for themselves", () => {
    // A key is generated and never taken from a caller: one somebody picks is
    // one somebody reuses. There is nowhere in this request to put one.
    expect(errorOf(IssueKeyRequestSchema, { label: "a worker", secret })).toContain("secret");
  });
});

describe("a key just issued", () => {
  const issued = { key: working, secret };

  it("hands the secret over beside the row it belongs to", () => {
    // The only moment the secret is readable. Without the row beside it the
    // merchant has a string and no way to say which of their keys it is.
    expect(IssuedKeySchema.parse(issued)).toStrictEqual(issued);
  });

  for (const field of ["key", "secret"]) {
    it(`refuses an issued key without ${field} and names it`, () => {
      expectMissingFieldRejected(IssuedKeySchema, issued, field);
    });
  }

  it("refuses a secret that could not travel as a key", () => {
    // A key is presented as a bearer token, which carries no whitespace: a
    // secret with a space in it is one the door would read as something else,
    // or not read at all, and the merchant would spend an afternoon on it.
    expect(IssuedKeySchema.safeParse({ key: working, secret: "" }).success).toBe(false);
    expect(IssuedKeySchema.safeParse({ key: working, secret: "csk_ two halves" }).success).toBe(
      false,
    );
    expect(IssuedKeySchema.safeParse({ key: working, secret: " csk_padded" }).success).toBe(false);
  });

  it("holds the row to the key document", () => {
    expect(IssuedKeySchema.safeParse({ key: { id: working.id }, secret }).success).toBe(false);
  });
});

describe("a key that has been disabled", () => {
  const answered = { key: revoked };

  it("answers with the key as it now stands", () => {
    // The instant it stopped is the whole answer: a merchant who pressed the
    // button reads it back rather than taking our word that something happened.
    expect(DisabledKeySchema.parse(answered)).toStrictEqual(answered);
    expect(DisabledKeySchema.parse(answered).key.disabled_at).toBe(revoked.disabled_at);
  });

  it("refuses an answer with no key in it and names it", () => {
    expectMissingFieldRejected(DisabledKeySchema, answered, "key");
  });

  it("is an object rather than the bare key", () => {
    // Same reason every list here is: the day this answer has to say anything
    // beside the key — how many keys still work, say — a bare document would
    // have to change shape under every reader.
    expect(DisabledKeySchema.safeParse(revoked).success).toBe(false);
  });
});

describe("registering a merchant", () => {
  const asked = { invitation: "the-code-from-the-invitation" };

  it("takes the code they were given and nothing else", () => {
    expect(RegistrationRequestSchema.parse(asked)).toStrictEqual(asked);
  });

  it("refuses a registration without invitation and names it", () => {
    expectMissingFieldRejected(RegistrationRequestSchema, asked, "invitation");
  });

  it("does not ask for the name buyers will read", () => {
    // The name is asked for on the screen after this one, where there is room
    // to say what it is for and where it can be changed afterwards. Asked here,
    // it was answered by somebody with no products, no catalogue seen and no
    // idea what the name was for, and what they typed was then printed beside
    // their products. Refusing the field is what stops a client sending one and
    // believing it was written down.
    expect(errorOf(RegistrationRequestSchema, { ...asked, name: "Someone's shop" })).toContain(
      "name",
    );
  });

  it("refuses a form submitted with nothing in the invitation", () => {
    expect(RegistrationRequestSchema.safeParse({ ...asked, invitation: "" }).success).toBe(false);
    expect(RegistrationRequestSchema.safeParse({ ...asked, invitation: "  " }).success).toBe(false);
  });

  it("carries nothing that belongs to the account rather than the merchant", () => {
    // The address and the password are the cabinet's, and they stay there. A
    // gateway that took either would be holding a person's credentials on the
    // money path, which is the thing this route's whole shape avoids.
    expect(
      errorOf(RegistrationRequestSchema, { ...asked, email: "someone@example.com" }),
    ).toContain("email");
    expect(errorOf(RegistrationRequestSchema, { ...asked, password: "hunter2" })).toContain(
      "password",
    );
  });
});

describe("what registering answers with", () => {
  const registered = {
    merchant_id: "mch_4d21bb",
    key: working,
    secret,
  };

  it("carries the merchant, their first key, and the secret once", () => {
    // All three are needed by the one caller: it writes the merchant and the
    // secret onto the account it is creating, and shows the key's own row so
    // the person can see what they now hold.
    expect(RegisteredMerchantSchema.parse(registered)).toStrictEqual(registered);
  });

  for (const field of ["merchant_id", "key", "secret"]) {
    it(`refuses a registration answer without ${field} and names it`, () => {
      expectMissingFieldRejected(RegisteredMerchantSchema, registered, field);
    });
  }

  it("names no seller, because registering chooses none", () => {
    // A merchant who has just registered is listed under nothing at all, so
    // there is no name here to read back. A field carrying one would be a name
    // this call had written down, and the screen after it would show the
    // merchant something nobody chose.
    expect(errorOf(RegisteredMerchantSchema, { ...registered, name: "Someone's shop" })).toContain(
      "name",
    );
  });

  it("names the merchant the account will be tied to", () => {
    // Without it the cabinet has a key and nothing to say whose it is, and an
    // account that names no merchant is the single-tenant cabinet again.
    expect(RegisteredMerchantSchema.parse(registered).merchant_id).toBe("mch_4d21bb");
    expect(RegisteredMerchantSchema.safeParse({ ...registered, merchant_id: "" }).success).toBe(
      false,
    );
  });

  it("holds the key to the key document", () => {
    expect(RegisteredMerchantSchema.safeParse({ ...registered, key: { id: "mk_1" } }).success).toBe(
      false,
    );
  });

  it("refuses a field it does not know", () => {
    expect(errorOf(RegisteredMerchantSchema, { ...registered, session: "sess_1" })).toContain(
      "session",
    );
  });
});

describe("the name buyers read beside a merchant's products", () => {
  // The promise: a merchant can find out what they are listed under and change
  // it. What they cannot do is have none once they have one, and the two
  // documents differ in exactly that.
  const named = { seller_name: "Someone's shop" };
  const unnamed = { seller_name: null };

  it("carries the name a merchant chose", () => {
    expect(SellerNameSchema.parse(named)).toStrictEqual(named);
  });

  it("says a merchant has no name rather than leaving the field out", () => {
    // Null is the fact "nobody has chosen one", which is every merchant on the
    // day they register. An absent field is a silence, and the screen that
    // reads it cannot tell a silence from a field somebody forgot to send: it
    // would have to guess, and guessing wrong means a settings page that says
    // a merchant is listed under nothing when they are listed under something.
    expect(SellerNameSchema.parse(unnamed)).toStrictEqual(unnamed);
    expect(SellerNameSchema.safeParse({}).success).toBe(false);
  });

  it("refuses a document without seller_name and names it", () => {
    expectMissingFieldRejected(SellerNameSchema, named, "seller_name");
  });

  it("holds the name to the rule of the catalogue that will carry it", () => {
    // The same rule the catalogue applies before it drops what it cannot
    // render. Refused here, a merchant is told what is wrong with the name they
    // typed; accepted here, they trade under a mangled version of it and
    // nothing anywhere says so.
    expect(SellerNameSchema.safeParse({ seller_name: "" }).success).toBe(false);
    expect(SellerNameSchema.safeParse({ seller_name: "x".repeat(33) }).success).toBe(false);
    expect(SellerNameSchema.safeParse({ seller_name: "Магазин" }).success).toBe(false);
    expect(SellerNameSchema.safeParse({ seller_name: " padded " }).success).toBe(false);
    expect(SellerNameSchema.safeParse({ seller_name: "x".repeat(32) }).success).toBe(true);
  });

  it("refuses a field it does not know", () => {
    expect(errorOf(SellerNameSchema, { ...named, merchant_id: "mch_4d21bb" })).toContain(
      "merchant_id",
    );
  });
});

describe("what a merchant sends to change that name", () => {
  const asked = { seller_name: "Someone's shop" };

  it("takes the name, held to the same rule the answer is", () => {
    expect(SellerNameRequestSchema.parse(asked)).toStrictEqual(asked);
    expect(SellerNameRequestSchema.safeParse({ seller_name: "x".repeat(33) }).success).toBe(false);
    expect(SellerNameRequestSchema.safeParse({ seller_name: "Магазин" }).success).toBe(false);
    expect(SellerNameRequestSchema.safeParse({ seller_name: " padded " }).success).toBe(false);
    expect(SellerNameRequestSchema.safeParse({ seller_name: "" }).success).toBe(false);
  });

  it("refuses null, because a name cannot be taken away", () => {
    // The difference between this document and the answer, and the whole of it.
    // Having no name is a state a merchant starts in and cannot go back to:
    // their cards would stay on sale while the payment request an agent reads
    // named no seller. A merchant who wants a different name sets a different
    // name, and one who wants to stop selling pauses selling, which leaves
    // their cards where they can find them again.
    expect(SellerNameRequestSchema.safeParse({ seller_name: null }).success).toBe(false);
  });

  it("says what to do instead, rather than that a string was expected", () => {
    // The reader here is whoever wrote the client, and "expected string,
    // received null" tells them the shape and not the reason. Somebody who
    // wanted a merchant to stop being listed has an act that does that, and
    // this is where they find out which.
    const complaint = errorOf(SellerNameRequestSchema, { seller_name: null });

    expect(complaint).toContain("pause");
    expect(complaint).not.toContain("expected string");
  });

  it("refuses a document without seller_name and names it", () => {
    expectMissingFieldRejected(SellerNameRequestSchema, asked, "seller_name");
  });

  it("complains about a missing field in its own words, not the ones about null", () => {
    // A client that dropped the field has a bug, and a client that sent null
    // has a misunderstanding. Told the same sentence, whoever wrote the first
    // one would go looking for a decision nobody made.
    expect(errorOf(SellerNameRequestSchema, {})).not.toContain("pause");
  });

  it("refuses a field it does not know", () => {
    expect(errorOf(SellerNameRequestSchema, { ...asked, merchant_id: "mch_4d21bb" })).toContain(
      "merchant_id",
    );
  });
});

describe("the wallet a merchant's sales are paid into", () => {
  // The promise: a merchant can find out where their money goes and change it,
  // and what they read back is what a buyer's agent will actually be told to
  // pay. Nothing else in this contract carries an address, because nothing else
  // is money leaving somebody's hands.
  const paid = { payout_wallet: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed" };
  const unpaid = { payout_wallet: null };

  it("carries the wallet a merchant chose", () => {
    expect(PayoutWalletSchema.parse(paid)).toStrictEqual(paid);
  });

  it("says a merchant has none rather than leaving the field out", () => {
    // Null is the fact "nobody has said where the money goes", which is every
    // merchant on the day they register. An absent field is a silence, and a
    // settings screen cannot tell a silence from a client that dropped the
    // field — it would have to guess, and guessing wrong means telling a
    // merchant they are set up to be paid when they are not.
    expect(PayoutWalletSchema.parse(unpaid)).toStrictEqual(unpaid);
    expect(PayoutWalletSchema.safeParse({}).success).toBe(false);
  });

  it("refuses a document without payout_wallet and names it", () => {
    expectMissingFieldRejected(PayoutWalletSchema, paid, "payout_wallet");
  });

  it("holds the wallet to the rule an address is written by", () => {
    expect(PayoutWalletSchema.safeParse({ payout_wallet: "" }).success).toBe(false);
    expect(PayoutWalletSchema.safeParse({ payout_wallet: "0x1234" }).success).toBe(false);
    // The checksummed spelling a wallet shows, and the same address with one
    // letter's case wrong: the first is an address, the second is a paste that
    // went through something.
    expect(
      PayoutWalletSchema.safeParse({ payout_wallet: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" })
        .success,
    ).toBe(true);
    expect(
      PayoutWalletSchema.safeParse({ payout_wallet: "0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed" })
        .success,
    ).toBe(false);
  });

  it("refuses a field it does not know", () => {
    expect(errorOf(PayoutWalletSchema, { ...paid, private_key: "0xdead" })).toContain("private_key");
  });
});

describe("what a merchant sends to change that wallet", () => {
  const asked = { payout_wallet: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed" };

  it("takes the wallet, held to the same rule the answer is", () => {
    expect(PayoutWalletRequestSchema.parse(asked)).toStrictEqual(asked);
    expect(PayoutWalletRequestSchema.safeParse({ payout_wallet: "0x1234" }).success).toBe(false);
    expect(
      PayoutWalletRequestSchema.safeParse({
        payout_wallet: "0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      }).success,
    ).toBe(false);
  });

  it("refuses null, because a wallet cannot be taken away", () => {
    // The difference between this document and the answer, and the whole of
    // it. Having no wallet is a state a merchant starts in and cannot go back
    // to: their published cards would stay on sale with nowhere for the money
    // to go, and every agent asking one of them what it costs would be met by
    // a gateway that cannot answer. What somebody reaching for null wants is
    // either a different wallet, which is this same call, or an end to
    // selling, which is the pause.
    expect(PayoutWalletRequestSchema.safeParse({ payout_wallet: null }).success).toBe(false);
  });

  it("says what to do instead, rather than that a string was expected", () => {
    const complaint = errorOf(PayoutWalletRequestSchema, { payout_wallet: null });

    expect(complaint).toContain("pause");
    expect(complaint).not.toContain("expected string");
  });

  it("refuses a document without payout_wallet and names it", () => {
    expectMissingFieldRejected(PayoutWalletRequestSchema, asked, "payout_wallet");
  });

  it("complains about a missing field in its own words, not the ones about null", () => {
    expect(errorOf(PayoutWalletRequestSchema, {})).not.toContain("pause");
  });

  it("has nowhere to put a key, and refuses one put there anyway", () => {
    // The line this whole feature is on the right side of: an address is what
    // somebody is paid at, and a key is what spends it. Nothing in this
    // contract takes one, and a field carrying one is refused rather than
    // ignored — ignored, it would sit in a log of the request that carried it.
    expect(errorOf(PayoutWalletRequestSchema, { ...asked, private_key: "0xdead" })).toContain(
      "private_key",
    );
    expect(errorOf(PayoutWalletRequestSchema, { ...asked, mnemonic: "a b c" })).toContain(
      "mnemonic",
    );
  });
});
