import 'dotenv/config';
import { constantTimeEquals } from '@movie/shared-auth';
import { loadHttpServiceConfig } from '@movie/shared-config';

export const CATALOG_CONFIG = Symbol('CATALOG_CONFIG');

export interface CatalogConfig {
  port: number;
  databaseUrl: string;
  gatewayToken: string;
  streamingToken: string;
  profileServiceToken: string;
  recommendationToken: string;
  profileUrl: string;
  profileToken: string;
  providerBaseUrl: string;
  providerTimeoutMs: number;
  syncPollMs: number;
  opensearchUrl: string;
  kafkaBrokers: string[];
  nodeEnv: string;
}

function tokenFor(raw: string | undefined, caller: string, variable: string, required = true): string {
  let parsed: unknown;
  try { parsed = JSON.parse(raw ?? ''); } catch { throw new Error(`${variable} must be a JSON object`); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(`${variable} must be a JSON object`);
  const token = (parsed as Record<string, unknown>)[caller];
  if (typeof token !== 'string' || token.trim().length < 32) {
    if (!required && token === undefined) return '';
    throw new Error(`${variable} must contain a 32-character ${caller} token`);
  }
  return token.trim();
}

function httpOrigin(raw: string, name: string, allowHttp: boolean): string {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error(`${name} must be a URL`); }
  if ((!allowHttp && parsed.protocol !== 'https:') || (allowHttp && !['http:', 'https:'].includes(parsed.protocol)) || parsed.username || parsed.password) {
    throw new Error(`${name} must be a safe ${allowHttp ? 'HTTP(S)' : 'HTTPS'} URL without credentials`);
  }
  return parsed.origin;
}

export function loadCatalogConfig(env: NodeJS.ProcessEnv = process.env): CatalogConfig {
  const service = loadHttpServiceConfig('catalog-service', 'CATALOG_PORT', 3003, env);
  const databaseUrl = env.CATALOG_DATABASE_URL?.trim();
  if (!databaseUrl || !/^postgres(?:ql)?:\/\//.test(databaseUrl)) throw new Error('CATALOG_DATABASE_URL must use PostgreSQL');
  const gatewayToken = tokenFor(env.CATALOG_INTERNAL_TOKENS_JSON, 'api-gateway', 'CATALOG_INTERNAL_TOKENS_JSON');
  const profileToken = tokenFor(env.PROFILE_INTERNAL_TOKENS_JSON, 'catalog-service', 'PROFILE_INTERNAL_TOKENS_JSON');
  const profileUrl = httpOrigin(env.PROFILE_SERVICE_URL?.trim() ?? 'http://127.0.0.1:3002', 'PROFILE_SERVICE_URL', service.nodeEnv !== 'production');
  const providerBaseUrl = httpOrigin(env.KKPHIM_API_BASE_URL?.trim() ?? 'https://phimapi.com', 'KKPHIM_API_BASE_URL', service.nodeEnv !== 'production');
  const timeoutMs = Number(env.KKPHIM_TIMEOUT_MS ?? 5_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 15_000) throw new Error('KKPHIM_TIMEOUT_MS must be an integer from 500 to 15000');
  const pollMs = Number(env.CATALOG_SYNC_POLL_MS ?? 750);
  if (!Number.isSafeInteger(pollMs) || pollMs < 250 || pollMs > 60_000) throw new Error('CATALOG_SYNC_POLL_MS must be an integer from 250 to 60000');
  const streamingToken = tokenFor(env.CATALOG_INTERNAL_TOKENS_JSON, 'streaming-service', 'CATALOG_INTERNAL_TOKENS_JSON');
  const profileServiceToken = tokenFor(env.CATALOG_INTERNAL_TOKENS_JSON, 'profile-service', 'CATALOG_INTERNAL_TOKENS_JSON', false);
  const recommendationToken = tokenFor(env.CATALOG_INTERNAL_TOKENS_JSON, 'recommendation-service', 'CATALOG_INTERNAL_TOKENS_JSON', false);
  const tokens = [gatewayToken, streamingToken, ...(profileServiceToken ? [profileServiceToken] : []), ...(recommendationToken ? [recommendationToken] : [])];
  if (new Set(tokens).size !== tokens.length) throw new Error('Catalog internal tokens must be unique per caller');
  const opensearchUrl = httpOrigin(env.OPENSEARCH_URL?.trim() ?? 'http://127.0.0.1:9200', 'OPENSEARCH_URL', service.nodeEnv !== 'production');
  const kafkaBrokers = (env.CATALOG_KAFKA_BROKERS ?? env.KAFKA_BROKERS ?? '127.0.0.1:19092').split(',').map((item) => item.trim()).filter(Boolean);
  if (!kafkaBrokers.length || kafkaBrokers.some((item) => !/^[a-zA-Z0-9.-]+:\d{1,5}$/.test(item))) throw new Error('CATALOG_KAFKA_BROKERS must contain host:port values');
  return { port: service.port, databaseUrl, gatewayToken, streamingToken, profileServiceToken, recommendationToken, profileUrl, profileToken, providerBaseUrl, providerTimeoutMs: timeoutMs, syncPollMs: pollMs, opensearchUrl, kafkaBrokers, nodeEnv: service.nodeEnv };
}

export function validGatewayToken(candidate: string | undefined, config: CatalogConfig): boolean {
  return typeof candidate === 'string' && constantTimeEquals(candidate, config.gatewayToken);
}
