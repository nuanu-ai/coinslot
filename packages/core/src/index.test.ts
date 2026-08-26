import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertNever } from "./index.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies?: Record<string, string>;
};

describe("@coinslot/core", () => {
  it("останавливает работу на необработанном варианте и называет его", () => {
    // Обманываем типы ровно так, как это делает жизнь: значение приехало из
    // базы, а разбор про него не знает. Обещание ядра — заметный отказ вместо
    // тихого продолжения с заказом, который никто не обработал.
    const fromDatabase = "refunded" as never;

    expect(() => assertNever(fromDatabase, "статус заказа")).toThrowError(/статус заказа/);
    expect(() => assertNever(fromDatabase, "статус заказа")).toThrowError(/refunded/);
  });

  it("не тянет ни одной runtime-зависимости", () => {
    // Ядро — чистая логика: его можно исполнить в тесте, в скрипте и в чужом
    // окружении без установки чего бы то ни было (ADR-0003, п. 2).
    expect(manifest.dependencies ?? {}).toStrictEqual({});
  });
});
