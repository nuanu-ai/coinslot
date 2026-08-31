/**
 * The commands that make a merchant and keep their keys.
 *
 * The one thing worth more than the rest: the key printed at the terminal is
 * the key that opens the door. Nothing else here can check that for the person
 * running it — there is no second chance to read the key, and a command that
 * printed one string while writing the digest of another would look exactly
 * like a merchant who typed it in wrong.
 *
 * The rest is what somebody does at a terminal: naming a merchant who is not
 * there, disabling a key twice, running a verb with half its arguments.
 */

import { describe, expect, it } from "vitest";
import { MemoryStore } from "./adapters/memory/store.js";
import { issueCabinetKey, keyDigest } from "./app/merchants.js";
import { runMerchant } from "./merchant-command.js";
import { countedIds } from "./testing/harness.js";

/** A store, the identifiers, a fixed clock, and everything the command said. */
function aTerminal() {
  const store = new MemoryStore(countedIds());
  const said: string[] = [];
  const at = Date.parse("2026-08-27T12:00:00.000Z");
  // One generator across every run, because that is what a process has: two of
  // them would issue two keys under one identifier, which a database refuses.
  const ids = countedIds();
  const run = (...argv: string[]) =>
    runMerchant(
      argv,
      store,
      ids,
      () => at,
      (line) => said.push(line),
    );
  return { store, said, at, ids, run, text: () => said.join("\n") };
}

describe("making a merchant", () => {
  it("writes one down and prints the identifier everything else names it by", async () => {
    const terminal = aTerminal();

    const code = await terminal.run("add", "Someone's shop");

    expect(code).toBe(0);
    const [made] = await terminal.store.merchants();
    expect(made?.name).toBe("Someone's shop");
    expect(terminal.text()).toContain(made?.id ?? "no merchant was made");
  });

  it("takes a name with spaces in it rather than only its first word", async () => {
    const terminal = aTerminal();

    await terminal.run("add", "Someone's", "shop", "in", "Ubud");

    expect((await terminal.store.merchants())[0]?.name).toBe("Someone's shop in Ubud");
  });

  it("asks for a name rather than making a merchant with none", async () => {
    const terminal = aTerminal();

    expect(await terminal.run("add")).toBe(2);
    expect(await terminal.store.merchants()).toStrictEqual([]);
  });

  it("says what the verbs are when it is given one it does not know", async () => {
    const terminal = aTerminal();

    expect(await terminal.run()).toBe(2);
    expect(await terminal.run("delete", "everything")).toBe(2);
    expect(terminal.text()).toContain("disable");
  });

  it("says there are none rather than printing nothing", async () => {
    const terminal = aTerminal();

    expect(await terminal.run("list")).toBe(0);
    expect(terminal.text()).toContain("no merchants");
  });

  it("shows what buyers read, for the merchants who have chosen it", async () => {
    // The list is what somebody at a terminal reads to find a merchant, and the
    // name that identifies one to everybody else is the name their products are
    // sold under. A merchant who registered has no name of their own worth
    // printing — nobody typed one — so a list that showed only that column
    // would read identically down every row of them.
    const terminal = aTerminal();
    await terminal.run("add", "Someone's shop");
    const [made] = await terminal.store.merchants();
    await terminal.run("listed-as", made?.id ?? "", "The shop on the corner");

    const listed = await theListing(terminal);

    expect(listed).toContain("The shop on the corner");
  });

  it("still names a merchant who has chosen none, rather than leaving the row blank", async () => {
    // The other half. A merchant with no listing name is the ordinary state
    // between registering and choosing, and their row still has to say which
    // merchant it is — otherwise the change above would have replaced one name
    // with nothing at all for every merchant who has not chosen yet.
    const terminal = aTerminal();
    await terminal.run("add", "Someone's shop");

    const listed = await theListing(terminal);

    expect(listed).toContain("Someone's shop");
  });
});

/**
 * What `list` alone printed.
 *
 * Read off the lines this one run added rather than off everything the terminal
 * has ever said: the verb that sets a listing name prints that name back, so a
 * test reading the whole transcript would find it there and pass against a
 * listing that shows nothing of the sort.
 */
async function theListing(terminal: ReturnType<typeof aTerminal>): Promise<string> {
  const before = terminal.said.length;
  expect(await terminal.run("list")).toBe(0);
  return terminal.said.slice(before).join("\n");
}

