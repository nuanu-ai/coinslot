import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTRACT_VERSION } from "./index.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies?: Record<string, string>;
};

describe("@coinslot/contracts", () => {
  it("объявляет версию контракта и держит zod единственной runtime-зависимостью", () => {
    // Версия — то, по чему SDK мерчанта и гейтвей понимают, что говорят об
    // одном и том же. Пустая строка означала бы «версии нет», а молчаливого
    // отсутствия версии в контракте быть не должно.
    expect(CONTRACT_VERSION).not.toBe("");

    // Contracts — единственный пакет, который SDK тянет за собой, поэтому его
    // дерево зависимостей и есть дерево зависимостей SDK (ADR-0003 п. 8).
    // Упавшая проверка означает, что мерчант при установке получил лишнее.
    expect(Object.keys(manifest.dependencies ?? {})).toStrictEqual(["zod"]);
  });
});
