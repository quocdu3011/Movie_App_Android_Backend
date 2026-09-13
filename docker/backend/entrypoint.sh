#!/bin/sh
set -eu

case "${MOVIEAPP_SERVICE:-}" in
  api-gateway|auth-service|profile-service|catalog-service|payment-service|streaming-service|transcode-worker|notification-service|recommendation-service|media-edge)
    exec node "/workspace/dist/apps/${MOVIEAPP_SERVICE}/main.js"
    ;;
  *)
    echo 'MOVIEAPP_SERVICE must name one supported MovieApp service' >&2
    exit 64
    ;;
esac
