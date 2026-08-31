/**
 * How a merchant comes to exist, the name their products are sold under, the
 * wallet their sales are paid into, and the keys they open the door with.
 *
 * The first two belong together because registering is the act that produces
 * both: one call makes the merchant and issues their first key, and what comes
 * back carries the key's own row as well as the secret. Split across two files,
 * the key document would have to be imported by the registration answer anyway,
 * and a reader looking for "what does a key look like" would have two places to
 * look. The name is here for the same reason read the other way round — it is a
 * fact about the merchant and about none of their cards, and the one question a
 * reader arrives with is which of the two names a merchant has is which.
 *
 * Two rules run through the file and are worth saying once.
 *
 * The secret appears in exactly three documents, and every one of them is the
 * answer to a call that has just made a key. Nothing that is ever drawn again —
 * the list a merchant reads, the row that comes back from disabling one — can
 * carry it, and the shapes below refuse it rather than merely omit it. What is
 * kept on our side is a digest, so there is nothing to put in those documents
 * even if somebody wanted to.
 *
 * And a key that has been revoked stays in the list. `disabled_at` is a moment
 * rather than a flag, and it is always present: after an incident the question
 * is when a key stopped working, and a list that dropped the key answers
 * nothing, while a flag answers only half.
 */

import { z } from "zod";
import { ServiceNameSchema } from "./card.js";
import { EvmAddressSchema } from "./evm-address.js";
import { IdentifierSchema, TimestampSchema } from "./primitives.js";

/**
 * What a merchant calls one of their keys, so one of several can be told from
 * the others.
 *
 * Not empty, and not padded with spaces. Both defeat the only thing a label is
 * for: a blank label is a row in a list with nothing in it, and a space at
 * either end makes two labels that look identical wherever they are printed
 * while being two different strings.
 *
 * What it does not do is worth saying, because a reader could take the rule for
 * more than it is. Nothing here bounds the length, since no channel outside us
 * carries this text and a number would be a bound nobody's format asks for, and
 * nothing here holds a label to one alphabet: unlike the name a discovery
 * catalog lists a seller under, a label never leaves the merchant's own
 * screens, so a label written in Cyrillic is a label. A character that shows
 * nothing is allowed through as well, which is the omission a reader is likeliest
 * to be surprised by — an identifier refuses one, because an identifier is
 * matched on and two that look alike are two keys nobody can tell apart, and a
 * label is only ever read, so the same character makes one odd-looking row.
 */
const KeyLabelSchema = z
  .string()
  .regex(/^\S(?:[\s\S]*\S)?$/u, "a label must not be empty or padded with spaces");

/**
 * The key itself, in the only form its owner will ever see it.
 *
 * No whitespace anywhere in it, and that bound belongs to the transport rather
 * than to us: a key travels as a bearer token, and the reader on the other side
 * takes everything up to the first space. A secret with a space in it would
 * arrive as a prefix of itself and open nothing, and the merchant would spend
 * an afternoon on a key that looks perfectly good.
 *
 * Nothing here says how long a key is or what it starts with. Those are the
 * gateway's, which is the side that generates them, and a shape written down
 * here would be a promise about a format we mean to be free to change.
 */
const KeySecretSchema = z
  .string()
  .regex(/^\S+$/, "a key travels as a bearer token, so it carries no whitespace and is not empty");

/**
 * The code that stands in the door of registration.
 *
 * It is one value out of the gateway's configuration, handed to a person along
 * with the address of the site (ADR-0014 §3). All this shape asks is that
 * something was actually typed: a form submitted with an empty field is a
 * mistake at the keyboard rather than a wrong code, and the two are worth
 * telling apart before anything is compared.
 */
const InvitationSchema = z
  .string()
  .regex(/\S/, "an invitation is the code handed over with the address of the site");

/**
 * One key a merchant holds, as they read it.
 *
 * The secret is not here and cannot be put here. This is the document a screen
 * lists, drawn again on every visit, and the secret is shown once by the call
 * that made the key and never again — so a shape that could carry one is a
 * shape that eventually does.
 */
export const MerchantKeySchema = z
  .strictObject({
    id: IdentifierSchema,

    label: KeyLabelSchema,

    created_at: TimestampSchema,

    /**
     * When this key was revoked, and null while it still opens the door.
     *
     * Required and nullable rather than optional, because the two readings of
     * an absent field are "this key works" and "nobody wrote it down", and a
     * screen that guessed wrong would show a revoked key as live. The instant
     * rather than a flag: a flag answers whether the key works, and the
     * question somebody asks afterwards is when it stopped.
     */
    disabled_at: TimestampSchema.nullable(),
  })
  .meta({
    description:
      "One key a merchant opens the door with, as they read it: what they called it, when it was made, and when it was revoked. A null disabled_at means the key still works; the field is always present, because an absent one is a silence a reader cannot tell from an oversight. The key itself is not in this document and never will be — what is kept is a digest of it, so nothing here or anywhere else can show a merchant their key a second time.",
  });

