# syntax=docker/dockerfile:1

FROM node:22-slim AS server-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client ./
COPY src/protocol /app/src/protocol
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
# Must match the fly.toml mount destination exactly.
ENV NEXUS_DATA_DIR=/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=server-build /app/dist ./dist
COPY --from=client-build /app/client/dist ./client/dist

# git is needed for repo-clone-on-create (plan phase-3c).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

EXPOSE 8080
CMD ["node", "dist/server/index.js"]
