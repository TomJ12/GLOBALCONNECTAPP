# Global Connect DEMO server: the client web app, the API and the ops console
# from ONE Node process on ONE port, exactly as `npm run demo` runs them.
# Mock providers and sample data. This is not a production image: outside
# development mode the server refuses to start (see README).
#
# Node 22 LTS: the server needs 22.13 or newer (built-in SQLite).

# --- 1. Build the web app, pointed at "/" (the same origin as the API) --------
FROM node:22-bookworm-slim AS web
WORKDIR /build
COPY package.json package-lock.json ./
# (--ignore-scripts: the root package has a postinstall that installs the server package, which is stage 2.)
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY app.json tsconfig.json metro.config.js ./
COPY assets ./assets
COPY src ./src
ENV EXPO_PUBLIC_API_URL=/ EXPO_NO_TELEMETRY=1 CI=1
RUN npx expo export -p web --output-dir dist-demo

# --- 2. The server's own dependencies (tsx runs the TypeScript directly) -------
FROM node:22-bookworm-slim AS deps
WORKDIR /build/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# --- 3. The image that runs ----------------------------------------------------
FROM node:22-bookworm-slim
# Not NODE_ENV=production: the demo runs with APP_ENV=development, and the server refuses that combination.
ENV APP_ENV=development \
    HOST=0.0.0.0 \
    PORT=8080 \
    WEB_DIR=/app/dist-demo \
    DATABASE_PATH=/data/globalconnect.sqlite \
    NODE_NO_WARNINGS=1
WORKDIR /app
COPY --from=deps /build/server/node_modules ./server/node_modules
# The server shares code with the app (the neutral types, schemas, money arithmetic and the provider-shaped
# mock under src/); those files find zod and big.js through this link.
RUN ln -s /app/server/node_modules /app/node_modules
COPY server/package.json server/tsconfig.json ./server/
COPY server/src ./server/src
COPY src ./src
COPY --from=web /build/dist-demo ./dist-demo
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY scripts/gc /usr/local/bin/gc
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh /usr/local/bin/gc \
 && mkdir -p /data && chown node:node /data
WORKDIR /app/server
EXPOSE 8080
# The entrypoint only makes the data volume writable by the unprivileged user,
# then drops to that user (uid 1000, "node") for good: the server never runs as root.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "tsx", "src/index.ts"]
