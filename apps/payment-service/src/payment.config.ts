import 'dotenv/config';
import { constantTimeEquals } from '@movie/shared-auth';
import { loadHttpServiceConfig } from '@movie/shared-config';

export const PAYMENT_CONFIG = Symbol('PAYMENT_CONFIG');

export interface PaymentConfig {
  port: number;
  databaseUrl: string;
  serviceTokens: Map<string, string>;
  mockEnabled: boolean;
  mockHmacSecret: string | null;
  pendingTtlMinutes: number;
  maintenancePollMs: number;
  kafkaBrokers: string[];
  freeMaxConcurrentStreams: number;
  freeMaxResolution: string;
  nodeEnv: string;
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const value = env[key] === undefined ? fallback : Number(env[key]);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer from ${min} to ${max}`);
  return value;
}

function parseTokens(raw: string | undefined): Map<string, string> {
  let value: unknown;
  try { value = JSON.parse(raw ?? ''); } catch { throw new Error('PAYMENT_INTERNAL_TOKENS_JSON must be a JSON object'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('PAYMENT_INTERNAL_TOKENS_JSON must be a JSON object');
  const tokens = new Map<string, string>();
  for (const [name, token] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(name) || typeof token !== 'string' || token.trim().length < 32) {
      throw new Error('PAYMENT_INTERNAL_TOKENS_JSON contains an invalid caller token');
    }
    tokens.set(name, token.trim());
  }
  if (!tokens.has('api-gateway') || !tokens.has('streaming-service')) {
    throw new Error('PAYMENT_INTERNAL_TOKENS_JSON must include api-gateway and streaming-service');
  }
  return tokens;
}

export function loadPaymentConfig(env: NodeJS.ProcessEnv = process.env): PaymentConfig {
  const service = loadHttpServiceConfig('payment-service', 'PAYMENT_PORT', 3004, env);
  const databaseUrl = env.PAYMENT_DATABASE_URL?.trim();
  if (!databaseUrl || !/^postgres(?:ql)?:\/\//.test(databaseUrl)) throw new Error('PAYMENT_DATABASE_URL must use PostgreSQL');
  const defaultMock = service.nodeEnv === 'development' || service.nodeEnv === 'test';
  const rawMockEnabled = env.PAYMENT_MOCK_ENABLED ?? String(defaultMock);
  if (!['true', 'false'].includes(rawMockEnabled.toLowerCase())) throw new Error('PAYMENT_MOCK_ENABLED must be true or false');
  const mockEnabled = rawMockEnabled.toLowerCase() === 'true';
  if (service.nodeEnv === 'production' && mockEnabled) throw new Error('Payment mock is forbidden in production');
  if (mockEnabled && !['development', 'test'].includes(service.nodeEnv)) throw new Error('Payment mock may only run in development or test');
  const mockHmacSecret = env.PAYMENT_MOCK_HMAC_SECRET?.trim() || null;
  if (mockEnabled && (!mockHmacSecret || mockHmacSecret.length < 32)) throw new Error('PAYMENT_MOCK_HMAC_SECRET must contain at least 32 characters while the mock is enabled');
  const brokers = (env.KAFKA_BROKERS ?? '127.0.0.1:19092').split(',').map((item) => item.trim()).filter(Boolean);
  if (brokers.length === 0) throw new Error('KAFKA_BROKERS must contain at least one broker');
  return {
    port: service.port,
    databaseUrl,
    serviceTokens: parseTokens(env.PAYMENT_INTERNAL_TOKENS_JSON),
    mockEnabled,
    mockHmacSecret,
    pendingTtlMinutes: integer(env, 'PAYMENT_PENDING_TTL_MINUTES', 30, 1, 1440),
    maintenancePollMs: integer(env, 'PAYMENT_MAINTENANCE_POLL_MS', 1000, 250, 60_000),
    kafkaBrokers: brokers,
    freeMaxConcurrentStreams: integer(env, 'PAYMENT_FREE_MAX_CONCURRENT_STREAMS', 1, 1, 10),
    freeMaxResolution: env.PAYMENT_FREE_MAX_RESOLUTION?.trim() || '720p',
    nodeEnv: service.nodeEnv,
  };
}

export function validServiceToken(candidate: string | undefined, serviceName: string | undefined, config: PaymentConfig): boolean {
  const expected = serviceName ? config.serviceTokens.get(serviceName) : undefined;
  return Boolean(expected && candidate && constantTimeEquals(candidate, expected));
}
