# syntax=docker/dockerfile:1
#
# The site's image. Build from the repo root, so the root lockfile applies:
#   docker build -f apps/site/Dockerfile --build-arg BETTER_AUTH_URL=https://sherpa.omgod.com .
# On Railway, point the site service at this file (RAILWAY_DOCKERFILE_PATH);
# the root Dockerfile builds the bot.
#
# The session database defaults to apps/site/.data/sessions.db, under the
# working directory npm gives the workspace: mount the volume at
# /app/apps/site/.data, or set SITE_SESSION_DB. EmDash's database and uploads
# go in .data too, unless SITE_EMDASH_DIR names another directory: its path is
# fixed at build time, so it is a build argument. On Railway the volume is at
# /data, and both variables point there.

# The bot's base image, so both services run the same Node.
FROM node:26.11.1-trixie-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0
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
# The topic vocabulary the landing and brand pages import from the repo root,
# and the two policies the privacy page bundles.
COPY content/config/topics.json content/config/topics.json
COPY content/privacy-policy.md content/privacy-policy-site.md content/
# astro.config.mjs reads it at build time, for the domains whose forwarded
# headers Astro trusts.
ARG BETTER_AUTH_URL
# Where EmDash's database and uploads go; see above.
ARG SITE_EMDASH_DIR
# The landing page's Join button; without it the page has none.
ARG PUBLIC_DISCORD_INVITE
RUN test -n "$BETTER_AUTH_URL" && npm run build -w @tps/site
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
CMD ["npm", "start", "-w", "@tps/site"]
