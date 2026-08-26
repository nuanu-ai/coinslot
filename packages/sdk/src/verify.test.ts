import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runVerify, VERIFY_EXIT } from "./verify.js";

const validCard = {
  merchant_item_id: "access-monthly",
  title: "Доступ к сервису на один месяц",
  description: "Что покупатель получает, для какой задачи это годится и что в это не входит.",
  price: { amount: "5.00", currency: "USD" },
  params: { email: { type: "string", required: true, title: "Куда прислать доступ" } },
  result: { access_url: { type: "string", title: "Ссылка для входа" } },
  fulfillment: "sync",
};

let directory: string | undefined;

const fileHolding = (name: string, contents: unknown): string => {
  directory ??= mkdtempSync(join(tmpdir(), "coinslot-verify-"));
  const path = join(directory, name);

  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents, null, 2));

  return path;
};

afterEach(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

const verifying = async (...argv: string[]): Promise<{ code: number; said: string }> => {
  const lines: string[] = [];
  const code = await runVerify(argv, (line) => lines.push(line));

  return { code, said: lines.join("\n") };
};

describe("npx coinslot verify", () => {
  it("checks the cards it is given and says both passed and did not run apart", async () => {
    // The fifth gate in one assertion: "I do not know" has to be
    // distinguishable from "I know that there is none", and a command that
    // ran one check of two must not report as though it ran both.
    const { code, said } = await verifying("verify", fileHolding("card.json", validCard));

    expect(said).toMatch(/access-monthly/);
    expect(said).toMatch(/complete/i);
    expect(said).toMatch(/could not be run/i);
    expect(code).toBe(VERIFY_EXIT.COULD_NOT_RUN);
  });

  it("names exactly what is missing for the idempotency run rather than a shrug", async () => {
    // A merchant told "this check is unavailable" learns nothing. Told which
    // route and which field are absent, they can read the same table we did
    // and see it for themselves.
    const { said } = await verifying("verify", fileHolding("card.json", validCard));

    expect(said).toMatch(/purchase_item/);
    expect(said).toMatch(/test/);
  });

  it("reports every finding of a card, pointing at the fields", async () => {
    const broken = { ...validCard, title: undefined, price: { amount: "5,00", currency: "USD" } };
    const { code, said } = await verifying("verify", fileHolding("card.json", broken));

    expect(said).toMatch(/title/);
    expect(said).toMatch(/price\.amount/);
    expect(code).toBe(VERIFY_EXIT.PROBLEMS);
  });

  it("checks every card it was given, not just the first that failed", async () => {
    // The portal promises a short edit cycle. A command that stopped at the
    // first bad card would turn one round of fixes into several.
    const { code, said } = await verifying(
      "verify",
      fileHolding("one.json", { ...validCard, result: {} }),
      fileHolding("two.json", { ...validCard, merchant_item_id: "esim-7d", fulfillment: "later" }),
    );

    expect(said).toMatch(/result/);
    expect(said).toMatch(/fulfillment/);
    expect(code).toBe(VERIFY_EXIT.PROBLEMS);
  });

  it("says a card file that is not JSON is a finding about that card", async () => {
    const { code, said } = await verifying("verify", fileHolding("card.json", "{not json at all"));

    expect(said).toMatch(/card\.json/);
    expect(said).toMatch(/JSON/);
    expect(code).toBe(VERIFY_EXIT.PROBLEMS);
  });

  it("warns that a card which failed its shape may have more findings behind it", async () => {
    // The checker stops before the rules that compare fields when the shape
    // itself is wrong, and a merchant reading a short list is entitled to
    // know a clean second run is not implied by it.
    const { said } = await verifying(
      "verify",
      fileHolding("card.json", { ...validCard, nonsense: 1 }),
    );

    expect(said).toMatch(/again/i);
  });

  it("stops rather than scolds when it is given no card files", async () => {
    // The documentation shows the bare command, and the bare command cannot
    // work: it would check the cards the merchant has already published, and
    // no call hands those back. That is a check that did not run — the same
    // answer as the idempotency half — and not a merchant who typed it wrong.
    const { code, said } = await verifying("verify");

    expect(said).toMatch(/no call returns a merchant's own published cards/);
    expect(said).toMatch(/Name the card files instead/);
    expect(code).toBe(VERIFY_EXIT.COULD_NOT_RUN);
  });

  it("says which file it could not find", async () => {
    const { code, said } = await verifying("verify", join(tmpdir(), "no-such-card-file.json"));

    expect(said).toMatch(/no-such-card-file\.json/);
    expect(code).toBe(VERIFY_EXIT.USAGE);
  });

  it("answers an unknown word with what it does know", async () => {
    const { code, said } = await verifying("publish", "card.json");

    expect(said).toMatch(/verify/);
    expect(code).toBe(VERIFY_EXIT.USAGE);
  });

  it("never answers with success while a check cannot be run", async () => {
    // The one answer a build must not receive from this command today. Zero
    // means every check passed, the idempotency run passes nothing because it
    // never happens, and a merchant wiring `coinslot verify` into their
    // pipeline would take a zero as a green light for both halves.
    const answers = await Promise.all([
      verifying("verify"),
      verifying("verify", fileHolding("good.json", validCard)),
      verifying("verify", fileHolding("bad.json", { ...validCard, result: {} })),
      verifying("verify", join(tmpdir(), "no-such-card-file.json")),
      verifying("publish"),
    ]);

    expect(answers.map((answer) => answer.code)).not.toContain(VERIFY_EXIT.PASSED);
  });
});