/**
 * The keys one merchant made for their own code, and the one this call was made
 * with.
 *
 * `this_call` is the field the list cannot be assembled without, and the reason
 * is a rule in the route rather than anything about the shape: a merchant
 * cannot disable the key their own call was made with (ADR-0014 §5). A screen
 * that did not know which of these that was would offer a button the route
 * refuses, on the one page where being refused looks like the product being
 * broken.
 *
 * It is not always one of the keys beside it, and that is the thing a reader is
 * likeliest to assume and be wrong about. A cabinet calls with a key made for a
 * cabinet, and those are in nobody's list, so a client that looked this
 * identifier up among the rows would find nothing — which is an answer rather
 * than an error, and a screen has to be built for it.
 *
 * An object rather than a bare array, for that reason before any other — an
 * array has nowhere to put it.
 */
export const MerchantKeyListSchema = z
  .strictObject({
    /**
     * The keys this merchant made for their own code, the revoked ones among
     * them.
     *
     * The keys a cabinet holds are not here and never will be: the merchant did
     * not issue one and has nothing to do with one. A list is what somebody
     * acts on, and a row nobody has any business acting on is a row that only
     * raises the question of why it will not go away.
     */
    keys: z.array(MerchantKeySchema),

    /** The key the request carrying this answer was made with. */
    this_call: IdentifierSchema,
  })
  .meta({
    description:
      "The keys one merchant made for their own code, working and revoked together, and the identifier of the key this very call was made with. That last field is here because a merchant cannot disable the key they are holding: without it a screen would offer a button the gateway refuses. It is not always among the keys listed — a cabinet calls with a key of its own, and those are in no list here — so a client matching it against the rows has to be built for finding none. The keys a cabinet holds are left out entirely: they are not issued by the merchant and cannot be revoked by them. This document does not say whether it is the whole list either — paging is not designed, and the absence of a field about it is not a promise that there is no more.",
  });

/** What a merchant sends to have a key made. */
export const IssueKeyRequestSchema = z
  .strictObject({
    label: KeyLabelSchema,
  })
  .meta({
    description:
      "What a merchant asks for when they want another key: the name they will know it by, and nothing else. There is nowhere here to put a secret, because a key is generated rather than chosen — one somebody picks is one somebody reuses somewhere else.",
  });

/**
 * A key that has just been made: the row, and the secret, once.
 *
 * Both halves are needed by the caller. Without the secret there is no key to
 * hand to a worker; without the row there is a string and nothing to say which
 * of the merchant's keys it is, which is the thing they need to disable it
 * later.
 */
export const IssuedKeySchema = z
  .strictObject({
    key: MerchantKeySchema,
    /** The only moment this is readable. Nothing on our side keeps it. */
    secret: KeySecretSchema,
  })
  .meta({
    description:
      "A key as it comes back from being issued: the row a merchant will see in their list from now on, and the key itself. It carries the key once. Three answers in this contract carry one — this, what registering gives back, and the key a cabinet asks for — and nothing else does, because what is written down on our side is a digest. A key that is lost is replaced by a new one rather than read back.",
  });

/**
 * A key that has been revoked, as it now stands.
 *
 * An object rather than the key itself, so the day this answer has to say
 * anything beside the key — how many of the merchant's keys still work, say — it
 * grows a field instead of changing shape under every reader.
 */
export const DisabledKeySchema = z
  .strictObject({
    key: MerchantKeySchema,
  })
  .meta({
    description:
      "The key that was just revoked, with the instant it stopped working on it, so a merchant reads back what happened rather than taking the call's word for it. Revoking a key that was already revoked answers this same way and keeps the first instant, because that is the true one and a retry after a dropped connection must not rewrite it.",
  });

/**
 * A key made for a cabinet, which is the secret and nothing else.
 *
 * Every other answer that makes a key carries the row beside it, and this one
 * cannot. A key made for a cabinet is in no merchant's list — they did not
 * issue it and have no reason to know it exists — so an identifier here would
 * name a row that no screen of theirs draws and no button of theirs reaches.
 * It would still be an identifier the revoking takes: that call names a key and
 * asks nothing about what it was made for, so handing one out is handing out
 * the way to switch a cabinet off. What the caller does with this is put it on
 * the row of whoever just signed in, and that is the whole of what it needs.
 */
