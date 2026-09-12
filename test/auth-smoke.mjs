import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

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

async function login(email, deviceId, accountPassword = password) {
  const result = await request('/auth/login', {
    method: 'POST', body: { email, password: accountPassword, deviceId, deviceName: 'G1 smoke test' },
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
const registeredUser = await register(accountEmail);
assert.equal(registeredUser.role, 'user', 'public registration must always create a regular user');
assert.equal(registeredUser.fullName, 'G1 smoke test');
const duplicate = await request('/auth/register', {
  method: 'POST', body: { email: accountEmail.toUpperCase(), password, fullName: 'Duplicate' },
});
assert.equal(duplicate.status, 409, 'email uniqueness must ignore case');
const forgedRole = await request('/auth/register', {
  method: 'POST', body: { email: `g1-role-${randomUUID()}@example.test`, password, fullName: 'Forged Role', role: 'admin' },
});
assert.equal(forgedRole.status, 400, 'public registration must reject a supplied role');
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
assert.equal(JSON.stringify(replay.body).includes(initial.refreshToken), false, 'refresh errors must not echo secrets');
await assertSession(rotated.accessToken, 401);

// Reuse one account so this full scenario stays within the Gateway's per-IP
// registration limit while still exercising independent sessions.
const raceLogin = await login(accountEmail, 'concurrent-refresh-device');
const raceResults = await Promise.all([
  request('/auth/refresh', { method: 'POST', body: { refreshToken: raceLogin.refreshToken } }),
  request('/auth/refresh', { method: 'POST', body: { refreshToken: raceLogin.refreshToken } }),
]);
assert.equal(raceResults.filter((item) => item.status === 200).length, 1, 'only one concurrent refresh may rotate');
assert.equal(raceResults.filter((item) => item.status === 401).length, 1, 'the replayed concurrent refresh must be rejected');
const raceWinner = raceResults.find((item) => item.status === 200).body.data;
await assertSession(raceWinner.accessToken, 401);

const devices = await Promise.all(
  Array.from({ length: 6 }, (_, index) => login(accountEmail, `device-${index}`)),
);
const deviceSessions = await Promise.all(devices.map((device) =>
  request('/auth/session', { token: device.accessToken }),
));
const activeIndexes = deviceSessions.flatMap((session, index) => session.status === 200 ? [index] : []);
const revokedIndexes = deviceSessions.flatMap((session, index) => session.status === 401 ? [index] : []);
assert.equal(activeIndexes.length, 5, 'concurrent logins must leave exactly five active devices');
assert.equal(revokedIndexes.length, 1, 'concurrent logins must revoke exactly one oldest device');
const activeDevice = devices[activeIndexes[0]];
const forbidden = await request('/admin/session', { token: activeDevice.accessToken });
assert.equal(forbidden.status, 403, 'ordinary users must not enter the admin boundary');

if (process.env.SEED_ADMIN_EMAIL && process.env.SEED_ADMIN_PASSWORD) {
  const admin = await login(process.env.SEED_ADMIN_EMAIL, 'seed-admin-smoke', process.env.SEED_ADMIN_PASSWORD);
  const adminRoute = await request('/admin/session', { token: admin.accessToken });
  assert.equal(adminRoute.status, 200, 'the environment-seeded admin must enter the admin boundary');
  assert.equal(adminRoute.body.data.role, 'admin');
  const internalRoute = await request('/internal/auth/validate-session', {
    method: 'POST', body: { userId: admin.user.id, sessionId: '00000000-0000-4000-8000-000000000000' },
  });
  assert.equal(internalRoute.status, 404, 'Gateway must not expose Auth internal routes');
}

const logoutResult = await request('/auth/logout', {
  method: 'POST', body: { refreshToken: activeDevice.refreshToken },
});
assert.equal(logoutResult.status, 204);
const logoutAgain = await request('/auth/logout', {
  method: 'POST', body: { refreshToken: activeDevice.refreshToken },
});
assert.equal(logoutAgain.status, 204, 'logout must be idempotent');
await assertSession(activeDevice.accessToken, 401);

const stillActiveDevice = devices[activeIndexes.find((index) => index !== activeIndexes[0])];
const pool = new Pool({ connectionString: process.env.AUTH_DATABASE_URL });
try {
  const banned = await pool.query("UPDATE users SET status = 'banned' WHERE id = $1 RETURNING id", [stillActiveDevice.user.id]);
  assert.equal(banned.rowCount, 1, 'test fixture must ban the selected account');
} finally {
  await pool.end();
}
await assertSession(stillActiveDevice.accessToken, 401);

console.log('G1 Auth smoke passed: uniqueness, bad password, refresh replay race, concurrent login device cap, user/admin guards, logout, banned-user revoke.');
