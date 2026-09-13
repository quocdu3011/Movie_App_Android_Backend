import 'dotenv/config';
import { loadHttpServiceConfig } from '@movie/shared-config';

export const PROFILE_CONFIG = Symbol('PROFILE_CONFIG');

export interface ProfileConfig {
  port: number;
  databaseUrl: string;
  serviceTokens: Map<string, string>;
  kafkaBrokers: string[];
  outboxPollMs: number;
  catalogUrl: string;
  catalogToken: string;
  streamingUrl: string;
  streamingToken: string;
  nodeEnv: string;
}

function parseServiceTokens(raw: string): Map<string, string> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error();
  } catch {
    throw new Error('PROFILE_INTERNAL_TOKENS_JSON must be a JSON object');
  }
  const tokens = new Map<string, string>();
  for (const [service, token] of Object.entries(parsed)) {
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(service) || typeof token !== 'string' || token.trim().length < 32) {
      throw new Error('Each profile service token needs a valid service name and at least 32 characters');
    }
    if ([...tokens.values()].includes(token)) throw new Error('Profile service tokens must be unique per caller');
    tokens.set(service, token);
  }
  if (tokens.size === 0) throw new Error('At least one profile service token is required');
  return tokens;
}

function origin(raw: string | undefined, name: string, fallback: string, nodeEnv: string): string {
  let parsed: URL;
  try { parsed = new URL(raw?.trim() || fallback); } catch { throw new Error(`${name} must be a URL`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || (nodeEnv === 'production' && parsed.protocol !== 'https:')) {
    throw new Error(`${name} must be a safe HTTP(S) origin without credentials`);
  }
  return parsed.origin;
}

function downstreamToken(raw: string | undefined, name: string): string {
  if (!raw) return '';
  if (raw.trim().length < 32) throw new Error(`${name} must be at least 32 characters`);
  return raw.trim();
}

export function loadProfileConfig(env: NodeJS.ProcessEnv = process.env): ProfileConfig {
  const service = loadHttpServiceConfig('profile-service', 'PROFILE_PORT', 3002, env);
  const databaseUrl = env.PROFILE_DATABASE_URL?.trim();
  if (!databaseUrl || !/^postgres(?:ql)?:\/\//.test(databaseUrl)) {
    throw new Error('PROFILE_DATABASE_URL must use PostgreSQL');
  }
  const rawTokens = env.PROFILE_INTERNAL_TOKENS_JSON?.trim();
  if (!rawTokens) throw new Error('PROFILE_INTERNAL_TOKENS_JSON is required');
  const brokers = (env.PROFILE_KAFKA_BROKERS ?? env.KAFKA_BROKERS ?? '127.0.0.1:19092')
    .split(',').map((broker) => broker.trim()).filter(Boolean);
  if (brokers.length === 0 || brokers.some((broker) => !/^[a-zA-Z0-9.-]+:\d{1,5}$/.test(broker))) {
    throw new Error('PROFILE_KAFKA_BROKERS must be a comma-separated list of host:port values');
  }
  const rawPoll = env.PROFILE_OUTBOX_POLL_MS;
  const outboxPollMs = rawPoll === undefined ? 1000 : Number(rawPoll);
  if (!Number.isSafeInteger(outboxPollMs) || outboxPollMs < 250 || outboxPollMs > 60_000) {
    throw new Error('PROFILE_OUTBOX_POLL_MS must be an integer from 250 to 60000');
  }
  return {
    port: service.port,
    databaseUrl,
    serviceTokens: parseServiceTokens(rawTokens),
    kafkaBrokers: brokers,
    outboxPollMs,
    catalogUrl: origin(env.CATALOG_SERVICE_URL, 'CATALOG_SERVICE_URL', 'http://127.0.0.1:3003', service.nodeEnv),
    catalogToken: downstreamToken(env.PROFILE_CATALOG_TOKEN, 'PROFILE_CATALOG_TOKEN'),
    streamingUrl: origin(env.STREAMING_SERVICE_URL, 'STREAMING_SERVICE_URL', 'http://127.0.0.1:3005', service.nodeEnv),
    streamingToken: downstreamToken(env.PROFILE_STREAMING_TOKEN, 'PROFILE_STREAMING_TOKEN'),
    nodeEnv: service.nodeEnv,
  };
}
