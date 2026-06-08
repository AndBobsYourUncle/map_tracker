# syntax=docker/dockerfile:1

# Production image for the self-hosted map tracker. Uses Next.js standalone
# output (see next.config.ts) so the runtime image carries only the server
# bundle + its traced deps. Map data is NOT baked in — it's read at runtime from
# /data, which is a mounted volume (see compose.yaml).

# ---- deps: install all deps against the lockfile ----
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder: produce the standalone build ----
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- runner: minimal runtime ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Map data lives on a mounted volume, separate from the immutable image.
ENV MAP_TRACKER_DATA_DIR=/data
# Bind to all interfaces inside the container.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# public/ is tiny now (no maps); .next/standalone is the server, .next/static
# the client assets the standalone server expects alongside it.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Data dir mount point, owned by the runtime user.
RUN mkdir -p /data && chown nextjs:nodejs /data
VOLUME ["/data"]

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
