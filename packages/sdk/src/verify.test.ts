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

  it("asks for the card files rather than guessing where a merchant keeps them", async () => {
    // Nothing in this package or in the contract says where a merchant's
    // cards live, and a command that searched for them would be inventing a
    // convention nobody agreed to.
    const { code, said } = await verifying("verify");

    expect(said).toMatch(/card/i);
    expect(code).toBe(VERIFY_EXIT.USAGE);
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

  it("keeps its four answers apart", async () => {
    // A caller wiring this into their build branches on the number, so the
    // four must never collide.
    expect(new Set(Object.values(VERIFY_EXIT)).size).toBe(4);
    expect(VERIFY_EXIT.PASSED).toBe(0);
  });
});
