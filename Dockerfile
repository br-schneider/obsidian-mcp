# ── Build stage ────────────────────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-slim
# Run as UID 1000 to match the headless sync container's default PUID.
# This ensures both containers can read/write the shared vault volume.
# node:20-slim already has a 'node' user at UID 1000, so we reuse it.
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json .
RUN chown -R node:node /app
USER node
EXPOSE 3456
CMD ["node", "dist/index.js"]
