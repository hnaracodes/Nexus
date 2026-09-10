# syntax=docker/dockerfile:1

# One install for the whole workspace. The protocol extraction unified the two
# lockfiles into one, so this is the only place dependencies resolve.
# Every workspace's package.json must be COPYed before `npm ci`, or npm cannot
# create the node_modules/@nexus/protocol symlink — the install would succeed
# and the server would then fail at boot on an unresolvable import.
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json ./packages/protocol/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
# @nexus/protocol first, explicitly. Both the server build and the client build
# resolve it out of node_modules, and a stale or missing protocol dist is
# exactly the "green suite that does not compile" failure mode CLAUDE.md
# records as having reached production once already.
RUN npm run protocol:build \
  && npm run build \
  && npm run build:client

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
# Must match the fly.toml mount destination exactly.
ENV NEXUS_DATA_DIR=/data
# Per-room clones live on the persistent volume too (plan phase-6): a room
# recovered after a restart must still have its working directory, or its link
# resolves to an agent with nothing to work on.
ENV NEXUS_WORKDIR=/data/work

COPY package.json package-lock.json ./
COPY packages/protocol/package.json ./packages/protocol/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
# Installs ONLY the workspaces the server actually needs, minus devDependencies.
#
# This used to install the whole workspace, with a comment explaining that a
# filtered `--workspace=` install risks the @nexus/protocol symlink not being
# created — "a server that fails at boot on an unresolvable import costs more
# than 7% of an image. Revisit only with the smoke test in hand."
#
# That caution was right to demand evidence, and the evidence now exists. Built
# both variants and ran `scripts/smoke-ws.mjs` against each:
#   full install: 841 MB image, 262 MB node_modules, SMOKE OK
#   filtered:     782 MB image, 210 MB node_modules, SMOKE OK
# and checked the exact thing the warning named — `node_modules/@nexus/protocol`
# is a live symlink to `../../packages/protocol` with its `dist/` populated, the
# server boots ("nexus listening on :8080"), and the SPA still serves its real
# hashed bundle.
#
# What goes away is the web app's runtime deps, which Vite has already bundled
# into `apps/web/dist` and the server never imports: lucide-react (41 MB),
# react-dom and @codemirror. `--include-workspace-root` keeps the root deps and
# `--workspace @nexus/protocol` is what keeps the symlink real.
RUN npm ci --omit=dev --ignore-scripts \
  --workspace @nexus/server --workspace @nexus/protocol --include-workspace-root \
  && npm cache clean --force

# The workspace layout is preserved on purpose. The server resolves the web
# bundle as `../../../web/dist` relative to its own module URL, so apps/server
# and apps/web must sit beside each other here exactly as they do in the repo.
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
# The @nexus/protocol symlink installed above points here. Without this it dangles.
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist

# git is needed for repo-clone-on-create (plan phase-3c).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

EXPOSE 8080
CMD ["node", "apps/server/dist/server/index.js"]