export const CabinetKeySchema = z
  .strictObject({
    /** The only moment this is readable. Nothing on our side keeps it. */
    secret: KeySecretSchema,
  })
  .meta({
    description:
      "A key made for a cabinet to call as one merchant, carried once and readable nowhere afterwards. There is no row beside it and there is nothing to put one: a key made this way is in no merchant's list of keys, because the merchant did not issue it and has no screen it belongs on. Its identifier is deliberately not here — the call that revokes a key asks nothing about what that key was made for, so an identifier for this one is the way to switch a cabinet off. Whoever asked for this holds it until they ask for another.",
  });

/**
 * What sweeping up a merchant's other cabinet keys came to.
 *
 * A count rather than a list of identifiers, because those identifiers name
 * rows that no longer exist and never appeared in any list while they did.
 * One is the ordinary answer, since the sign-in before this one left a key
 * behind; zero is what a repeat of the call gets, and what the first sign-in a
 * merchant ever makes gets. It is a number rather than a silence for the
 * reason every nullable answer here is one: a reader cannot tell an absent
 * field from a client that dropped it.
 */
export const ForgottenCabinetKeysSchema = z
  .strictObject({
    /** How many keys stopped existing, which is nought or more. */
    removed: z.int().min(0),
  })
  .meta({
    description:
      "How many of this merchant's cabinet keys were removed: every one of them except the key this call was made with. Zero is an ordinary answer and means there was nothing else to remove. The keys themselves are not named, because they were in no list while they existed and are gone now.",
  });

/**
 * What a merchant's products are sold under, as the merchant reads it back.
 *
 * Null is the fact "nobody has chosen one", which is every merchant on the day
 * they register and is the state they stay in until they do. It is a value
 * rather than an absent field, because an absent field would be
 * indistinguishable from a client that dropped it, and a settings screen
 * reading the second as the first would tell a merchant they are listed under
 * nothing while they are listed under something.
 *
 * The name is held to the rule of the catalog that carries it, which is where
 * this name is going: at most thirty-two characters of printable ASCII. That
 * bound is not ours and is not about our own storage — the catalog drops what
 * it cannot render and tells nobody, so a name refused here is a name the
 * merchant is told about, and a name accepted here and dropped there is a
 * seller trading under something they did not choose.
 */
export const SellerNameSchema = z
  .strictObject({
    /** What buyers read beside this merchant's products, or nothing. */
    seller_name: ServiceNameSchema.nullable(),
  })
  .meta({
    description:
      "The name a merchant's products are sold under: what a discovery catalog lists them under and what a buyer's agent is shown beside the price. Null means nobody has chosen one, which is where every merchant starts. The field is always present rather than left out when there is no name: an absent field would be indistinguishable from a client that dropped it. What a name may be is the catalog's rule rather than ours — at most 32 characters of printable ASCII — because a name outside it is dropped there in silence, so it is refused here where somebody is told. A merchant with no name cannot publish a card: a card published without one reaches a buyer's agent inside a payment request that names no seller at all.",
  });

/**
 * What a merchant sends to change what their products are sold under.
 *
 * The same field held to the same rule, and one difference: there is no null.
 * A merchant can go from having no name to having one and from one name to
 * another, and not back. Having none is a starting state rather than a setting,
 * because a payment request names the seller and there would be nobody to name:
 * every card they had already published would come off sale, which is an end to
 * their selling arriving under the name of editing a setting. What somebody
 * reaching for that actually wants is one of two other acts: a different name,
 * which is this same call, or an end to selling, which is the pause — and the
 * pause leaves their cards where they can find them again.
 *
 * So it is two documents rather than one, and a cabinet still reads back the
 * shape it sent. The message on a null is written here rather than left to a
 * type error, because "expected string, received null" describes the shape and
 * says nothing about which act the sender was reaching for.
 */
export const SellerNameRequestSchema = z
  .strictObject({
    /**
     * What buyers are to read beside this merchant's products.
     *
     * The rule lives once, in `ServiceNameSchema`, and this reaches it through
     * a string that carries its own words for "this is not a name at all". A
     * second copy of the length and the alphabet written out here is the copy
     * that goes stale.
     */
    seller_name: z
      .string({
        // A field that is missing is a client with a bug and a field holding
        // null is a client with a misunderstanding. Only the second gets this
        // sentence; the first falls through to the ordinary words about a
        // field that is not there, which is what its author needs to read.
        error: (issue) =>
          issue.input === undefined
            ? undefined
            : "a seller name cannot be taken away, only changed: a merchant who wants to stop being listed pauses their selling, which leaves their cards where they can put them back on sale",
      })
      .pipe(ServiceNameSchema),
  })
  .meta({
    description:
      "What a merchant sends to change the name their products are sold under. The same rule as the answer — at most 32 characters of printable ASCII, the catalog's rule rather than ours — and one difference: null is refused. A merchant goes from no name to a name and from one name to another, never back to none, because a payment request names the seller and there would be nobody to name: every card they have published would come off sale, which is an end to their selling arriving under the name of editing a setting. Somebody reaching for null wants one of two other things: a different name, which is this call with a different value, or an end to selling, which is the pause.",
  });

