# syntax=docker/dockerfile:1

# ---- Base -------------------------------------------------------------
# Shared base for all stages: pin the exact Node 20 LTS patch + Alpine
# release and set a consistent workdir. NODE_ENV is intentionally NOT set
# here — it's set per-stage below, since the build stage needs devDependencies
# (tsc, eslint, jest) regardless of the runtime NODE_ENV.
FROM node:20.20-alpine3.22 AS base
WORKDIR /app

# ---- Dependencies (prod only, cached layer) ----------------------------
# package-lock.json is committed and kept in sync with package.json, so
# `npm ci` (which requires a lockfile in sync with package.json and installs
# exactly what's locked) is used instead of `npm install`.
FROM base AS deps
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- Build --------------------------------------------------------------
# Separate stage with devDependencies so tsc/eslint/jest are available for
# the build, but never ship into the final image. NODE_ENV is left unset
# (defaults to development-equivalent) so `npm ci` installs devDependencies.
FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- Development (live-reload) -----------------------------------------
# `docker compose up` targets this stage for local dev: bind-mounts src/
# over the image and runs tsx watch for live reload without a host Node
# install.
FROM base AS development
ENV NODE_ENV=development
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev"]

# ---- Production ---------------------------------------------------------
FROM base AS production
ENV NODE_ENV=production

# Run as a non-root user rather than the image default root.
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/server.js"]
