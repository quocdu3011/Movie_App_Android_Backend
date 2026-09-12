ARG MINIO_IMAGE=quay.io/minio/minio:RELEASE.2025-06-13T11-33-47Z
ARG CURL_IMAGE=curlimages/curl:8.16.0
FROM ${MINIO_IMAGE} AS minio-binary
FROM ${CURL_IMAGE}
USER root
RUN mkdir -p /data && chown 1000:1000 /data
COPY --from=minio-binary /usr/bin/minio /usr/bin/minio
COPY --from=minio-binary /usr/bin/mc /usr/bin/mc
USER 1000:1000
ENTRYPOINT ["/usr/bin/minio"]
