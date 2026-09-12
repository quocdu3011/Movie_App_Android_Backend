import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const baseUrl = (process.env.GATEWAY_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const password = 'Local-Smoke-Password-2026!';

async function request(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function register(email) {
  const result = await request('/auth/register', {
    method: 'POST', body: { email, password, fullName: 'G1 smoke test' },
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.data;
}

async function login(email, deviceId) {
  const result = await request('/auth/login', {
    method: 'POST', body: { email, password, deviceId, deviceName: 'G1 smoke test' },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.data;
}

async function assertSession(token, expectedStatus = 200) {
  const result = await request('/auth/session', { token });
  assert.equal(result.status, expectedStatus, JSON.stringify(result.body));
  return result.body?.data;
}

const accountEmail = `g1-${randomUUID()}@example.test`;
await register(accountEmail);
const duplicate = await request('/auth/register', {
  method: 'POST', body: { email: accountEmail.toUpperCase(), password, fullName: 'Duplicate' },
});
assert.equal(duplicate.status, 409, 'email uniqueness must ignore case');
const badLogin = await request('/auth/login', {
  method: 'POST', body: { email: accountEmail, password: 'wrong', deviceId: 'wrong-password-device' },
});
assert.equal(badLogin.status, 401);

const initial = await login(accountEmail, 'refresh-device');
assert.equal((await assertSession(initial.accessToken)).userId, initial.user.id);
const rotation = await request('/auth/refresh', { method: 'POST', body: { refreshToken: initial.refreshToken } });
assert.equal(rotation.status, 200, JSON.stringify(rotation.body));
const rotated = rotation.body.data;
assert.notEqual(rotated.refreshToken, initial.refreshToken);
const replay = await request('/auth/refresh', { method: 'POST', body: { refreshToken: initial.refreshToken } });
assert.equal(replay.status, 401, 'replaying a used refresh token must fail');
await assertSession(rotated.accessToken, 401);

const raceEmail = `g1-race-${randomUUID()}@example.test`;
await register(raceEmail);
const raceLogin = await login(raceEmail, 'concurrent-refresh-device');
const raceResults = await Promise.all([
  request('/auth/refresh', { method: 'POST', body: { refreshToken: raceLogin.refreshToken } }),
  request('/auth/refresh', { method: 'POST', body: { refreshToken: raceLogin.refreshToken } }),
]);
assert.equal(raceResults.filter((item) => item.status === 200).length, 1, 'only one concurrent refresh may rotate');
assert.equal(raceResults.filter((item) => item.status === 401).length, 1, 'the replayed concurrent refresh must be rejected');
const raceWinner = raceResults.find((item) => item.status === 200).body.data;
await assertSession(raceWinner.accessToken, 401);

const deviceEmail = `g1-devices-${randomUUID()}@example.test`;
await register(deviceEmail);
const devices = [];
for (let index = 0; index < 6; index += 1) devices.push(await login(deviceEmail, `device-${index}`));
await assertSession(devices[0].accessToken, 401);
for (const active of devices.slice(1)) await assertSession(active.accessToken, 200);
const forbidden = await request('/admin/session', { token: devices[1].accessToken });
assert.equal(forbidden.status, 403, 'ordinary users must not enter the admin boundary');

const logoutResult = await request('/auth/logout', {
  method: 'POST', body: { refreshToken: devices[5].refreshToken },
});
assert.equal(logoutResult.status, 204);
const logoutAgain = await request('/auth/logout', {
  method: 'POST', body: { refreshToken: devices[5].refreshToken },
});
assert.equal(logoutAgain.status, 204, 'logout must be idempotent');
await assertSession(devices[5].accessToken, 401);

console.log('G1 Auth smoke passed: case-insensitive uniqueness, bad password, rotation/reuse revoke, 5-device cap, admin denial, logout/revoke.');
