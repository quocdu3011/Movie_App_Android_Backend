import 'dotenv/config';
import { constantTimeEquals } from '@movie/shared-auth';
import { loadHttpServiceConfig } from '@movie/shared-config';

export const RECOMMENDATION_CONFIG = Symbol('RECOMMENDATION_CONFIG');

export interface RecommendationConfig {
  port: number;
  databaseUrl: string;
  kafkaBrokers: string[];
  serviceTokens: Map<'api-gateway' | 'catalog-service', string>;
  catalogUrl: string;
  catalogToken: string;
  profileUrl: string;
  profileToken: string;
}

function origin(value: string | undefined, name: string, fallback: string): string {
  let parsed: URL;
  try { parsed = new URL(value?.trim() || fallback); } catch { throw new Error(`${name} must be a URL`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(`${name} must be an HTTP(S) origin without credentials`);
  return parsed.origin;
}

function tokens(raw: string | undefined): Map<'api-gateway' | 'catalog-service', string> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw ?? ''); } catch { throw new Error('RECOMMENDATION_INTERNAL_TOKENS_JSON must be a JSON object'); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('RECOMMENDATION_INTERNAL_TOKENS_JSON must be a JSON object');
  const output = new Map<'api-gateway' | 'catalog-service', string>();
  for (const caller of ['api-gateway', 'catalog-service'] as const) {
    const value = (parsed as Record<string, unknown>)[caller];
    if (typeof value !== 'string' || value.trim().length < 32) throw new Error(`RECOMMENDATION_INTERNAL_TOKENS_JSON must include ${caller}`);
    output.set(caller, value.trim());
  }
  if (new Set(output.values()).size !== output.size) throw new Error('Recommendation service tokens must be unique');
  return output;
}

export function loadRecommendationConfig(env: NodeJS.ProcessEnv = process.env): RecommendationConfig {
  const service = loadHttpServiceConfig('recommendation-service', 'RECOMMENDATION_PORT', 3008, env);
  const databaseUrl = env.RECOMMENDATION_DATABASE_URL?.trim();
  if (!databaseUrl || !/^postgres(?:ql)?:\/\//.test(databaseUrl)) throw new Error('RECOMMENDATION_DATABASE_URL must use PostgreSQL');
  const kafkaBrokers = (env.RECOMMENDATION_KAFKA_BROKERS ?? env.KAFKA_BROKERS ?? '127.0.0.1:19092').split(',').map((value) => value.trim()).filter(Boolean);
  if (!kafkaBrokers.length || kafkaBrokers.some((value) => !/^[a-zA-Z0-9.-]+:\d{1,5}$/.test(value))) throw new Error('RECOMMENDATION_KAFKA_BROKERS must contain host:port values');
  const catalogToken = env.RECOMMENDATION_CATALOG_TOKEN?.trim();
  const profileToken = env.RECOMMENDATION_PROFILE_TOKEN?.trim();
  if (!catalogToken || catalogToken.length < 32 || !profileToken || profileToken.length < 32) throw new Error('RECOMMENDATION_CATALOG_TOKEN and RECOMMENDATION_PROFILE_TOKEN must be at least 32 characters');
  return { port: service.port, databaseUrl, kafkaBrokers, serviceTokens: tokens(env.RECOMMENDATION_INTERNAL_TOKENS_JSON), catalogUrl: origin(env.CATALOG_SERVICE_URL, 'CATALOG_SERVICE_URL', 'http://127.0.0.1:3003'), catalogToken, profileUrl: origin(env.PROFILE_SERVICE_URL, 'PROFILE_SERVICE_URL', 'http://127.0.0.1:3002'), profileToken };
}

export function validRecommendationToken(token: string | undefined, caller: string | undefined, config: RecommendationConfig): boolean {
  const expected = caller ? config.serviceTokens.get(caller as 'api-gateway' | 'catalog-service') : undefined;
  return Boolean(expected && token && constantTimeEquals(expected, token));
}
