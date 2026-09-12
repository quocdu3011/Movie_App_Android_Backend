import {
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  role: 'user' | 'admin' | 'content_manager';
  iss: string;
  aud: string | string[];
  iat: number;
  exp: number;
}

export interface JwtKeyPair {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export interface VerifyJwtOptions {
  issuer: string;
  audience: string;
  nowSeconds?: number;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeJson(value: string): Record<string, unknown> {
  const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('JWT segment must be a JSON object');
  }
  return decoded as Record<string, unknown>;
}

export function loadJwtKeyPair(privatePem: string, publicPem: string, kid: string): JwtKeyPair {
  if (!kid || !/^[A-Za-z0-9._-]{1,80}$/.test(kid)) throw new Error('AUTH_JWT_KID is invalid');
  return {
    kid,
    privateKey: createPrivateKey(privatePem),
    publicKey: createPublicKey(publicPem),
  };
}

export function signAccessToken(
  claims: AccessTokenClaims,
  keyPair: Pick<JwtKeyPair, 'kid' | 'privateKey'>,
): string {
  const header = encode({ alg: 'RS256', typ: 'JWT', kid: keyPair.kid });
  const payload = encode(claims);
  const input = `${header}.${payload}`;
  const signature = cryptoSign('RSA-SHA256', Buffer.from(input), keyPair.privateKey).toString('base64url');
  return `${input}.${signature}`;
}

export function verifyAccessToken(
  token: string,
  publicKeys: ReadonlyMap<string, KeyObject>,
  options: VerifyJwtOptions,
): AccessTokenClaims {
  if (token.length > 16_384) throw new Error('JWT too large');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw new Error('Malformed JWT');

  const header = decodeJson(parts[0]);
  if (header.alg !== 'RS256' || header.typ !== 'JWT' || typeof header.kid !== 'string') {
    throw new Error('Unsupported JWT header');
  }
  const key = publicKeys.get(header.kid);
  if (!key) throw new Error('Unknown JWT key id');

  const signature = Buffer.from(parts[2], 'base64url');
  if (!cryptoVerify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, signature)) {
    throw new Error('Invalid JWT signature');
  }

  const payload = decodeJson(parts[1]);
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const aud = payload.aud;
  const audienceMatches = aud === options.audience || (Array.isArray(aud) && aud.includes(options.audience));
  if (payload.iss !== options.issuer || !audienceMatches) throw new Error('Invalid JWT issuer or audience');
  if (typeof payload.exp !== 'number' || !Number.isSafeInteger(payload.exp) || payload.exp <= now) {
    throw new Error('Expired or invalid JWT expiry');
  }
  if (typeof payload.iat !== 'number' || !Number.isSafeInteger(payload.iat) || payload.iat > now + 60) {
    throw new Error('Invalid JWT issued-at time');
  }
  if (typeof payload.sub !== 'string' || !payload.sub || typeof payload.sid !== 'string' || !payload.sid) {
    throw new Error('JWT subject/session is missing');
  }
  if (!['user', 'admin', 'content_manager'].includes(String(payload.role))) {
    throw new Error('Invalid JWT role');
  }

  return payload as unknown as AccessTokenClaims;
}

export function publicJwk(keyPair: Pick<JwtKeyPair, 'kid' | 'publicKey'>): Record<string, string> {
  const jwk = keyPair.publicKey.export({ format: 'jwk' }) as Record<string, string>;
  return { ...jwk, kid: keyPair.kid, use: 'sig', alg: 'RS256' };
}

export function publicJwksFromPem(publicPem: string, kid: string): { keys: Record<string, string>[] } {
  const publicKey = createPublicKey(publicPem);
  return { keys: [publicJwk({ kid, publicKey })] };
}
