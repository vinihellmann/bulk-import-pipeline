# syntax=docker/dockerfile:1

# Single base image for every stage. Pinned to an exact patch + alpine release.
# Maintainers: pin by digest (node:22.23-alpine@sha256:...); Dependabot's
# "docker" ecosystem keeps the tag and digest up to date.
ARG NODE_IMAGE=node:22.23-alpine

# ---- deps: full dependency tree (dev included), cached on package*.json ----
# Dev install keeps lifecycle scripts: @swc/core and esbuild (dev-only) have install scripts.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

# ---- test: sources + dev dependencies; used by docker-compose.test.yml ----
FROM deps AS test
COPY . .
CMD ["npm", "run", "test:integration"]

# ---- build: compile TypeScript to dist/ ----
FROM test AS build
RUN npm run build

# ---- prod-deps: runtime dependencies only ----
# No production dependency relies on install scripts, so they are disabled (supply-chain hardening).
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts

# ---- runtime: small image, non-root user ----
FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="bulk-import-pipeline" \
      org.opencontainers.image.description="Streaming bulk import pipeline for product catalogs (API + worker)" \
      org.opencontainers.image.source="https://github.com/vinihellmann/bulk-import-pipeline" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production
# tini as PID 1: forwards signals and reaps zombies, also when compose overrides `command`.
# The runtime only executes `node dist/...`: drop the package managers bundled with the base
# image (npm, npx, corepack, yarn). Their own dependency trees are where most image CVEs live,
# and a shell-less attacker gains nothing from them either.
RUN apk add --no-cache tini \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app
# Files stay root-owned and read-only for the unprivileged user: the app writes nothing to disk.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json openapi.yaml ./
USER node
EXPOSE 3000
# Liveness probe for the API. Worker and migrate containers expose no HTTP port and
# must disable it in compose (`healthcheck: { disable: true }`).
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
