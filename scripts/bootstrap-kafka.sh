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

topics=(
  movie.published movie.updated movie.archived movie.source.updated
  video.uploaded video.processing video.transcoded video.transcode_failed video.ready
  payment.success payment.reconciliation_required subscription.expiring profile.deleted playback.qualified
)

for topic in "${topics[@]}"; do
  "${compose[@]}" --profile core exec -T kafka \
    /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:9092 \
    --create --if-not-exists --topic "$topic" \
    --partitions "${KAFKA_DEFAULT_PARTITIONS:-3}" --replication-factor 1 >/dev/null
done

"${compose[@]}" --profile core exec -T kafka \
  /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:9092 --list >/dev/null
printf 'Kafka topics ready (%s topics; single-broker development settings).\n' "${#topics[@]}"
