# Coinslot

The gateway through which a classic online store sells its goods to AI agents
for stablecoins over the x402 protocol. What it is and why — `docs/vision.md`.

The stage is stage 0 of the pilot plan (`docs/research/21-pilot-plan.md`): the
monorepo scaffold is up, next come contracts as code and the order state
machine.

- Decisions taken — `docs/decisions/` (catalog exposure, integration model,
  stack)
- Research working materials — `docs/research/`
- Documentation for the stores that are integrating — `portal/` (a separate
  project: `cd portal && pnpm install && pnpm docs:dev`)
- Code — `packages/` (contracts, core, sdk) and `apps/gateway`. Checks:
  `pnpm install`, then `pnpm check`, `pnpm typecheck`, `pnpm test`,
  `pnpm check:decisions`
