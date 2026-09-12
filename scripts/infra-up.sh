#!/usr/bin/env bash
set -euo pipefail

if docker compose version >/dev/null 2>&1; then
  compose=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  compose=(docker-compose)
else
  echo "Docker Compose v2 is required (docker compose or docker-compose)." >&2
  exit 1
fi

"${compose[@]}" --profile core up --detach --wait
npm run infra:bootstrap
