# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# IFMS production image
#
# Replaces the platform's automatic Nixpacks build. That build pins npm 9 and an
# image the project does not control, and it failed to produce a working build
# while the identical source built cleanly on Node 24 with npm 11. Pinning the
# toolchain here makes the build reproducible: the image that runs in production
# is byte-for-byte the one that can be rebuilt and debugged locally.
#
# Multi-stage so the runtime image carries no build toolchain and no source.
# ---------------------------------------------------------------------------

# --- Stage 1: dependencies --------------------------------------------------
FROM node:24-bookworm-slim AS deps

# Prisma's query engine is linked against OpenSSL. Git, because the WhatsApp
# library's signal dependency is published as a GitHub repository.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copied alone so this layer is only rebuilt when the manifests change.
COPY package.json package-lock.json ./

# `npm ci` installs exactly what the lockfile pins. Build-time packages live in
# `dependencies` rather than `devDependencies` precisely so this stays correct
# regardless of how the platform sets NODE_ENV.
RUN npm ci --no-audit --no-fund


# --- Stage 2: build ---------------------------------------------------------
FROM node:24-bookworm-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The build needs a connection string only to decide which Prisma provider to
# generate — it never connects. A placeholder keeps the image buildable without
# the real credentials; the runtime configuration is validated separately, and
# refuses to start without a genuine DATABASE_URL.
ARG DATABASE_URL="postgresql://placeholder:placeholder@build-time-only:5432/placeholder"
ENV DATABASE_URL=$DATABASE_URL

# Satisfies the environment schema during the build. The real secret is supplied
# at runtime and is never baked into the image.
ENV AUTH_SECRET="build-time-placeholder-secret-replaced-at-runtime"
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build


# --- Stage 3: runtime -------------------------------------------------------
FROM node:24-bookworm-slim AS runner

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

# Run unprivileged. The image already ships a `node` user.
RUN mkdir -p /app/storage/backups /app/storage/logs && chown -R node:node /app

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/.next ./.next
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/package.json ./package.json
# Prisma schema and the seeder are needed at start: the deploy command applies
# the schema and provisions the administrator before the server accepts traffic.
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/scripts ./scripts
COPY --from=builder --chown=node:node /app/src ./src
COPY --from=builder --chown=node:node /app/tsconfig.json ./tsconfig.json

USER node

EXPOSE 3000

CMD ["npm", "run", "deploy:start"]
