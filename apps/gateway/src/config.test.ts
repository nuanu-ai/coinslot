import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const database = "postgres://coinslot:secret@localhost:5432/coinslot";

describe("loadConfig", () => {
  it("читает окружение и подставляет порт по умолчанию", () => {
    expect(loadConfig({ DATABASE_URL: database })).toStrictEqual({
      databaseUrl: database,
      port: 3000,
    });

    expect(loadConfig({ DATABASE_URL: database, PORT: "8080" }).port).toBe(8080);
  });

  it("не даёт стартовать, называет разом все проблемы и отличает пустое от неверного", () => {
    // Обещание инженеру: весь список недостающего он получает за один заход, а
    // не по одной переменной за перезапуск, и «не задана» звучит иначе, чем
    // «задана неправильно».
    const bothBroken = () => loadConfig({ PORT: "не число" });
    expect(bothBroken).toThrowError(/DATABASE_URL: переменная не задана/);
    expect(bothBroken).toThrowError(/PORT: должен быть целым числом/);

    expect(() => loadConfig({ DATABASE_URL: "mysql://localhost/coinslot" })).toThrowError(
      /DATABASE_URL: должна быть адресом вида postgres/,
    );
    expect(() => loadConfig({ DATABASE_URL: database, PORT: "70000" })).toThrowError(
      /PORT: должен быть в диапазоне/,
    );
  });
});