describe("issuing a key", () => {
  it("prints a key that opens the door, once", async () => {
    // The whole of what this command is for. The key is generated here, printed
    // here, and never readable again — so if the digest written down were of
    // anything but the string printed, nobody would find out until a merchant
    // reported that their key did not work.
    const terminal = aTerminal();
    await terminal.run("add", "Someone's shop");
    const [made] = await terminal.store.merchants();
    const merchantId = made?.id ?? "";
    terminal.said.length = 0;

    expect(await terminal.run("key", merchantId, "the shop's own worker")).toBe(0);

    const printed = terminal.said
      .map((line) => line.trim())
      .find((line) => line.startsWith("csk_"));
    expect(printed).toBeDefined();
    expect((await terminal.store.workingKey(keyDigest(printed ?? "")))?.merchantId).toBe(
      merchantId,
    );
  });

  it("refuses to issue a key for a merchant nobody made", async () => {
    // Named rather than left to the database's foreign key, so somebody who
    // mistyped an identifier reads a sentence instead of a driver's error.
    const terminal = aTerminal();

    expect(await terminal.run("key", "mch_nobody", "a label")).toBe(1);
    expect(terminal.text()).toContain("mch_nobody");
  });

  it("asks for a label rather than issuing a key nobody can tell from another", async () => {
    const terminal = aTerminal();
    await terminal.run("add", "Someone's shop");
    const merchantId = (await terminal.store.merchants())[0]?.id ?? "";

    expect(await terminal.run("key", merchantId)).toBe(2);
    expect(await terminal.store.keysOf(merchantId)).toStrictEqual([]);
  });

  it("never prints a key back when the keys are listed", async () => {
    // What is kept is a digest, and this is the command that would leak it if
    // anything did.
    const terminal = aTerminal();
    await terminal.run("add", "Someone's shop");
    const merchantId = (await terminal.store.merchants())[0]?.id ?? "";
    await terminal.run("key", merchantId, "the worker's");
    const secret = terminal.said.map((line) => line.trim()).find((line) => line.startsWith("csk_"));
    terminal.said.length = 0;

    expect(await terminal.run("keys", merchantId)).toBe(0);

    expect(terminal.text()).not.toContain(secret ?? "csk_nothing-was-issued");
    expect(terminal.text()).toContain("the worker's");
  });

  it("shows the keys a cabinet holds beside the merchant's own, and says which", async () => {
    // This list is the operator's and it is the only place either kind is
    // printed. Two things ride on it. A cabinet's key opens the door, so a
    // listing that left it out would let somebody revoke the merchant's last
    // worker believing they had another; and which key is which is what stands
    // between revoking a worker and locking a person out of their cabinet, so
    // it is said in a column rather than left to a label anybody can type.
    const terminal = aTerminal();
    await terminal.run("add", "Someone's shop");
    const merchantId = (await terminal.store.merchants())[0]?.id ?? "";
    await terminal.run("key", merchantId, "the worker's");
    // Through the terminal's own generator, because two of them would issue two
    // keys under one identifier, exactly as two processes would.
    await issueCabinetKey(terminal.store, terminal.ids, merchantId, terminal.at);
    terminal.said.length = 0;

    expect(await terminal.run("keys", merchantId)).toBe(0);

    expect(terminal.text()).toContain("own code");
    expect(terminal.text()).toContain("cabinet");
  });
});

describe("disabling a key", () => {
  it("stops one key and says whether the merchant has another that works", async () => {
    // Somebody revoking a key that has leaked needs to know whether they have
    // just locked the merchant out of their own gateway.
    const terminal = aTerminal();
    await terminal.run("add", "Someone's shop");
    const merchantId = (await terminal.store.merchants())[0]?.id ?? "";
    await terminal.run("key", merchantId, "the first");
    await terminal.run("key", merchantId, "the second");
    const [first, second] = await terminal.store.keysOf(merchantId);
    terminal.said.length = 0;

    expect(await terminal.run("disable", first?.id ?? "")).toBe(0);

    expect(terminal.text()).toContain("1 other key");
    expect((await terminal.store.keysOf(merchantId))[0]?.disabledAt).toBe(terminal.at);
    // And the other one is untouched, which is the whole reason a key is a row.
    expect(second?.disabledAt).toBeNull();

    terminal.said.length = 0;
    await terminal.run("disable", second?.id ?? "");
    expect(terminal.text()).toContain("no working key");
  });

  it("says there is no such key rather than reporting a revocation that never happened", async () => {
    const terminal = aTerminal();

    expect(await terminal.run("disable", "mk_nobody")).toBe(1);
    expect(terminal.text()).toContain("nothing to disable");
  });

  it("asks for a key rather than disabling something it had to guess", async () => {
    expect(await aTerminal().run("disable")).toBe(2);
  });
});

