import { describe, expect, it } from "vitest";
import {
  DisabledKeySchema,
  IssuedKeySchema,
  IssueKeyRequestSchema,
  MerchantKeyListSchema,
  MerchantKeySchema,
  RegisteredMerchantSchema,
  RegistrationRequestSchema,
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
  const asked = { name: "Someone's shop", invitation: "the-code-from-the-invitation" };

  it("takes the name the seller trades under and the code they were given", () => {
    expect(RegistrationRequestSchema.parse(asked)).toStrictEqual(asked);
  });

  for (const field of ["name", "invitation"]) {
    it(`refuses a registration without ${field} and names it`, () => {
      expectMissingFieldRejected(RegistrationRequestSchema, asked, field);
    });
  }

  it("refuses a name a discovery catalog will not carry", () => {
    // This name goes out to strangers through a catalog that carries at most
    // thirty-two characters of printable ASCII and drops anything else without
    // a word. Refused here, the merchant is told; accepted here, they trade
    // under something nobody chose and nothing anywhere says so.
    expect(RegistrationRequestSchema.safeParse({ ...asked, name: "" }).success).toBe(false);
    expect(RegistrationRequestSchema.safeParse({ ...asked, name: "x".repeat(33) }).success).toBe(
      false,
    );
    expect(RegistrationRequestSchema.safeParse({ ...asked, name: "Магазин" }).success).toBe(false);
    expect(RegistrationRequestSchema.safeParse({ ...asked, name: " padded " }).success).toBe(false);
    expect(RegistrationRequestSchema.safeParse({ ...asked, name: "x".repeat(32) }).success).toBe(
      true,
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
    name: "Someone's shop",
    key: working,
    secret,
  };

  it("carries the merchant, their first key, and the secret once", () => {
    // All four are needed by the one caller: it writes the merchant and the
    // secret onto the account it is creating, and shows the key's own row so
    // the person can see what they now hold.
    expect(RegisteredMerchantSchema.parse(registered)).toStrictEqual(registered);
  });

  for (const field of ["merchant_id", "name", "key", "secret"]) {
    it(`refuses a registration answer without ${field} and names it`, () => {
      expectMissingFieldRejected(RegisteredMerchantSchema, registered, field);
    });
  }

  it("names the merchant the account will be tied to", () => {
    // Without it the cabinet has a key and nothing to say whose it is, and an
    // account that names no merchant is the single-tenant cabinet again.
    expect(RegisteredMerchantSchema.parse(registered).merchant_id).toBe("mch_4d21bb");
    expect(RegisteredMerchantSchema.safeParse({ ...registered, merchant_id: "" }).success).toBe(
      false,
    );
  });

  it("holds the key to the key document and the name to the catalog's rule", () => {
    expect(RegisteredMerchantSchema.safeParse({ ...registered, key: { id: "mk_1" } }).success).toBe(
      false,
    );
    expect(RegisteredMerchantSchema.safeParse({ ...registered, name: "Магазин" }).success).toBe(
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
  // The promise: a merchant can find out what they are listed under, set it,
  // and take it away again. It is one document both ways, so a cabinet reads
  // back exactly the shape it sent.
  const named = { seller_name: "Someone's shop" };
  const unnamed = { seller_name: null };

  it("carries the name a merchant chose", () => {
    expect(SellerNameSchema.parse(named)).toStrictEqual(named);
  });

  it("says a merchant has no name rather than leaving the field out", () => {
    // Null is the fact "nobody has chosen one", and it is also how a merchant
    // takes a name away. An absent field is a silence, and the screen that
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
