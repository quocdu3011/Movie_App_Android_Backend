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
  providerRequestDelayMs: number;
  syncRetryMs: number;
  opensearchUrl: string;
  opensearchAuthorization: string | null;
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

function openSearchUrl(env: NodeJS.ProcessEnv, allowHttp: boolean): string {
  const serviceUri = env.OPENSEARCH_SERVICE_URI?.trim() || env.OPENSEARCH_URL?.trim();
  if (serviceUri) return httpOrigin(serviceUri, 'OPENSEARCH_SERVICE_URI', allowHttp);
  const host = env.OPENSEARCH_HOST?.trim();
  if (!host) throw new Error('Configure OPENSEARCH_SERVICE_URI or OPENSEARCH_HOST');
  if (!/^[a-zA-Z0-9.-]+$/.test(host)) throw new Error('OPENSEARCH_HOST must be a hostname without a scheme or path');
  const port = Number(env.OPENSEARCH_PORT ?? 443);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('OPENSEARCH_PORT must be an integer from 1 to 65535');
  return httpOrigin(`https://${host}:${port}`, 'OPENSEARCH_HOST', allowHttp);
}

function openSearchAuthorization(env: NodeJS.ProcessEnv): string | null {
  const user = env.OPENSEARCH_USER?.trim() || env.OPENSEARCH_USERNAME?.trim();
  const password = env.OPENSEARCH_PASSWORD;
  if (!user && password === undefined) return null;
  if (!user || !password) throw new Error('OPENSEARCH_USER and OPENSEARCH_PASSWORD must be configured together');
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
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
  const providerRequestDelayMs = Number(env.CATALOG_PROVIDER_REQUEST_DELAY_MS ?? 250);
  if (!Number.isSafeInteger(providerRequestDelayMs) || providerRequestDelayMs < 100 || providerRequestDelayMs > 10_000) throw new Error('CATALOG_PROVIDER_REQUEST_DELAY_MS must be an integer from 100 to 10000');
  const syncRetryMs = Number(env.CATALOG_SYNC_RETRY_MS ?? 60_000);
  if (!Number.isSafeInteger(syncRetryMs) || syncRetryMs < 1_000 || syncRetryMs > 3_600_000) throw new Error('CATALOG_SYNC_RETRY_MS must be an integer from 1000 to 3600000');
  const streamingToken = tokenFor(env.CATALOG_INTERNAL_TOKENS_JSON, 'streaming-service', 'CATALOG_INTERNAL_TOKENS_JSON');
  const profileServiceToken = tokenFor(env.CATALOG_INTERNAL_TOKENS_JSON, 'profile-service', 'CATALOG_INTERNAL_TOKENS_JSON', false);
  const recommendationToken = tokenFor(env.CATALOG_INTERNAL_TOKENS_JSON, 'recommendation-service', 'CATALOG_INTERNAL_TOKENS_JSON', false);
  const tokens = [gatewayToken, streamingToken, ...(profileServiceToken ? [profileServiceToken] : []), ...(recommendationToken ? [recommendationToken] : [])];
  if (new Set(tokens).size !== tokens.length) throw new Error('Catalog internal tokens must be unique per caller');
  const opensearchUrl = openSearchUrl(env, service.nodeEnv !== 'production');
  const opensearchAuthorization = openSearchAuthorization(env);
  const kafkaBrokers = (env.CATALOG_KAFKA_BROKERS ?? env.KAFKA_BROKERS ?? '127.0.0.1:19092').split(',').map((item) => item.trim()).filter(Boolean);
  if (!kafkaBrokers.length || kafkaBrokers.some((item) => !/^[a-zA-Z0-9.-]+:\d{1,5}$/.test(item))) throw new Error('CATALOG_KAFKA_BROKERS must contain host:port values');
  return { port: service.port, databaseUrl, gatewayToken, streamingToken, profileServiceToken, recommendationToken, profileUrl, profileToken, providerBaseUrl, providerTimeoutMs: timeoutMs, syncPollMs: pollMs, providerRequestDelayMs, syncRetryMs, opensearchUrl, opensearchAuthorization, kafkaBrokers, nodeEnv: service.nodeEnv };
}

export function validGatewayToken(candidate: string | undefined, config: CatalogConfig): boolean {
  return typeof candidate === 'string' && constantTimeEquals(candidate, config.gatewayToken);
}
