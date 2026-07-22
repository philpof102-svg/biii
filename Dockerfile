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

# BIII_MERCHANT (the merchant's own Base address) MUST be set at runtime — non-custodial, one merchant per deploy.
CMD ["node", "lib/server.js"]
