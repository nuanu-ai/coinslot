/**
 * As much of `docker compose config --format json` as the preflight reads.
 *
 * Deliberately partial, and deliberately loose in the places Docker is loose:
 * an environment value can be absent, and a port entry may or may not name a
 * host interface. What it buys is that every read in `preflight.mjs` is a read
 * the compiler has seen, on a document nobody in this repository writes.
 */
export interface ResolvedCompose {
  readonly services: {
    readonly gateway: ResolvedService;
    readonly cabinet: ResolvedService;
    readonly web: ResolvedService;
    readonly postgres: ResolvedService;
  } & Record<string, ResolvedService | undefined>;
}

interface ResolvedService {
  readonly image?: string;
  environment?: Record<string, string | undefined>;
  ports?: readonly {
    readonly host_ip?: string;
    readonly mode?: string;
    readonly protocol?: string;
    readonly published?: string | number;
    readonly target?: number;
  }[];
}

/** Everything wrong with this configuration for this channel; empty is fit. */
export function problemsWith(channel: string, resolved: ResolvedCompose): string[];
