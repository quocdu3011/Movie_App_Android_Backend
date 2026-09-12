import 'dotenv/config';
import { loadHttpServiceConfig } from '@movie/shared-config';

export const WORKER_CONFIG = Symbol('WORKER_CONFIG');
export interface WorkerConfig {
  port: number; databaseUrl: string; kafkaBrokers: string[]; objectStorageEndpoint: string;
  objectStorageAccessKey: string; objectStorageSecretKey: string; uploadsBucket: string; mediaBucket: string;
  streamingUrl: string; streamingToken: string; pollMs: number; leaseSeconds: number; ffmpegTimeoutMs: number; retryBaseMs: number;
}
function numberValue(value: string | undefined, fallback: number, min: number, max: number, key: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`${key} must be an integer from ${min} to ${max}`);
  return parsed;
}
function origin(value: string | undefined, key: string, fallback: string): string {
  let url: URL; try { url = new URL(value?.trim() || fallback); } catch { throw new Error(`${key} must be a valid URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(`${key} must be an origin`);
  return url.origin;
}
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const http = loadHttpServiceConfig('transcode-worker', 'TRANSCODE_PORT', 3010, env);
  let databaseUrl = env.WORKER_DATABASE_URL?.trim();
  if (!databaseUrl && env.STREAMING_DATABASE_URL?.trim() && env.WORKER_DB_PASSWORD?.trim()) {
    const derived = new URL(env.STREAMING_DATABASE_URL);
    derived.username = 'movieapp_worker'; derived.password = env.WORKER_DB_PASSWORD; derived.pathname = '/worker_db'; databaseUrl = derived.toString();
  }
  if (!databaseUrl?.startsWith('postgres')) throw new Error('WORKER_DATABASE_URL must use PostgreSQL');
  const kafkaBrokers = (env.WORKER_KAFKA_BROKERS?.trim() || env.KAFKA_BROKERS || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!kafkaBrokers.length) throw new Error('WORKER_KAFKA_BROKERS or KAFKA_BROKERS is required');
  const access = env.MINIO_ROOT_USER?.trim(); const secret = env.MINIO_ROOT_PASSWORD?.trim(); const token = env.WORKER_STREAMING_TOKEN?.trim();
  if (!access || !secret || !token || token.length < 32) throw new Error('MinIO credentials and WORKER_STREAMING_TOKEN are required');
  return { port: http.port, databaseUrl, kafkaBrokers, objectStorageEndpoint: origin(env.MINIO_ENDPOINT, 'MINIO_ENDPOINT', 'http://127.0.0.1:9000'), objectStorageAccessKey: access, objectStorageSecretKey: secret, uploadsBucket: env.MINIO_BUCKET_UPLOADS?.trim() || 'movieapp-uploads', mediaBucket: env.MINIO_BUCKET_MEDIA?.trim() || 'movieapp-media', streamingUrl: origin(env.STREAMING_SERVICE_URL, 'STREAMING_SERVICE_URL', 'http://127.0.0.1:3005'), streamingToken: token, pollMs: numberValue(env.WORKER_POLL_MS, 500, 100, 60_000, 'WORKER_POLL_MS'), leaseSeconds: numberValue(env.WORKER_LEASE_SECONDS, 120, 5, 900, 'WORKER_LEASE_SECONDS'), ffmpegTimeoutMs: numberValue(env.WORKER_FFMPEG_TIMEOUT_MS, 120_000, 5_000, 3_600_000, 'WORKER_FFMPEG_TIMEOUT_MS'), retryBaseMs: numberValue(env.WORKER_RETRY_BASE_MS, 30_000, 100, 120_000, 'WORKER_RETRY_BASE_MS') };
}
