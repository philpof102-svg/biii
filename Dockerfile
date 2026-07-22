# BIII — the non-custodial USDC till, self-contained. Serves the merchant PWA + the REST API (lib/server.js).
# Pinned + reproducible: no build step, no native deps, trust-core is vendored (vendor/trust-core), so this
# image builds from the repo alone — no sibling checkout, no network beyond npm.
FROM node:20-slim

WORKDIR /app

# install deps first (layer cache). trust-core is a file: dep under vendor/, so it must be present for `npm ci`.
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --omit=dev

# app code
COPY . .

# the server reads PORT from the env (Railway/most PaaS inject it); 4700 is the local default.
ENV PORT=4700
EXPOSE 4700

# x402 anti-replay store: persist the consumed-payment set so "one payment = one verdict" survives
# redeploys. Attach a **Railway Volume** mounted at /data (dashboard/CLI) — Railway rejects the Docker
# VOLUME instruction, so we only prepare the dir + point the store at it. Without a mounted volume the
# store lives in the container and resets on deploy; freshness still caps replay to ~30 min.
RUN mkdir -p /data
ENV BIII_X402_CONSUMED=/data/x402-consumed.json

# BIII_MERCHANT (the merchant's own Base address) MUST be set at runtime — non-custodial, one merchant per deploy.
# To SELL verdicts via x402, BIII_MERCHANT is the payTo; set BIII_VET_PRICE_USD to price a call (default 0.002).
CMD ["node", "lib/server.js"]
