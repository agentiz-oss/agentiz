# syntax=docker/dockerfile:1.7
ARG NODE_ENV=production
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown

# Stage 1: Install dependencies from registry (no local_modules)
FROM node:20-alpine AS deps
WORKDIR /app

# Fallback for builders that cannot pass --secret; prefer the secret mount.
ARG GITHUB_NPM_TOKEN=""
# Some networks advertise AAAA records without an IPv6 route; the default
# 250ms happy-eyeballs budget then drops installs onto the unreachable family.
ENV NODE_OPTIONS=--network-family-autoselection-attempt-timeout=5000

RUN corepack enable && corepack prepare yarn@4.14.1 --activate
COPY package.json ./
# patches referenced from package.json > resolutions, must be in place before install
COPY .yarn/patches ./.yarn/patches
RUN set -eu; \
    printf 'nodeLinker: node-modules\n' > .yarnrc.yml; \
    printf 'npmScopes:\n  nodeknit:\n    npmRegistryServer: "https://npm.pkg.github.com"\n    npmAlwaysAuth: true\n' >> .yarnrc.yml; \
    sed -r -i 's#"(@nodeknit/[^"]+)":\s*"file:\./local_modules/[^"]+"#"\1": "commit"#g' package.json

# The auth token is appended for the duration of the install only, so it never
# lands in an image layer.
RUN --mount=type=secret,id=github_npm_token set -eu; \
    token="${GITHUB_NPM_TOKEN}"; \
    if [ -z "$token" ] && [ -r /run/secrets/github_npm_token ]; then \
        token="$(cat /run/secrets/github_npm_token)"; \
    fi; \
    [ -n "$token" ] || { echo "github_npm_token is required to install @nodeknit/* packages" >&2; exit 1; }; \
    cp .yarnrc.yml .yarnrc.noauth.yml; \
    printf 'npmRegistries:\n  "https://npm.pkg.github.com":\n    npmAuthToken: "%s"\n' "$token" >> .yarnrc.yml; \
    yarn workspaces focus; \
    mv .yarnrc.noauth.yml .yarnrc.yml

# Stage 2: Build the application
FROM deps AS builder
WORKDIR /app
ARG NODE_ENV
ENV NODE_ENV=${NODE_ENV}
COPY . .
COPY --from=deps /app/package.json ./package.json
COPY --from=deps /app/.yarnrc.yml ./.yarnrc.yml

# Build adminizer UI modules consumed from /dashboard/modules/*
RUN npm run build:vite \
    && test -f /app/dist/modules/AgentizHome.js


# Stage 3: Only prod modules
FROM deps AS focus_production
WORKDIR /app
RUN --mount=type=secret,id=github_npm_token set -eu; \
    token="${GITHUB_NPM_TOKEN}"; \
    if [ -z "$token" ] && [ -r /run/secrets/github_npm_token ]; then \
        token="$(cat /run/secrets/github_npm_token)"; \
    fi; \
    cp .yarnrc.yml .yarnrc.noauth.yml; \
    printf 'npmRegistries:\n  "https://npm.pkg.github.com":\n    npmAuthToken: "%s"\n' "$token" >> .yarnrc.yml; \
    yarn workspaces focus --all --production; \
    mv .yarnrc.noauth.yml .yarnrc.yml; \
    test -d /app/node_modules

# Stage 4: Final runtime image
FROM node:20-alpine AS release
WORKDIR /app

# See the `deps` stage; this is a fresh FROM, so it does not inherit that ENV.
ENV NODE_OPTIONS=--network-family-autoselection-attempt-timeout=5000

RUN apk add --no-cache python3
RUN npm install -g tsx pm2

ARG NODE_ENV
ARG GIT_SHA
ARG BUILD_TIME
ENV NODE_ENV=${NODE_ENV}
ENV GIT_SHA=${GIT_SHA}
ENV BUILD_TIME=${BUILD_TIME}

COPY --from=builder /app .
COPY --from=focus_production /app/node_modules ./node_modules

RUN chmod +x /app/bootstrap.sh

EXPOSE 17280
CMD ["/bin/sh", "/app/bootstrap.sh"]
