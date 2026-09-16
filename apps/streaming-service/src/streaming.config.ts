import 'dotenv/config';
import { constantTimeEquals } from '@movie/shared-auth';
import { loadHttpServiceConfig } from '@movie/shared-config';

export const STREAMING_CONFIG = Symbol('STREAMING_CONFIG');

export type StreamingCaller = 'api-gateway' | 'profile-service' | 'transcode-worker';

export interface StreamingConfig {
  port: number;
  databaseUrl: string;
  redisUrl: string;
  serviceTokens: Map<StreamingCaller, string>;
  downstreamTokens: Map<'auth-service' | 'profile-service' | 'catalog-service' | 'payment-service', string>;
  authUrl: string;
  profileUrl: string;
  catalogUrl: string;
  paymentUrl: string;
  providerBaseUrl: string;
  mediaHostAllowlist: string[];
  testMediaPort: number | null;
  providerTimeoutMs: number;
  sessionTtlSeconds: number;
  concurrentStreamLimitEnabled: boolean;
  maintenancePollMs: number;
  outboxPollMs: number;
  sourceRetryBaseMs: number;
  circuitFailureThreshold: number;
  maxConcurrentProviderResolves: number;
  kafkaBrokers: string[];
  nodeEnv: string;
  objectStorageEndpoint: string;
  objectStorageAccessKey: string;
  objectStorageSecretKey: string;
  uploadsBucket: string;
  mediaBucket: string;
  uploadExpirySeconds: number;
  mediaEdgeUrl: string;
  mediaAuthSecret: string;
  mediaAuthTtlSeconds: number;
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const value = env[key] === undefined ? fallback : Number(env[key]);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer from ${min} to ${max}`);
  return value;
}

function boolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const value = (env[key] ?? String(fallback)).trim().toLowerCase();
  if (value !== 'true' && value !== 'false') throw new Error(`${key} must be true or false`);
  return value === 'true';
}

function origin(raw: string | undefined, key: string, fallback: string): string {
  let value: URL;
  try { value = new URL(raw?.trim() || fallback); } catch { throw new Error(`${key} must be a valid URL`); }
  if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password || value.pathname !== '/' || value.search || value.hash) {
    throw new Error(`${key} must be an HTTP(S) origin without credentials, path, query or fragment`);
  }
  return value.origin;
}

function parseTokens(raw: string | undefined, workerFallback: string | undefined): Map<StreamingCaller, string> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw ?? ''); } catch { throw new Error('STREAMING_INTERNAL_TOKENS_JSON must be a JSON object'); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('STREAMING_INTERNAL_TOKENS_JSON must be a JSON object');
  const tokens = new Map<StreamingCaller, string>();
  for (const [caller, token] of Object.entries(parsed as Record<string, unknown>)) {
    if (!['api-gateway', 'profile-service', 'transcode-worker'].includes(caller)
      || typeof token !== 'string' || token.trim().length < 32 || tokens.has(caller as StreamingCaller)) {
      throw new Error('STREAMING_INTERNAL_TOKENS_JSON contains an invalid service token');
    }
    tokens.set(caller as StreamingCaller, token.trim());
  }
  if (new Set(tokens.values()).size !== tokens.size) throw new Error('Streaming service tokens must be unique per caller');
  for (const caller of ['api-gateway', 'profile-service'] as const) {
    if (!tokens.has(caller)) throw new Error(`STREAMING_INTERNAL_TOKENS_JSON must include ${caller}`);
  }
  if (!tokens.has('transcode-worker') && workerFallback?.trim()) tokens.set('transcode-worker', workerFallback.trim());
  if (!tokens.has('transcode-worker') || tokens.get('transcode-worker')!.length < 32 || new Set(tokens.values()).size !== tokens.size) {
    throw new Error('STREAMING_INTERNAL_TOKENS_JSON or WORKER_STREAMING_TOKEN must provide a unique transcode worker token');
  }
  return tokens;
}

function parseDownstreamTokens(raw: string | undefined): StreamingConfig['downstreamTokens'] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw ?? ''); } catch { throw new Error('STREAMING_DOWNSTREAM_TOKENS_JSON must be a JSON object'); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('STREAMING_DOWNSTREAM_TOKENS_JSON must be a JSON object');
  const tokens = new Map<'auth-service' | 'profile-service' | 'catalog-service' | 'payment-service', string>();
  for (const [service, token] of Object.entries(parsed as Record<string, unknown>)) {
    if (!['auth-service', 'profile-service', 'catalog-service', 'payment-service'].includes(service)
      || typeof token !== 'string' || token.trim().length < 32) throw new Error('STREAMING_DOWNSTREAM_TOKENS_JSON contains an invalid service token');
    tokens.set(service as 'auth-service' | 'profile-service' | 'catalog-service' | 'payment-service', token.trim());
  }
  if (tokens.size !== 4 || new Set(tokens.values()).size !== tokens.size) throw new Error('STREAMING_DOWNSTREAM_TOKENS_JSON must provide unique tokens for Auth, Profile, Catalog and Payment');
  return tokens;
}

function providerUrl(raw: string | undefined, nodeEnv: string): string {
  const url = origin(raw, 'KKPHIM_API_BASE_URL', 'https://phimapi.com');
  if (nodeEnv === 'production' && !url.startsWith('https://')) throw new Error('KKPHIM_API_BASE_URL must use HTTPS in production');
  return url;
}

export function loadStreamingConfig(env: NodeJS.ProcessEnv = process.env): StreamingConfig {
  const service = loadHttpServiceConfig('streaming-service', 'STREAMING_PORT', 3005, env);
  const databaseUrl = env.STREAMING_DATABASE_URL?.trim();
  if (!databaseUrl || !/^postgres(?:ql)?:\/\//.test(databaseUrl)) throw new Error('STREAMING_DATABASE_URL must use PostgreSQL');
  const redisUrl = env.REDIS_URL?.trim();
  if (!redisUrl) throw new Error('REDIS_URL is required for playback leases');
  let redis: URL;
  try { redis = new URL(redisUrl); } catch { throw new Error('REDIS_URL must be a valid Redis URL'); }
  if (!['redis:', 'rediss:'].includes(redis.protocol) || !redis.hostname || redis.username) throw new Error('REDIS_URL must use redis(s) and may include a password, but not a username');

  const rawHosts = env.KKPHIM_MEDIA_HOST_ALLOWLIST?.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean) ?? [];
  if (rawHosts.length === 0 || rawHosts.some((host) => host !== '*' && !/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(host))) {
    throw new Error('KKPHIM_MEDIA_HOST_ALLOWLIST must contain *, exact DNS hosts or *.domain suffixes');
  }
  const testMediaPort = service.nodeEnv === 'test' && env.STREAMING_TEST_MEDIA_PORT !== undefined
    ? integer(env, 'STREAMING_TEST_MEDIA_PORT', 443, 1, 65_535) : null;
  const providers = env.STREAMING_KAFKA_BROKERS?.trim() || env.KAFKA_BROKERS || '127.0.0.1:19092';
  const kafkaBrokers = providers.split(',').map((item) => item.trim()).filter(Boolean);
  if (kafkaBrokers.length === 0 || kafkaBrokers.some((item) => !/^[a-zA-Z0-9.-]+:\d{1,5}$/.test(item))) throw new Error('STREAMING_KAFKA_BROKERS must contain host:port values');
  const objectStorageEndpoint = origin(env.MINIO_ENDPOINT, 'MINIO_ENDPOINT', 'http://127.0.0.1:9000');
  const objectStorageAccessKey = env.MINIO_ROOT_USER?.trim();
  const objectStorageSecretKey = env.MINIO_ROOT_PASSWORD?.trim();
  if (!objectStorageAccessKey || !objectStorageSecretKey) throw new Error('MINIO_ROOT_USER and MINIO_ROOT_PASSWORD are required');
  const uploadsBucket = env.MINIO_BUCKET_UPLOADS?.trim() || 'movieapp-uploads';
  const mediaBucket = env.MINIO_BUCKET_MEDIA?.trim() || 'movieapp-media';
  if (!/^[a-z0-9][a-z0-9.-]{2,62}$/.test(uploadsBucket) || !/^[a-z0-9][a-z0-9.-]{2,62}$/.test(mediaBucket)) throw new Error('MinIO bucket names are invalid');
  const mediaAuthSecret = env.MEDIA_AUTH_SECRET?.trim();
  if (!mediaAuthSecret || mediaAuthSecret.length < 32) throw new Error('MEDIA_AUTH_SECRET must be at least 32 characters');
  return {
    port: service.port,
    databaseUrl,
    redisUrl: redis.toString(),
    serviceTokens: parseTokens(env.STREAMING_INTERNAL_TOKENS_JSON, env.WORKER_STREAMING_TOKEN),
    downstreamTokens: parseDownstreamTokens(env.STREAMING_DOWNSTREAM_TOKENS_JSON),
    authUrl: origin(env.AUTH_SERVICE_URL, 'AUTH_SERVICE_URL', 'http://127.0.0.1:3001'),
    profileUrl: origin(env.PROFILE_SERVICE_URL, 'PROFILE_SERVICE_URL', 'http://127.0.0.1:3002'),
    catalogUrl: origin(env.CATALOG_SERVICE_URL, 'CATALOG_SERVICE_URL', 'http://127.0.0.1:3003'),
    paymentUrl: origin(env.PAYMENT_SERVICE_URL, 'PAYMENT_SERVICE_URL', 'http://127.0.0.1:3004'),
    providerBaseUrl: providerUrl(env.KKPHIM_API_BASE_URL, service.nodeEnv),
    mediaHostAllowlist: rawHosts,
    testMediaPort,
    providerTimeoutMs: integer(env, 'STREAMING_PROVIDER_TIMEOUT_MS', 4_000, 500, 5_000),
    sessionTtlSeconds: integer(env, 'STREAMING_SESSION_TTL_SECONDS', 90, 1, 900),
    concurrentStreamLimitEnabled: boolean(env, 'STREAMING_CONCURRENT_LIMIT_ENABLED', true),
    maintenancePollMs: integer(env, 'STREAMING_MAINTENANCE_POLL_MS', 1_000, 250, 60_000),
    outboxPollMs: integer(env, 'STREAMING_OUTBOX_POLL_MS', 1_000, 250, 60_000),
    sourceRetryBaseMs: integer(env, 'STREAMING_SOURCE_RETRY_BASE_MS', 1_000, 100, 60_000),
    circuitFailureThreshold: integer(env, 'STREAMING_CIRCUIT_FAILURE_THRESHOLD', 3, 2, 10),
    maxConcurrentProviderResolves: integer(env, 'STREAMING_MAX_PROVIDER_RESOLVES', 10, 1, 100),
    kafkaBrokers,
    nodeEnv: service.nodeEnv,
    objectStorageEndpoint,
    objectStorageAccessKey,
    objectStorageSecretKey,
    uploadsBucket,
    mediaBucket,
    uploadExpirySeconds: integer(env, 'STREAMING_UPLOAD_EXPIRY_SECONDS', 600, 60, 900),
    mediaEdgeUrl: origin(env.MEDIA_EDGE_URL, 'MEDIA_EDGE_URL', 'http://127.0.0.1:8081'),
    mediaAuthSecret,
    mediaAuthTtlSeconds: integer(env, 'STREAMING_MEDIA_AUTH_TTL_SECONDS', 900, 60, 900),
  };
}

export function validStreamingToken(token: string | undefined, caller: string | undefined, config: StreamingConfig): boolean {
  const expected = caller ? config.serviceTokens.get(caller as StreamingCaller) : undefined;
  return Boolean(expected && token && constantTimeEquals(expected, token));
}
