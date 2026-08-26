import { defineConfig } from "vitest/config";

/**
 * Один конфиг на весь workspace: тесты лежат рядом с кодом, отдельных
 * проектов на пакет не заводим, пока это не понадобится по-настоящему.
 *
 * `pnpm test` обязан быть бесплатным, детерминированным и работать без сети.
 * Всё, что трогает чейн, фасилитатор или живой API мерчанта, живёт в отдельной
 * команде smoke с потолком расхода и сюда не попадает.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    passWithNoTests: false,
  },
});
