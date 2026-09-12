import { Inject, Injectable } from '@nestjs/common';
import { createPublicKey, KeyObject, JsonWebKey } from 'node:crypto';
import { GATEWAY_CONFIG, GatewayConfig } from '../gateway.config';

interface JwkSetResponse {
  keys?: Array<JsonWebKey & { kid?: string; use?: string; alg?: string }>;
}

@Injectable()
export class JwksClient {
  private keys = new Map<string, KeyObject>();
  private expiresAt = 0;
  private lastForcedRefreshAt = 0;
  private loading: Promise<Map<string, KeyObject>> | null = null;
  private readonly jwksUrl: string;

  constructor(@Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig) {
    this.jwksUrl = `${config.authUrl}/auth/.well-known/jwks.json`;
  }

  async getKey(kid: string): Promise<KeyObject> {
    let keys = await this.load(false);
    let key = keys.get(kid);
    if (!key) {
      const now = Date.now();
      if (now - this.lastForcedRefreshAt >= 2_000) {
        this.lastForcedRefreshAt = now;
        keys = await this.load(true);
        key = keys.get(kid);
      }
    }
    if (!key) throw new Error('Unknown signing key');
    return key;
  }

  private async load(force: boolean): Promise<Map<string, KeyObject>> {
    if (!force && this.keys.size && Date.now() < this.expiresAt) return this.keys;
    if (this.loading) return this.loading;
    this.loading = this.fetchKeys();
    try {
      return await this.loading;
    } finally {
      this.loading = null;
    }
  }

  private async fetchKeys(): Promise<Map<string, KeyObject>> {
    const response = await fetch(this.jwksUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error(`JWKS request failed with status ${response.status}`);
    const body = await response.json() as JwkSetResponse;
    if (!Array.isArray(body.keys)) throw new Error('JWKS response is malformed');
    const next = new Map<string, KeyObject>();
    for (const jwk of body.keys) {
      if (jwk.kid && jwk.kty === 'RSA' && jwk.use === 'sig' && jwk.alg === 'RS256' && jwk.n && jwk.e) {
        next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
      }
    }
    if (next.size === 0) throw new Error('JWKS contains no supported RS256 public keys');
    this.keys = next;
    this.expiresAt = Date.now() + 10 * 60_000;
    this.lastForcedRefreshAt = Date.now();
    return this.keys;
  }
}
