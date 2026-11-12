# syntax=docker/dockerfile:1

# ---- deps: full dependency tree (dev included), cached on package*.json ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# ---- test: sources + dev dependencies; used by docker-compose.test.yml ----
FROM deps AS test
COPY . .
CMD ["npm", "run", "test:integration"]

# ---- build: compile TypeScript to dist/ ----
FROM test AS build
RUN npm run build

# ---- prod-deps: runtime dependencies only ----
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
  && npm cache clean --force

# ---- runtime: small image, non-root user ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json openapi.yaml ./
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
