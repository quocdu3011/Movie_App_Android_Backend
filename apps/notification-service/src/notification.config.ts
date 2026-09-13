import 'dotenv/config';
import { constantTimeEquals } from '@movie/shared-auth';
import { loadHttpServiceConfig } from '@movie/shared-config';

export const NOTIFICATION_CONFIG = Symbol('NOTIFICATION_CONFIG');
export interface NotificationConfig { port: number; databaseUrl: string; kafkaBrokers: string[]; gatewayToken: string; mockFailRecipients: Set<string>; pollMs: number; maxAttempts: number }

export function loadNotificationConfig(env: NodeJS.ProcessEnv = process.env): NotificationConfig {
  const service = loadHttpServiceConfig('notification-service', 'NOTIFICATION_PORT', 3007, env);
  const databaseUrl = env.NOTIFICATION_DATABASE_URL?.trim();
  if (!databaseUrl || !/^postgres(?:ql)?:\/\//.test(databaseUrl)) throw new Error('NOTIFICATION_DATABASE_URL must use PostgreSQL');
  let parsed: unknown;
  try { parsed = JSON.parse(env.NOTIFICATION_INTERNAL_TOKENS_JSON ?? ''); } catch { throw new Error('NOTIFICATION_INTERNAL_TOKENS_JSON must be a JSON object'); }
  const gatewayToken = parsed && !Array.isArray(parsed) && typeof parsed === 'object' ? (parsed as Record<string, unknown>)['api-gateway'] : undefined;
  if (typeof gatewayToken !== 'string' || gatewayToken.trim().length < 32) throw new Error('NOTIFICATION_INTERNAL_TOKENS_JSON must include api-gateway');
  const kafkaBrokers = (env.NOTIFICATION_KAFKA_BROKERS ?? env.KAFKA_BROKERS ?? '127.0.0.1:19092').split(',').map((value) => value.trim()).filter(Boolean);
  if (!kafkaBrokers.length || kafkaBrokers.some((value) => !/^[a-zA-Z0-9.-]+:\d{1,5}$/.test(value))) throw new Error('NOTIFICATION_KAFKA_BROKERS must contain host:port values');
  const pollMs = Number(env.NOTIFICATION_POLL_MS ?? 500);
  const maxAttempts = Number(env.NOTIFICATION_MAX_ATTEMPTS ?? 4);
  if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 60_000 || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error('Notification poll and attempt configuration is invalid');
  return { port: service.port, databaseUrl, kafkaBrokers, gatewayToken: gatewayToken.trim(), mockFailRecipients: new Set((env.NOTIFICATION_MOCK_FAIL_RECIPIENTS ?? '').split(',').map((value) => value.trim()).filter(Boolean)), pollMs, maxAttempts };
}

export function validGatewayToken(token: string | undefined, config: NotificationConfig): boolean { return Boolean(token && constantTimeEquals(token, config.gatewayToken)); }
