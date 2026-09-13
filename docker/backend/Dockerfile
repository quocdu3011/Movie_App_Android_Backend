# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24.21.0-bookworm-slim

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /workspace
COPY package.json package-lock.json tsconfig.json tsconfig.build.json .nvmrc ./
COPY apps ./apps
COPY libs ./libs
RUN npm ci

FROM dependencies AS builder
COPY scripts ./scripts
RUN npm run build

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev

FROM ${NODE_IMAGE} AS app-runtime
ARG MOVIEAPP_SERVICE
ARG VCS_REF=unknown
WORKDIR /workspace
ENV NODE_ENV=production \
    MOVIEAPP_SERVICE=${MOVIEAPP_SERVICE}
LABEL org.opencontainers.image.source="movieapp-backend" \
      org.opencontainers.image.revision=${VCS_REF}
COPY --from=production-dependencies /workspace/node_modules ./node_modules
COPY --from=builder /workspace/apps ./apps
COPY --from=builder /workspace/libs ./libs
COPY --from=builder /workspace/dist ./dist
COPY docker/backend/entrypoint.sh /usr/local/bin/movieapp-entrypoint
RUN chmod 0555 /usr/local/bin/movieapp-entrypoint \
  && chown -R node:node /workspace
USER node
ENTRYPOINT ["/usr/local/bin/movieapp-entrypoint"]

FROM app-runtime AS worker-runtime
USER root
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
USER node

FROM builder AS migrations
ARG VCS_REF=unknown
WORKDIR /workspace
ENV NODE_ENV=production
LABEL org.opencontainers.image.source="movieapp-backend" \
      org.opencontainers.image.revision=${VCS_REF}
COPY scripts/run-migrations.mjs ./scripts/run-migrations.mjs
RUN chown -R node:node /workspace
USER node
ENTRYPOINT ["node", "scripts/run-migrations.mjs"]
