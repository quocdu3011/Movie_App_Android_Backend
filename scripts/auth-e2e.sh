#!/usr/bin/env bash
set -euo pipefail

temporary_dir="$(mktemp -d)"
auth_pid=""
gateway_pid=""

cleanup() {
  if [[ -n "$gateway_pid" ]]; then
    kill "$gateway_pid" 2>/dev/null || true
    wait "$gateway_pid" 2>/dev/null || true
  fi
  if [[ -n "$auth_pid" ]]; then
    kill "$auth_pid" 2>/dev/null || true
    wait "$auth_pid" 2>/dev/null || true
  fi
  rm -rf "$temporary_dir"
}
trap cleanup EXIT

export NODE_ENV=test
export AUTH_PORT="${AUTH_PORT:-34001}"
export GATEWAY_PORT="${GATEWAY_PORT:-34000}"
export AUTH_DATABASE_URL="${AUTH_DATABASE_URL:-postgres://movieapp:movieapp_dev_only@127.0.0.1:5432/auth_db}"
export AUTH_JWT_ISSUER="${AUTH_JWT_ISSUER:-https://auth.movieapp.local}"
export AUTH_JWT_AUDIENCE="${AUTH_JWT_AUDIENCE:-movieapp-api}"
export AUTH_JWT_KID="g0-ci-test-key"
export AUTH_PRIVATE_KEY_PATH="$temporary_dir/auth-private.pem"
export AUTH_PUBLIC_KEY_PATH="$temporary_dir/auth-public.pem"
export AUTH_INTERNAL_TOKENS_JSON='{"api-gateway":"g0-ci-internal-token-at-least-32-characters"}'
export GATEWAY_SERVICE_TOKEN='g0-ci-internal-token-at-least-32-characters'
export AUTH_SERVICE_URL="http://127.0.0.1:${AUTH_PORT}"
export GATEWAY_URL="http://127.0.0.1:${GATEWAY_PORT}"
export SEED_ADMIN_EMAIL='g0-admin@example.test'
export SEED_ADMIN_PASSWORD='G0-CI-admin-password-only-2026!'
export SEED_ADMIN_FULL_NAME='G0 CI Admin'

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$AUTH_PRIVATE_KEY_PATH" >/dev/null 2>&1
openssl pkey -in "$AUTH_PRIVATE_KEY_PATH" -pubout -out "$AUTH_PUBLIC_KEY_PATH" >/dev/null 2>&1
chmod 600 "$AUTH_PRIVATE_KEY_PATH"

npm run migration:run
node dist/apps/auth-service/main.js >"$temporary_dir/auth.log" 2>&1 &
auth_pid=$!
node dist/apps/api-gateway/main.js >"$temporary_dir/gateway.log" 2>&1 &
gateway_pid=$!

ready=0
for _ in $(seq 1 60); do
  if ! kill -0 "$auth_pid" 2>/dev/null; then
    cat "$temporary_dir/auth.log" >&2
    exit 1
  fi
  if ! kill -0 "$gateway_pid" 2>/dev/null; then
    cat "$temporary_dir/gateway.log" >&2
    exit 1
  fi
  if curl --fail --silent "http://127.0.0.1:${AUTH_PORT}/ready" >/dev/null \
    && curl --fail --silent "http://127.0.0.1:${GATEWAY_PORT}/ready" >/dev/null; then
    ready=1
    break
  fi
  sleep 0.5
done

if [[ "$ready" != 1 ]]; then
  cat "$temporary_dir/auth.log" >&2
  cat "$temporary_dir/gateway.log" >&2
  echo 'Auth/Gateway readiness did not complete before timeout.' >&2
  exit 1
fi

npm run smoke:auth
