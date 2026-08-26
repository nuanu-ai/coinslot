import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const database = "postgres://coinslot:secret@localhost:5432/coinslot";

describe("loadConfig", () => {
  it("reads the environment and fills in the default port", () => {
    expect(loadConfig({ DATABASE_URL: database })).toStrictEqual({
      databaseUrl: database,
      port: 3000,
    });

    expect(loadConfig({ DATABASE_URL: database, PORT: "8080" }).port).toBe(8080);
  });

  it("does not let it start, names every problem at once and tells absent from wrong", () => {
    // The promise to the engineer: the whole list of what is missing arrives in
    // one go rather than one variable per restart, and "not set" sounds
    // different from "set wrong".
    const bothBroken = () => loadConfig({ PORT: "not a number" });
    expect(bothBroken).toThrowError(/DATABASE_URL: the variable is not set/);
    expect(bothBroken).toThrowError(/PORT: must be a whole number/);

    expect(() => loadConfig({ DATABASE_URL: "mysql://localhost/coinslot" })).toThrowError(
      /DATABASE_URL: must be an address of the form postgres/,
    );
    expect(() => loadConfig({ DATABASE_URL: database, PORT: "70000" })).toThrowError(
      /PORT: must be within the range/,
    );
  });
});
