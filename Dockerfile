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
COPY client/package.json ./client/
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY tsconfig.base.json tsconfig.json tsconfig.build.json ./
COPY packages ./packages
COPY src ./src
COPY client ./client
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
COPY client/package.json ./client/
# Installs the full workspace minus devDependencies. That pulls in the web
# app's runtime deps, which the server never loads — a few MB of image for a
# correctly linked workspace. Trading size for a symlink that provably exists.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/dist ./dist
# The symlink installed above points here. Without this the link dangles.
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/client/dist ./client/dist

# git is needed for repo-clone-on-create (plan phase-3c).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

EXPOSE 8080
CMD ["node", "dist/server/index.js"]