/**
 * The wallet a merchant's sales are paid into, as the merchant reads it back.
 *
 * Payments here are not held by anybody on the way: a buyer's agent pays the
 * merchant's own address directly, and this is that address. There is no
 * account of theirs on our side with a balance in it and no moment at which
 * their money is ours, which is why this field exists at all — without it there
 * would have to be.
 *
 * Null is the fact "nobody has said where the money goes", which is every
 * merchant on the day they register. It is a value rather than an absent field
 * for the reason the seller name is: a settings screen cannot tell a silence
 * from a client that dropped the field, and reading the second as the first
 * tells a merchant they are set up to be paid when nothing of theirs can be.
 *
 * What comes back is always the spelling a wallet shows, whichever of the two
 * accepted spellings was sent. The door takes both and everything behind it
 * holds one (ADR-0017), and this is the one for a reason that is about the
 * person rather than about the storage: a merchant pastes forty characters out
 * of their wallet and reads them back on a settings screen, and handed the same
 * address in lower case they cannot tell it from a different address without
 * comparing character by character. On the one field money is sent to, that
 * glance is the whole of the checking anybody does.
 */
export const PayoutWalletSchema = z
  .strictObject({
    /** Where this merchant's sales are paid, or nothing at all. */
    payout_wallet: EvmAddressSchema.nullable(),
  })
  .meta({
    description:
      "The address a merchant's sales are paid into. Payments are not held by anybody on the way: a buyer's agent pays this address directly, and it is the payTo of every payment request made for this merchant's products. Null means nobody has set one, which is where every merchant starts; the field is always present rather than left out, because an absent field is indistinguishable from a client that dropped it. The address comes back in the mixed-case spelling a wallet shows, whichever of the two accepted spellings was sent — so what a merchant reads back on a screen is character for character what they copied out of their wallet. On a deployment that settles on a real chain a merchant with no wallet here cannot publish a card, because the money from that card's sales would have nowhere to go.",
  });

/**
 * What a merchant sends to change where their sales are paid.
 *
 * The same field held to the same rule, and one difference, which is the same
 * difference the seller name has and rests on something harder. There is no
 * null. A merchant goes from having no wallet to having one and from one wallet
 * to another, and not back: a merchant who took their address away would keep
 * every card they had already published on sale, and the payment request an
 * agent is answered with cannot be built at all without an address — so the
 * products would stop being buyable and nothing anywhere would say why. What
 * somebody reaching for null actually wants is one of two other acts: a
 * different address, which is this same call, or an end to selling, which is
 * the pause, and the pause leaves their cards where they can put them back.
 *
 * There is nowhere here to put a key, and a document carrying one is refused
 * rather than trimmed. This contract knows where a merchant is paid and has no
 * business knowing anything that could spend it.
 */
export const PayoutWalletRequestSchema = z
  .strictObject({
    /**
     * Where this merchant's sales are to be paid.
     *
     * The rule lives once, in `EvmAddressSchema`, and this reaches it through a
     * string that carries its own words for "this is not an address at all".
     */
    payout_wallet: z
      .string({
        // A field that is missing is a client with a bug and a field holding
        // null is a client with a misunderstanding. Only the second gets this
        // sentence; the first falls through to the ordinary words about a
        // field that is not there.
        error: (issue) =>
          issue.input === undefined
            ? undefined
            : "a payout wallet cannot be taken away, only changed: a merchant who wants to stop being paid pauses their selling, which leaves their cards where they can put them back on sale — a merchant with cards on sale and no wallet has products a payment request cannot even be written for",
      })
      .pipe(EvmAddressSchema),
  })
  .meta({
    description:
      "What a merchant sends to set or change the address their sales are paid into. The same rule as the answer — 0x and forty hexadecimal characters, in lower case or in the exact mixed-case spelling a wallet shows — and one difference: null is refused. A merchant goes from no wallet to a wallet and from one wallet to another, never back to none, because their published cards stay on sale and a payment request for one of them cannot be written without an address. Somebody reaching for null wants either a different address, which is this call with a different value, or an end to selling, which is the pause. Nothing here takes a private key or a seed phrase, and a document carrying one is refused rather than ignored: this contract knows where a merchant is paid and nothing that could spend it.",
  });

