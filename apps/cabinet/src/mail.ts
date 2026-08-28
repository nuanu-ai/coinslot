/**
 * The two ways a message leaves the cabinet, and the one value that picks
 * between them.
 *
 * There are exactly two messages: a link that confirms an address, and a link
 * that replaces a forgotten password. Both are short, both are sent because
 * somebody just asked for them, and nothing here ever sends anything nobody
 * asked for.
 *
 * Which sender is in force is `MAIL_URL`, one variable with one value, the same
 * shape the gateway uses to pick its facilitator (`apps/gateway/src/config.ts`).
 * `sandbox:log` writes every message to the log with its recipient and its link,
 * so the whole flow walks on a laptop with no account, no domain and no network
 * — and a scheme nobody can reach means a typo is a refusal at start-up rather
 * than an address that quietly does not answer. Anything else is a provider,
 * which today means Resend.
 *
 * Nothing waits for delivery. A caller hands a message over and carries on:
 * ADR-0009 puts a working account in front of a delivered message on purpose,
 * because a mail filter between a merchant and their own cabinet is a merchant
 * who has to be rescued by a person at a terminal, which is the thing that
 * decision exists to stop needing. So a send that fails is a line in the log and
 * not an error on somebody's screen.
 */

/**
 * The address that means nothing is sent anywhere.
 *
 * A scheme rather than a word, so that it cannot be mistaken for a host that is
 * merely unreachable, and so that the configuration refuses it in the one place
 * a real address is expected.
 */
export const SANDBOX_MAIL = "sandbox:log";

/** Whether this cabinet writes its messages to the log instead of sending them. */
export const isSandboxMail = (mailUrl: string): boolean => mailUrl === SANDBOX_MAIL;

/** One message, already written, with nothing left to decide about it. */
export interface Message {
  readonly to: string;
  readonly subject: string;
  /** Plain text. Nothing the cabinet sends needs anything else. */
  readonly body: string;
}

/** How a message leaves, or is written down instead of leaving. */
export type Postman = (message: Message) => Promise<void>;

/** What a sender needs to know about itself. */
export interface MailConfig {
  /** `sandbox:log`, or the address of a provider. */
  readonly mailUrl: string;
  /** The credential the provider is called with, or nothing in the sandbox. */
  readonly mailApiKey: string | null;
  /** What the message says it is from. */
  readonly mailFrom: string;
}

/**
 * The sender this configuration asks for.
 *
 * One function either way, so nothing above this file has a branch in it about
 * whether mail is real here. That matters more than it looks: the cabinet's
 * whole flow — registering, confirming, losing a password — is the same code on
 * a laptop and on a server, and the only difference is where the link comes out.
 */
export function postmanFor(config: MailConfig): Postman {
  return isSandboxMail(config.mailUrl) ? toTheLog : throughResend(config);
}

/**
 * The sandbox sender: every message, whole, in the log.
 *
 * The link is printed as it stands rather than described, because the only
 * reason to read this is to follow it. Whoever is developing the cabinet copies
 * it out of their terminal, and that is the entire flow with no account
 * anywhere.
 */
const toTheLog: Postman = async (message) => {
  console.log(
    `[cabinet] no mail provider is configured, so this message was not sent.` +
      ` To: ${message.to}. Subject: ${message.subject}.\n${message.body}`,
  );
};

/**
 * The provider sender.
 *
 * One call, one JSON document, and no reading of what comes back beyond whether
 * it worked. Nothing in the cabinet receives mail — there is no inbox, no bounce
 * handler and no reply address that reaches anybody — so the answer to this call
 * is only ever a line in a log.
 *
 * A failure is caught here rather than thrown at the caller. Every send in this
 * cabinet happens beside something a person just did successfully: they
 * registered, or they asked for a link. Turning a provider's bad afternoon into
 * a red page on top of a registration that worked would tell them the wrong
 * thing about their own account.
 */
function throughResend(config: MailConfig): Postman {
  return async (message) => {
    try {
      const answered = await fetch(`${config.mailUrl}/emails`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.mailApiKey ?? ""}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: config.mailFrom,
          to: [message.to],
          subject: message.subject,
          text: message.body,
        }),
      });
      if (!answered.ok) {
        // The status and nothing else. What comes back can carry the address it
        // was refused for, and a log goes places the database does not.
        console.error(
          `[cabinet] a message to ${message.to} was refused by the mail provider (${answered.status})`,
        );
        return;
      }
    } catch (thrown) {
      // `String` and not the object: an exception from `fetch` prints its causes
      // too, and a request that failed mid-flight has the whole document it was
      // sending hanging off it — including the link, which is the one thing in
      // this file that must not be written down twice.
      console.error(`[cabinet] a message to ${message.to} could not be sent: ${String(thrown)}`);
    }
  };
}
