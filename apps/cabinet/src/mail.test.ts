/**
 * The two ways a message leaves the cabinet.
 *
 * Both are driven the way the cabinet drives them: one message in, and then the
 * question of where it came out. The provider is a real HTTP server on a
 * loopback port rather than a stubbed `fetch`, because what this file is about
 * is the document that goes over the wire and a stub cannot be wrong about it
 * in the way a real request can.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isSandboxMail, type Message, postmanFor, SANDBOX_MAIL } from "./mail.js";

const MESSAGE: Message = {
  to: "dmitry@example.com",
  subject: "A new password for your Coinslot account",
  body: "Open this to choose one:\n\n    https://coinslot.example.com/cabinet/password/new?token=abc\n",
};

/** Everything the process said while `during` ran. */
const logged = async (during: () => Promise<void>): Promise<string> => {
  const lines: string[] = [];
  const collect = (...parts: unknown[]) => lines.push(parts.map(String).join(" "));
  const log = vi.spyOn(console, "log").mockImplementation(collect);
  const error = vi.spyOn(console, "error").mockImplementation(collect);
  try {
    await during();
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  return lines.join("\n");
};

/** A provider on a loopback port, answering however the test says. */
interface Provider {
  readonly url: string;
  readonly asked: { path: string; authorization: string; body: string }[];
  close(): Promise<void>;
}

let running: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (running === null) {
      resolve();
      return;
    }
    running.close(() => resolve());
  });
  running = null;
});

const provider = async (status = 200): Promise<Provider> => {
  const asked: { path: string; authorization: string; body: string }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      asked.push({
        path: request.url ?? "",
        authorization: request.headers.authorization ?? "",
        body,
      });
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(status === 200 ? { id: "msg_1" } : { message: "no" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  running = server;
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    asked,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

describe("a cabinet with no mail provider", () => {
  it("writes the whole message down, with the address it was for and the link in it", async () => {
    // This is the entire flow on a laptop: whoever is developing the cabinet
    // reads the link out of their own terminal and follows it. A log line that
    // said a message had been sent, without saying where or what, would leave
    // them with a flow that cannot be walked at all.
    const postman = postmanFor({ mailUrl: SANDBOX_MAIL, mailApiKey: null, mailFrom: "x" });

    const said = await logged(async () => {
      // Taken, because the log is the only sink there is here: the message
      // reached everything a message can reach on a laptop, and a caller told
      // otherwise would hide the link from the one person who has to follow it.
      await expect(postman(MESSAGE)).resolves.toBe("accepted");
    });

    expect(said).toContain("dmitry@example.com");
    expect(said).toContain("https://coinslot.example.com/cabinet/password/new?token=abc");
    // And it says out loud that nothing was sent, so nobody reading this log
    // goes looking in a mailbox for it.
    expect(said).toMatch(/not sent|no mail provider/i);
  });

  it("is what the cabinet is in without a provider, and is told apart by name", () => {
    expect(isSandboxMail(SANDBOX_MAIL)).toBe(true);
    expect(isSandboxMail("https://api.resend.com")).toBe(false);
  });
});

describe("a cabinet with a mail provider", () => {
  it("sends one message, with the sender, the recipient and the text on it", async () => {
    const sending = await provider();
    const postman = postmanFor({
      mailUrl: sending.url,
      mailApiKey: "re_a_real_looking_key",
      mailFrom: "Coinslot <no-reply@mail.example.com>",
    });

    await postman(MESSAGE);

    expect(sending.asked).toHaveLength(1);
    const asked = sending.asked[0];
    expect(asked?.path).toBe("/emails");
    expect(asked?.authorization).toBe("Bearer re_a_real_looking_key");
    const document = JSON.parse(asked?.body ?? "{}") as {
      from: string;
      to: string[];
      subject: string;
      text: string;
    };
    expect(document.from).toBe("Coinslot <no-reply@mail.example.com>");
    expect(document.to).toStrictEqual(["dmitry@example.com"]);
    expect(document.subject).toBe(MESSAGE.subject);
    expect(document.text).toBe(MESSAGE.body);
  });

  it("says the provider took it, so the log can be read for an address that worked", async () => {
    // Written down as well as answered. The log is what a reader goes through
    // afterwards, and one that wrote down failures alone would leave them
    // unable to tell a message that went to the provider from one that was
    // never asked for at all.
    const sending = await provider();
    const postman = postmanFor({
      mailUrl: sending.url,
      mailApiKey: "re_a_real_looking_key",
      mailFrom: "Coinslot <no-reply@mail.example.com>",
    });

    const said = await logged(async () => {
      await expect(postman(MESSAGE)).resolves.toBe("accepted");
    });

    expect(said).toContain("dmitry@example.com");
    expect(said).not.toMatch(/refused|could not be sent/);
    // And not the link. A provider is in force here, so the one person who is
    // meant to hold it is the one who was sent it.
    expect(said).not.toContain("token=abc");
  });

  it("does not throw when the provider refuses, because somebody is mid-registration", async () => {
    // Every send in this cabinet happens beside something a person just did
    // successfully. A provider's bad afternoon must not become a red page on
    // top of a registration that worked, because that tells the person the
    // wrong thing about their own account.
    const sending = await provider(422);
    const postman = postmanFor({
      mailUrl: sending.url,
      mailApiKey: "re_a_real_looking_key",
      mailFrom: "Coinslot <no-reply@mail.example.com>",
    });

    const said = await logged(async () => {
      // Answered rather than thrown, and the answer is the one word a caller
      // can act on: nothing here reached anybody, so nothing above may say it
      // did.
      await expect(postman(MESSAGE)).resolves.toBe("refused");
    });

    expect(said).toContain("422");
    // And the refusal is the whole of what the log says about this message. A
    // second line beside it claiming the message went out is worse than no
    // line at all: it sends whoever is reading to a mailbox that will never
    // hold it.
    expect(said).not.toMatch(/handed to the mail provider|was sent/);
  });

  it("does not throw when nothing answers at all", async () => {
    // A port with nothing behind it, which is a provider that is down.
    const sending = await provider();
    await sending.close();
    const postman = postmanFor({
      mailUrl: sending.url,
      mailApiKey: "re_a_real_looking_key",
      mailFrom: "Coinslot <no-reply@mail.example.com>",
    });

    const said = await logged(async () => {
      await expect(postman(MESSAGE)).resolves.toBe("refused");
    });

    expect(said).toContain("could not be sent");
    // And the link is not written down a second time by the failure. It is the
    // one thing in the message that is worth something on its own, and an
    // exception from a request that failed mid-flight carries the whole
    // document it was sending.
    expect(said).not.toContain("token=abc");
  });
});