/**
 * What somebody sends to become a merchant.
 *
 * One field, and what is not here is most of what is worth reading. The address
 * and the password belong to the account rather than to the merchant, and they
 * stay on the other side of the boundary (ADR-0014 §1) — a gateway that took
 * either would be holding a person's credentials on the money path, which is
 * what this route's whole shape is arranged to avoid.
 *
 * The name the seller's products are sold under is not here either, and that
 * omission is a decision rather than a simplification. It is a public answer,
 * and asking for it here asks for it at the one moment a merchant knows least:
 * no products, no catalogue seen, no idea what the name is for. It is asked for
 * on the screen after this one instead, where there is room to say why it
 * matters, and it can be changed afterwards from the merchant's own settings.
 *
 * The shape refuses a name rather than ignoring one, because a field quietly
 * dropped is a person believing they have chosen what buyers will read.
 */
export const RegistrationRequestSchema = z
  .strictObject({
    /** The code handed over with the address of the site. */
    invitation: InvitationSchema,
  })
  .meta({
    description:
      "What somebody sends to become a merchant: the invitation code they were given, and nothing else. The name their products are sold under is deliberately not here — it is a public answer, and asked for on the way in it is answered by somebody with no products and no idea what the name is for; it is set afterwards, and changed afterwards, through the merchant's own call for it. Nothing about an account is here either: an address and a password belong to whatever signs the person in, and are never sent to the gateway. A document carrying either is refused rather than trimmed, because a field accepted and dropped is somebody believing they said something.",
  });

/**
 * What registering answers with: a merchant, the key the cabinet will call as
 * them with, and the secret.
 *
 * The key is made for a cabinet rather than for the merchant's own code, and
 * that is what the caller of this route is. So it is in no list: a merchant who
 * has just registered has no keys of their own at all, and the first one they
 * do have is one they ask for. The row travels here anyway, because it is the
 * one thing this answer can say about the credential it just handed over — and
 * it is the one place on this surface that hands out the identifier of such a
 * key, which the call that revokes one will take as readily as any other. A
 * screen that drew it beside a merchant's own keys would be offering them the
 * button that switches their own cabinet off.
 *
 * No name comes back, because none was chosen. A merchant who has just
 * registered is listed under nothing at all, and a field here would either be a
 * name this call invented or a null that says the same thing at more length.
 */
export const RegisteredMerchantSchema = z
  .strictObject({
    /** The merchant that now exists, which every key and card of theirs names. */
    merchant_id: IdentifierSchema,

    key: MerchantKeySchema,

    /** The key itself, shown once, exactly as issuing one shows it. */
    secret: KeySecretSchema,
  })
  .meta({
    description:
      "What registering produced: the merchant, the key whoever registered them will call as them with, and that key itself. The key is readable here and nowhere afterwards, so whoever made this call is the only party that can keep it. It is a key made for a cabinet rather than one of the merchant's own: it appears in no list of their keys and cannot be revoked from there, and a merchant who has just registered has no keys of their own until they ask for one. The merchant is listed under no name yet and this answer carries none — the name their products are sold under is chosen afterwards, and until it is, publishing a card is refused. What this answer does not carry either is any notion of an account or a session: registering makes a merchant and a key, and whatever signs a person in is on the other side of this call.",
  });

export type SellerName = z.infer<typeof SellerNameSchema>;
export type SellerNameRequest = z.infer<typeof SellerNameRequestSchema>;
export type PayoutWallet = z.infer<typeof PayoutWalletSchema>;
export type PayoutWalletRequest = z.infer<typeof PayoutWalletRequestSchema>;
export type MerchantKey = z.infer<typeof MerchantKeySchema>;
export type MerchantKeyList = z.infer<typeof MerchantKeyListSchema>;
export type IssueKeyRequest = z.infer<typeof IssueKeyRequestSchema>;
export type IssuedKey = z.infer<typeof IssuedKeySchema>;
export type DisabledKey = z.infer<typeof DisabledKeySchema>;
export type CabinetKey = z.infer<typeof CabinetKeySchema>;
export type ForgottenCabinetKeys = z.infer<typeof ForgottenCabinetKeysSchema>;
export type RegistrationRequest = z.infer<typeof RegistrationRequestSchema>;
export type RegisteredMerchant = z.infer<typeof RegisteredMerchantSchema>;
