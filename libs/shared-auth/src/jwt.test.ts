import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import {
  loadJwtKeyPair,
  publicJwk,
  signAccessToken,
  verifyAccessToken,
} from './jwt';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pair = { kid: 'test-key-1', privateKey, publicKey };
const keyMap = new Map([[pair.kid, pair.publicKey]]);
const claims = {
  sub: 'user-1', sid: 'session-1', role: 'user' as const,
  iss: 'https://auth.test', aud: 'movieapp-test', iat: 1_700_000_000, exp: 1_700_000_900,
};

test('RS256 access token verifies and publishes only public JWK parameters', () => {
  const token = signAccessToken(claims, pair);
  assert.deepEqual(verifyAccessToken(token, keyMap, {
    issuer: claims.iss, audience: claims.aud, nowSeconds: claims.iat + 1,
  }), claims);
  const jwk = publicJwk(pair);
  assert.equal(jwk.kid, pair.kid);
  assert.equal(jwk.alg, 'RS256');
  assert.equal('d' in jwk, false);
});

test('JWT rejects wrong audience, expiry, signature and unknown kid', () => {
  const token = signAccessToken(claims, pair);
  assert.throws(() => verifyAccessToken(token, keyMap, {
    issuer: claims.iss, audience: 'wrong', nowSeconds: claims.iat + 1,
  }));
  assert.throws(() => verifyAccessToken(token, keyMap, {
    issuer: claims.iss, audience: claims.aud, nowSeconds: claims.exp,
  }));
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => verifyAccessToken(token, new Map([['test-key-1', other.publicKey]]), {
    issuer: claims.iss, audience: claims.aud, nowSeconds: claims.iat + 1,
  }));
  assert.throws(() => verifyAccessToken(token, new Map(), {
    issuer: claims.iss, audience: claims.aud, nowSeconds: claims.iat + 1,
  }));
});

test('key configuration rejects unsafe key identifiers', () => {
  assert.throws(() => loadJwtKeyPair('bad', 'bad', 'invalid kid'));
});
