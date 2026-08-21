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
COPY package.json yarn.lock ./
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

# Build adminizer UI modules consumed from /dashboard/modules/*.
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

# Source comes from the build context (which excludes node_modules); take only the generated UI
# from builder. The final image therefore receives exactly one dependency graph, below.
COPY . .
COPY --from=builder /app/dist ./dist
COPY --from=focus_production /app/node_modules ./node_modules

# Fail the build, not the dashboard, if that ever happens again. The entry name is
# content-hashed, so it is read from the manifest the panel itself reads — never spelled
# out here, or a rename silently turns this guard into an ENOENT.
RUN node -e "const fs=require('fs'),p='/app/node_modules/adminizer/assets';\
const entry=JSON.parse(fs.readFileSync(p+'/manifest.json','utf8'))['src/assets/js/app.tsx'];\
if(!entry||!entry.file){console.error('adminizer assets: no app entry in manifest.json');process.exit(1);}\
const app=fs.readFileSync(p+'/'+entry.file,'utf8');\
const missing=[...new Set(app.match(/\.\/[A-Za-z0-9_-]+\.js/g)||[])].map(m=>m.slice(2)).filter(f=>!fs.existsSync(p+'/'+f));\
if(missing.length){console.error('adminizer '+entry.file+' references missing chunks: '+missing.join(', '));process.exit(1);}\
console.log('adminizer assets: '+entry.file+' chunks resolved');"

RUN chmod +x /app/bootstrap.sh

EXPOSE 17280
CMD ["/bin/sh", "/app/bootstrap.sh"]
