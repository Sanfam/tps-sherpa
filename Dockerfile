# syntax=docker/dockerfile:1
#
# The bot's image: Node, the workspace's runtime dependencies, and Litestream,
# started through apps/bot/start.sh (ADR-0001, "Startup and restore").
#
# Railway builds this instead of Railpack because it sits at the repo root. A
# Railway start command overrides ENTRYPOINT, so the service sets it to the
# same thing explicitly: `sh /app/apps/bot/start.sh`. Anything else skips the
# restore and replication, and serve.ts refuses to start on Railway without
# start.sh's marker.
#
# The volume is still mounted at /app/apps/bot/.data, the app still runs from
# /app as `node apps/bot/src/serve.ts`, and Node 26 matches `engines`.

FROM node:26.11.1-trixie-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0 AS base

# Litestream 0.5.17's release tarballs, checked against its checksums.txt.
FROM base AS litestream-amd64
ADD --checksum=sha256:cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d \
  https://github.com/benbjohnson/litestream/releases/download/v0.5.17/litestream-0.5.17-linux-x86_64.tar.gz /tmp/litestream.tar.gz
FROM base AS litestream-arm64
ADD --checksum=sha256:f8ca4a050095c1efbda2c4365172e61bf9d955ea0d9ac42f448b52e51819baa5 \
  https://github.com/benbjohnson/litestream/releases/download/v0.5.17/litestream-0.5.17-linux-arm64.tar.gz /tmp/litestream.tar.gz

# Litestream is a static Go binary, but it needs CA certificates to reach R2,
# which a slim image may not carry. Only the bundle is copied out.
FROM litestream-${TARGETARCH} AS litestream
RUN tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin litestream \
  && apt-get update && apt-get install -y --no-install-recommends ca-certificates

FROM base
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/bot/package.json apps/bot/
# Runtime dependencies only: Node runs the TypeScript itself, and typescript,
# vitest and the type packages are for development.
RUN npm ci --omit=dev
COPY . .
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY --from=litestream /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
ENTRYPOINT ["sh", "/app/apps/bot/start.sh"]