describe("the name a merchant is listed under", () => {
  it("sets it and says what it now is", async () => {
    const terminal = aTerminal();
    await terminal.run("add", "Someone's shop");
    const [made] = await terminal.store.merchants();

    const code = await terminal.run("listed-as", made?.id ?? "", "Someone's shop");

    expect(code).toBe(0);
    expect((await terminal.store.merchantById(made?.id ?? ""))?.serviceName).toBe("Someone's shop");
    expect(terminal.text()).toContain("Someone's shop");
  });

  it("refuses a name the catalog would cut down, and says why", async () => {
    // The whole point of holding it here: the catalog drops what it cannot
    // render and tells nobody, so a merchant would trade under a word they did
    // not choose and never find out.
    const terminal = aTerminal();
    await terminal.run("add", "A merchant");
    const [made] = await terminal.store.merchants();

    const code = await terminal.run("listed-as", made?.id ?? "", "Кафе");

    expect(code).toBe(1);
    expect(terminal.text()).toMatch(/ASCII/i);
    expect((await terminal.store.merchantById(made?.id ?? ""))?.serviceName).toBeNull();
  });

  it("takes it away when nothing is named, and says the cards come off sale with it", async () => {
    // What the verb now does, and the person running it has to be told: a card
    // sells only under a name, because that name is what the payment request
    // calls the seller. So `--none` is not merely a row edited — it is this
    // merchant's whole catalog off sale, and somebody who reads "nothing about
    // the seller goes out" and walks away has been told the small half of it.
    const terminal = aTerminal();
    await terminal.run("add", "A merchant");
    const [made] = await terminal.store.merchants();
    await terminal.run("listed-as", made?.id ?? "", "Freeland");

    const code = await terminal.run("listed-as", made?.id ?? "", "--none");

    expect(code).toBe(0);
    expect((await terminal.store.merchantById(made?.id ?? ""))?.serviceName).toBeNull();
    expect(terminal.text()).toMatch(/off sale/i);
  });

  it("says there is no such merchant rather than writing a row for one", async () => {
    const terminal = aTerminal();

    const code = await terminal.run("listed-as", "mch_nobody", "Freeland");

    expect(code).toBe(1);
    expect(terminal.text()).toContain("mch_nobody");
  });

  it("asks for a merchant rather than guessing at one", async () => {
    const terminal = aTerminal();

    expect(await terminal.run("listed-as")).toBe(2);
    expect(terminal.text()).toContain("listed-as");
  });
});

describe("the address a merchant is paid at", () => {
  /** One address, as a wallet shows it and as an explorer prints it. */
  const A_WALLET = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
  const A_WALLET_IN_LOWER = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";

  it("sets it and says where the money now goes", async () => {
    const terminal = aTerminal();
    await terminal.run("add", "Someone's shop");
    const [made] = await terminal.store.merchants();

    const code = await terminal.run("pays-to", made?.id ?? "", A_WALLET);

    expect(code).toBe(0);
    expect((await terminal.store.merchantById(made?.id ?? ""))?.payoutWallet).toBe(A_WALLET);
    expect(terminal.text()).toContain(A_WALLET);
  });

  it("writes the lower-case spelling out the way a wallet shows it", async () => {
    // The other accepted spelling at the door, written down as the one form
    // anything behind it holds — so an operator who pasted an address off a
    // block explorer and a merchant reading their settings screen see the same
    // forty characters.
    const terminal = aTerminal();
    await terminal.run("add", "Someone's shop");
    const [made] = await terminal.store.merchants();

    await terminal.run("pays-to", made?.id ?? "", A_WALLET_IN_LOWER);

    expect((await terminal.store.merchantById(made?.id ?? ""))?.payoutWallet).toBe(A_WALLET);
  });

  it("refuses an address whose own letters disagree with it, and writes nothing", async () => {
    // The whole point of holding it here rather than taking the paste on trust:
    // a mistyped address is another perfectly good address, so nothing
    // downstream would notice, and every sale afterwards would be a stranger's.
    const terminal = aTerminal();
    await terminal.run("add", "A merchant");
    const [made] = await terminal.store.merchants();

    const code = await terminal.run(
      "pays-to",
      made?.id ?? "",
      "0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    );

    expect(code).toBe(1);
    expect(terminal.text()).toMatch(/checksum|lower case/i);
    expect((await terminal.store.merchantById(made?.id ?? ""))?.payoutWallet).toBeNull();
  });

  it("refuses something that is not an address at all", async () => {
    const terminal = aTerminal();
    await terminal.run("add", "A merchant");
    const [made] = await terminal.store.merchants();

    const code = await terminal.run("pays-to", made?.id ?? "", "0x1234");

    expect(code).toBe(1);
    expect((await terminal.store.merchantById(made?.id ?? ""))?.payoutWallet).toBeNull();
  });

  it("says there is no such merchant rather than writing a row for one", async () => {
    const terminal = aTerminal();

    const code = await terminal.run("pays-to", "mch_nobody", A_WALLET);

    expect(code).toBe(1);
    expect(terminal.text()).toContain("mch_nobody");
  });

  it("asks for a merchant and an address rather than guessing at either", async () => {
    const terminal = aTerminal();
    await terminal.run("add", "A merchant");
    const [made] = await terminal.store.merchants();

    expect(await terminal.run("pays-to")).toBe(2);
    expect(await terminal.run("pays-to", made?.id ?? "")).toBe(2);
    expect(terminal.text()).toContain("pays-to");
  });
});
