# The image both resident processes run from: the gateway and the cabinet.
#
# One image rather than two, because they are two entry points into one
# workspace and share every dependency below their own file. Which of them a
# container is decides at `command`, not at build time — an image per app would
# be the same layers twice and one more thing to keep in step.
#
# There is no compile step. Node runs the TypeScript through tsx, the way
# `pnpm --filter @coinslot/gateway start` does on a laptop (ADR-0003 §1), so
# what runs in the container is the same source a developer edits and there is
# no build output to be stale.

FROM node:24-alpine

# The version is pinned so the install inside the image is the install the
# lockfile was written by. corepack would otherwise read it out of the root
# package.json, which is not in the context yet when the fetch below runs.
RUN corepack enable && corepack prepare pnpm@10.33.3 --activate

WORKDIR /app

# The dependencies first, off the lockfile alone: `pnpm fetch` reads no
# manifests, so this layer survives every edit to the source below it and is
# rebuilt only when the lockfile moves.
COPY pnpm-lock.yaml ./
RUN pnpm fetch

COPY . .
RUN pnpm install --frozen-lockfile --offline

# Not root. The process serves requests from outside and has no reason to be
# able to write to its own source.
USER node

# Overridden by compose; named here so the image is runnable on its own.
CMD ["pnpm", "--filter", "@coinslot/gateway", "start"]
