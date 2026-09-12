import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicKey } from 'node:crypto';
import { loadHttpServiceConfig } from '@movie/shared-config';
import { JwtKeyPair, loadJwtKeyPair, publicJwk } from '@movie/shared-auth';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required configuration: ${name}`);
  return value;
}

function positiveInteger(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}`);
  }
  return value;
}

export const AUTH_CONFIG = Symbol('AUTH_CONFIG');

export interface AuthConfig {
  port: number;
  databaseUrl: string;
  issuer: string;
  audience: string;
  kid: string;
  accessTtlSeconds: number;
  refreshTtlDays: number;
  maxDevices: number;
  keyPair: JwtKeyPair;
  publicJwks: { keys: Record<string, string>[] };
  serviceTokens: Map<string, string>;
  nodeEnv: string;
}

export function loadAuthConfig(): AuthConfig {
  const serviceConfig = loadHttpServiceConfig('auth-service', 'AUTH_PORT', 3001);
  const nodeEnv = serviceConfig.nodeEnv;
  const privatePath = resolve(required('AUTH_PRIVATE_KEY_PATH'));
  const publicPath = resolve(required('AUTH_PUBLIC_KEY_PATH'));
  const kid = required('AUTH_JWT_KID');
  const publicPem = readFileSync(publicPath, 'utf8');
  const keyPair = loadJwtKeyPair(readFileSync(privatePath, 'utf8'), publicPem, kid);
  const derivedPublic = createPublicKey(keyPair.privateKey).export({ format: 'jwk' }) as Record<string, string>;
  if (keyPair.publicKey.asymmetricKeyType !== 'rsa' || (keyPair.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
    throw new Error('Auth JWT keys must be RSA with at least 2048-bit modulus');
  }
  const configuredPublic = publicJwk(keyPair);
  if (derivedPublic.n !== configuredPublic.n || derivedPublic.e !== configuredPublic.e) {
    throw new Error('Configured Auth private/public JWT keys do not match');
  }

  const jwksKeys = [configuredPublic];
  let previousKeys: Record<string, string>;
  try {
    previousKeys = JSON.parse(process.env.AUTH_JWKS_PREVIOUS_PUBLIC_KEYS_JSON ?? '{}') as Record<string, string>;
    if (!previousKeys || Array.isArray(previousKeys) || typeof previousKeys !== 'object') throw new Error();
  } catch {
    throw new Error('AUTH_JWKS_PREVIOUS_PUBLIC_KEYS_JSON must be a JSON object mapping kid to public-key path');
  }
  for (const [oldKid, oldPath] of Object.entries(previousKeys)) {
    if (oldKid === kid || !/^[A-Za-z0-9._-]{1,80}$/.test(oldKid) || typeof oldPath !== 'string' || !oldPath.trim()) {
      throw new Error('Previous JWKS key configuration is invalid');
    }
    const oldKey = createPublicKey(readFileSync(resolve(oldPath), 'utf8'));
    if (oldKey.asymmetricKeyType !== 'rsa' || (oldKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
      throw new Error(`Previous JWKS key ${oldKid} must be RSA with at least 2048-bit modulus`);
    }
    jwksKeys.push(publicJwk({ kid: oldKid, publicKey: oldKey }));
  }

  let rawTokens: Record<string, string>;
  try {
    rawTokens = JSON.parse(required('AUTH_INTERNAL_TOKENS_JSON')) as Record<string, string>;
  } catch {
    throw new Error('AUTH_INTERNAL_TOKENS_JSON must be a JSON object');
  }
  const serviceTokens = new Map<string, string>();
  for (const [service, token] of Object.entries(rawTokens)) {
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(service) || typeof token !== 'string' || token.length < 32) {
      throw new Error('Each internal service token needs a valid service name and at least 32 characters');
    }
    serviceTokens.set(service, token);
  }
  if (serviceTokens.size === 0) throw new Error('At least one internal service token is required');

  const seedVariables = ['SEED_ADMIN_EMAIL', 'SEED_ADMIN_PASSWORD', 'SEED_ADMIN_FULL_NAME'];
  const hasSeed = seedVariables.some((name) => Boolean(process.env[name]?.trim()));
  if (nodeEnv === 'production' && hasSeed) throw new Error('Admin seed variables are forbidden in production');
  if (hasSeed && seedVariables.some((name) => !process.env[name]?.trim())) {
    throw new Error('All SEED_ADMIN_* variables must be configured together');
  }

  const databaseUrl = required('AUTH_DATABASE_URL');
  if (!/^postgres(?:ql)?:\/\//.test(databaseUrl)) throw new Error('AUTH_DATABASE_URL must use PostgreSQL');
  const issuer = required('AUTH_JWT_ISSUER');
  const audience = required('AUTH_JWT_AUDIENCE');
  return {
    port: serviceConfig.port,
    databaseUrl,
    issuer,
    audience,
    kid,
    accessTtlSeconds: positiveInteger('AUTH_ACCESS_TTL_SECONDS', 900, 900),
    refreshTtlDays: positiveInteger('AUTH_REFRESH_TTL_DAYS', 30, 30),
    maxDevices: positiveInteger('AUTH_MAX_DEVICES', 5, 5),
    keyPair,
    publicJwks: { keys: jwksKeys },
    serviceTokens,
    nodeEnv,
  };
}
