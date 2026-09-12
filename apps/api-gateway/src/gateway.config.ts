import 'dotenv/config';
import { loadHttpServiceConfig } from '@movie/shared-config';

export const GATEWAY_CONFIG = Symbol('GATEWAY_CONFIG');

export interface GatewayConfig {
  port: number;
  authUrl: string;
  serviceToken: string;
  issuer: string;
  audience: string;
  origins: string[];
  nodeEnv: string;
}

export function loadGatewayConfig(): GatewayConfig {
  const serviceConfig = loadHttpServiceConfig('api-gateway', 'GATEWAY_PORT', 3000);
  const nodeEnv = serviceConfig.nodeEnv;
  const port = serviceConfig.port;
  const authUrl = process.env.AUTH_SERVICE_URL?.trim();
  const serviceToken = process.env.GATEWAY_SERVICE_TOKEN?.trim();
  const issuer = process.env.AUTH_JWT_ISSUER?.trim();
  const audience = process.env.AUTH_JWT_AUDIENCE?.trim();
  if (!authUrl || !serviceToken || !issuer || !audience) {
    throw new Error('AUTH_SERVICE_URL, GATEWAY_SERVICE_TOKEN, AUTH_JWT_ISSUER and AUTH_JWT_AUDIENCE are required');
  }
  const upstream = new URL(authUrl);
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password) {
    throw new Error('AUTH_SERVICE_URL must be an HTTP(S) origin without credentials');
  }
  if (serviceToken.length < 32) throw new Error('GATEWAY_SERVICE_TOKEN must be at least 32 characters');
  const origins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:8080')
    .split(',').map((origin) => origin.trim()).filter(Boolean);
  for (const origin of origins) {
    if (origin === '*') throw new Error('Wildcard CORS origin is not allowed');
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || (nodeEnv === 'production' && parsed.protocol !== 'https:')) {
      throw new Error('ALLOWED_ORIGINS contains an invalid origin');
    }
  }
  return { port, authUrl: upstream.origin, serviceToken, issuer, audience, origins, nodeEnv };
}
