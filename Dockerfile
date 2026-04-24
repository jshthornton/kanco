FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# --- deps: install all workspace deps including native compile tools ---
FROM base AS deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile=false

# --- build: typecheck, build web into apps/server/public, bundle server ---
FROM deps AS build
COPY . .
RUN pnpm --filter @kanco/web run build
RUN pnpm --filter @kanco/server run build

# --- runtime: slim image, only prod deps, pre-built better-sqlite3 ---
FROM base AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY packages/shared ./packages/shared
RUN pnpm install --prod --frozen-lockfile=false --filter @kanco/server...
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/public ./apps/server/public

# The default kanco GitHub App client id is baked into the code. Override at
# build or run time with KANCO_GH_CLIENT_ID to point at a different App (e.g.
# a fork's). The client id is public; device flow needs no client secret.
ARG KANCO_GH_CLIENT_ID=""
ENV KANCO_GH_CLIENT_ID=${KANCO_GH_CLIENT_ID}

ENV NODE_ENV=production
ENV KANCO_DATA_DIR=/data
ENV KANCO_STATIC_DIR=/app/apps/server/public
ENV KANCO_PORT=8787
ENV KANCO_HOST=0.0.0.0

VOLUME ["/data"]
EXPOSE 8787
WORKDIR /app/apps/server
CMD ["node", "dist/index.js"]
