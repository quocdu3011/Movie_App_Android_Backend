import 'dotenv/config';
import { loadHttpServiceConfig } from '@movie/shared-config';

export const GATEWAY_CONFIG = Symbol('GATEWAY_CONFIG');

export interface GatewayConfig {
  port: number;
  authUrl: string;
  profileUrl: string;
  catalogUrl: string;
  paymentUrl: string;
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
  const profileUrl = process.env.PROFILE_SERVICE_URL?.trim() ?? 'http://127.0.0.1:3002';
  const catalogUrl = process.env.CATALOG_SERVICE_URL?.trim() ?? 'http://127.0.0.1:3003';
  const paymentUrl = process.env.PAYMENT_SERVICE_URL?.trim() ?? 'http://127.0.0.1:3004';
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
  const profileUpstream = new URL(profileUrl);
  if (!['http:', 'https:'].includes(profileUpstream.protocol) || profileUpstream.username || profileUpstream.password) {
    throw new Error('PROFILE_SERVICE_URL must be an HTTP(S) origin without credentials');
  }
  const catalogUpstream = new URL(catalogUrl);
  if (!['http:', 'https:'].includes(catalogUpstream.protocol) || catalogUpstream.username || catalogUpstream.password) {
    throw new Error('CATALOG_SERVICE_URL must be an HTTP(S) origin without credentials');
  }
  const paymentUpstream = new URL(paymentUrl);
  if (!['http:', 'https:'].includes(paymentUpstream.protocol) || paymentUpstream.username || paymentUpstream.password) {
    throw new Error('PAYMENT_SERVICE_URL must be an HTTP(S) origin without credentials');
  }
  if (nodeEnv === 'production' && !process.env.PROFILE_SERVICE_URL?.trim()) {
    throw new Error('PROFILE_SERVICE_URL is required in production');
  }
  if (nodeEnv === 'production' && !process.env.CATALOG_SERVICE_URL?.trim()) {
    throw new Error('CATALOG_SERVICE_URL is required in production');
  }
  if (nodeEnv === 'production' && !process.env.PAYMENT_SERVICE_URL?.trim()) {
    throw new Error('PAYMENT_SERVICE_URL is required in production');
  }
  const origins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:8080')
    .split(',').map((origin) => origin.trim()).filter(Boolean);
  for (const origin of origins) {
    if (origin === '*') throw new Error('Wildcard CORS origin is not allowed');
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || (nodeEnv === 'production' && parsed.protocol !== 'https:')) {
      throw new Error('ALLOWED_ORIGINS contains an invalid origin');
    }
  }
  return { port, authUrl: upstream.origin, profileUrl: profileUpstream.origin, catalogUrl: catalogUpstream.origin, paymentUrl: paymentUpstream.origin, serviceToken, issuer, audience, origins, nodeEnv };
}
