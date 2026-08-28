# The image four of compose.yaml's services run from: the gateway, the cabinet,
# the mock merchant, and the migration that runs to completion before them.
#
# One image rather than four, because they are four entry points into one
# workspace and share every dependency below their own file. Which of them a
# container is decides at `command`, not at build time — an image per service
# would be the same layers four times and one more thing to keep in step.
#
# There is no compile step. Node runs the TypeScript through tsx, the way
# `pnpm --filter @coinslot/gateway start` does on a laptop (ADR-0003 §1), so
# what runs in the container is the same source a developer edits and there is
# no build output to be stale.

FROM node:24-alpine

# The version is pinned so the install inside the image is the install the
# lockfile was written by. corepack would otherwise read it out of the root
# package.json, which is not in the context yet when the fetch below runs.
#
# COREPACK_HOME is set away from the home directory for a reason found by
# running it: corepack caches the package manager it downloads under the home
# of whoever ran it, so a pnpm fetched here as root is invisible to the `node`
# user the container runs as — and every container start went back to the
# network for it. A shared, world-readable cache makes the image self-contained,
# which is what "comes up with no network" has to mean.
ENV COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable \
  && corepack prepare pnpm@10.33.3 --activate \
  && chmod -R a+rX "${COREPACK_HOME}"

WORKDIR /app

# The dependencies first, off the lockfile alone: `pnpm fetch` reads no
# manifests, so this layer survives every edit to the source below it and is
# rebuilt only when the lockfile moves.
COPY pnpm-lock.yaml ./
RUN pnpm fetch

COPY . .
RUN pnpm install --frozen-lockfile --offline

# Not root. Two of the four are reached from outside through Caddy, and none of
# them has any reason to be able to write to its own source.
USER node

# Overridden by compose; named here so the image is runnable on its own.
CMD ["pnpm", "--filter", "@coinslot/gateway", "start"]
