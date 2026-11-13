# syntax=docker/dockerfile:1
# cp0x Swap: build the static app, then serve it with nginx (docker/nginx.conf).
#
#   docker build -t cp0x/pi-swap-interface:local .
#   docker run --rm -p 127.0.0.1:8080:8080 -v "$PWD/config:/config:ro" cp0x/pi-swap-interface:local
#
# Base images are pinned by tag and digest so a rebuild of the same commit uses the same toolchain.

# Build stage. The output is static files, so it runs on the build host's platform even for multi-arch images.
FROM --platform=$BUILDPLATFORM node:22.23.4-alpine3.24@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS build
WORKDIR /app
# The pnpm version in package.json "packageManager".
RUN npm install -g pnpm@10.30.2
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# Optional build-time config (JSON, the same shape as runtime-config.json). Public values only: it ends up in the bundle.
ARG VITE_SWAP_CONFIG=""
ENV VITE_SWAP_CONFIG=${VITE_SWAP_CONFIG}
RUN pnpm build

# Runtime stage: nginx and the files, nothing else.
FROM nginx:1.30.6-alpine3.24@sha256:583b7f2fce1cdb8da5ad5c39ebd3c33b98b87d493190e548bdee1fa8c619c311
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY docker/security-headers.conf /etc/nginx/cp0x/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/nginx/html/
# /config is where runtime-config.json is mounted (read-only). If it is empty, the app uses its defaults.
RUN mkdir -p /config && rm -f /etc/nginx/conf.d/default.conf
USER nginx
RUN nginx -t
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
CMD ["nginx", "-g", "daemon off;"]
