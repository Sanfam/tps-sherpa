# syntax=docker/dockerfile:1
#
# The site's image. Build from the repo root, so the root lockfile applies:
#   docker build -f apps/site/Dockerfile --build-arg BETTER_AUTH_URL=https://sherpa.omgod.com .
# On Railway, point the site service at this file (RAILWAY_DOCKERFILE_PATH);
# the root Dockerfile builds the bot. The site starts through apps/site/start.sh,
# which restores and replicates EmDash's database; a Railway start command
# overrides ENTRYPOINT, so leave it unset or set it to `sh /app/apps/site/start.sh`
# (docs/runbook.md, "The site's database").
#
# The session database defaults to apps/site/.data/sessions.db, under the
# working directory npm gives the workspace: mount the volume at
# /app/apps/site/.data, or set SITE_SESSION_DB. EmDash's database and uploads
# go in .data too, unless SITE_EMDASH_DIR names another directory: its path is
# fixed at build time, so it is a build argument. On Railway the volume is at
# /data, and both variables point there.

# The bot's base image, so both services run the same Node.
FROM node:26.11.1-trixie-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0 AS base

# Litestream exactly as the root Dockerfile pins it; keep the two in step.
FROM base AS litestream-amd64
ADD --checksum=sha256:cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d \
  https://github.com/benbjohnson/litestream/releases/download/v0.5.17/litestream-0.5.17-linux-x86_64.tar.gz /tmp/litestream.tar.gz
FROM base AS litestream-arm64
ADD --checksum=sha256:f8ca4a050095c1efbda2c4365172e61bf9d955ea0d9ac42f448b52e51819baa5 \
  https://github.com/benbjohnson/litestream/releases/download/v0.5.17/litestream-0.5.17-linux-arm64.tar.gz /tmp/litestream.tar.gz
FROM litestream-${TARGETARCH} AS litestream
RUN tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin litestream \
  && apt-get update && apt-get install -y --no-install-recommends ca-certificates

FROM base
WORKDIR /app
COPY package.json package-lock.json ./
# npm ci checks every workspace against the lockfile, so the bot's manifest
# comes along; only the site's dependencies are installed.
COPY apps/bot/package.json apps/bot/
COPY apps/site/package.json apps/site/
# Runtime dependencies only: astro builds the site, and vitest, typescript and
# the type packages are for development.
RUN npm ci --omit=dev -w @tps/site
COPY apps/site apps/site
COPY scripts/litestream-start.sh scripts/litestream-start.sh
# The topic vocabulary and clubs the site imports from the repo root,
# and the two policies the privacy page bundles.
COPY content/config/topics.json content/config/clubs.json content/config/
COPY content/privacy-policy.md content/privacy-policy-site.md content/
# astro.config.mjs reads it at build time, for the domains whose forwarded
# headers Astro trusts.
ARG BETTER_AUTH_URL
# Where EmDash's database and uploads go; see above.
ARG SITE_EMDASH_DIR
# Set: uploads go to R2, configured at run time from the S3_* variables
# (astro.config.mjs). Unset: they stay in SITE_EMDASH_DIR.
ARG S3_BUCKET
# The landing page's Join button; without it the page has none.
ARG PUBLIC_DISCORD_INVITE
RUN test -n "$BETTER_AUTH_URL" && npm run build -w @tps/site
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY --from=litestream /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
ENTRYPOINT ["sh", "/app/apps/site/start.sh"]
