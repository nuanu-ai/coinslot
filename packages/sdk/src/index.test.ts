import { readFileSync } from "node:fs";
import { CONTRACT_VERSION } from "@coinslot/contracts";
import { describe, expect, it } from "vitest";
import { contractVersion, speaksContract } from "./index.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies?: Record<string, string>;
};

describe("@coinslot/sdk", () => {
  it("сверяет версию контракта и отказывает чужой", () => {
    // Обещание мерчанту: расхождение диалектов обнаруживается на старте
    // воркера, а не на заказе, где оно стоит денег покупателя.
    expect(contractVersion).toBe(CONTRACT_VERSION);
    expect(speaksContract(CONTRACT_VERSION)).toBe(true);
    expect(speaksContract(`${CONTRACT_VERSION}-чужая`)).toBe(false);
  });

  it("не тянет ни одной сторонней runtime-зависимости", () => {
    // Жёсткое правило ADR-0003, п. 8. Упавшая проверка означает, что мерчант
    // вместе с SDK поставил себе в продакшен чужой пакет, и каждое такое
    // исключение обязано быть отдельным записанным решением.
    const thirdParty = Object.entries(manifest.dependencies ?? {}).filter(
      ([, range]) => !range.startsWith("workspace:"),
    );

    expect(thirdParty).toStrictEqual([]);
  });
});
