FROM node:26-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# CI pre-builds dist/ before docker build. The dashboard build reads repo-root
# files that are outside the dashboard/ Docker context, so require the artifact.
RUN if [ ! -d dist/server ]; then \
      echo "[dashboard] Missing pre-built dist/server artifact."; \
      echo "[dashboard] Run npm --prefix dashboard run build from the repository root before docker build."; \
      exit 1; \
    fi && \
    echo "Using pre-built dist" && \
    npm run verify:server-entry

# ── Production image ──────────────────────────────────────────
FROM node:26-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

# Copy built frontend + server
COPY --from=builder /app/dist ./dist

# Copy public assets (furniture sprites, PNGs, default layout)
COPY --from=builder /app/public ./public

EXPOSE 3001

CMD ["node", "dist/server/dashboard/server/index.js"]
