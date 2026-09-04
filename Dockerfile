FROM node:20-alpine AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
# Keep npm's download cache in BuildKit between deployments. The AWS SDK makes
# a cold install relatively large, and Orchard can otherwise mark the builder
# unhealthy while npm is still downloading packages.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund --prefer-offline

FROM node:20-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node views ./views
COPY --chown=node:node public ./public

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"

CMD ["node", "src/server.js"]
