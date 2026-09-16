import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const suffix = randomUUID().slice(0, 8);

async function unusedPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const address = server.address();
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  if (!address || typeof address === 'string') throw new Error('Could not allocate an HTTP port');
  return address.port;
}

function start(name, script, env) {
  const child = spawn(process.execPath, [resolve(root, 'dist', script)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  return { name, child, output: () => output };
}

async function stop(processInfo) {
  if (processInfo.child.exitCode !== null) return;
  processInfo.child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => processInfo.child.once('exit', resolveExit)),
    delay(5_000).then(() => { processInfo.child.kill('SIGKILL'); }),
  ]);
}

async function waitForReady(url, processInfo) {
  let lastError = '';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (processInfo.child.exitCode !== null) throw new Error(`${processInfo.name} exited: ${processInfo.output()}`);
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch (error) { lastError = String(error); }
    await delay(100);
  }
  throw new Error(`${processInfo.name} did not become healthy: ${lastError}\n${processInfo.output()}`);
}

async function request(base, path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      'x-request-id': `admin-e2e-${suffix}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(8_000),
  });
  const payload = response.status === 204 ? null : await response.json();
  return { status: response.status, payload };
}

function requireSuccess(response, expected = 200) {
  assert.equal(response.status, expected, JSON.stringify(response.payload));
  assert.equal(response.payload?.success, true, JSON.stringify(response.payload));
  return response.payload.data;
}

async function login(base, email, password) {
  const response = await request(base, '/auth/login', {
    method: 'POST',
    body: { email, password, deviceId: randomUUID(), deviceName: `admin-e2e-${suffix}` },
  });
  return requireSuccess(response).accessToken;
}

const ports = await Promise.all(Array.from({ length: 5 }, unusedPort));
const [authPort, profilePort, paymentPort, streamingPort, gatewayPort] = ports;
const urls = {
  auth: `http://127.0.0.1:${authPort}`,
  profile: `http://127.0.0.1:${profilePort}`,
  payment: `http://127.0.0.1:${paymentPort}`,
  streaming: `http://127.0.0.1:${streamingPort}`,
  gateway: `http://127.0.0.1:${gatewayPort}`,
};
const env = {
  ...process.env,
  NODE_ENV: 'test',
  AUTH_PORT: String(authPort), PROFILE_PORT: String(profilePort), PAYMENT_PORT: String(paymentPort), STREAMING_PORT: String(streamingPort), GATEWAY_PORT: String(gatewayPort),
  AUTH_SERVICE_URL: urls.auth, PROFILE_SERVICE_URL: urls.profile, PAYMENT_SERVICE_URL: urls.payment, STREAMING_SERVICE_URL: urls.streaming,
};
const processes = [
  start('auth', 'apps/auth-service/main.js', env),
  start('profile', 'apps/profile-service/main.js', env),
  start('payment', 'apps/payment-service/main.js', env),
  start('streaming', 'apps/streaming-service/main.js', env),
];

try {
  await Promise.all([waitForReady(urls.auth, processes[0]), waitForReady(urls.profile, processes[1]), waitForReady(urls.payment, processes[2]), waitForReady(urls.streaming, processes[3])]);
  const gateway = start('gateway', 'apps/api-gateway/main.js', env);
  processes.push(gateway);
  await waitForReady(urls.gateway, gateway);

  const adminEmail = process.env.SEED_ADMIN_EMAIL;
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  assert.ok(adminEmail && adminPassword, 'SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are required for admin E2E');
  const adminToken = await login(urls.gateway, adminEmail, adminPassword);
  const adminSession = requireSuccess(await request(urls.gateway, '/admin/session', { token: adminToken }));
  assert.equal(adminSession.role, 'admin');

  const password = `E2e!${randomUUID()}Aa`;
  const supportEmail = `support-${suffix}@admin-e2e.test`;
  const userEmail = `user-${suffix}@admin-e2e.test`;
  requireSuccess(await request(urls.gateway, '/auth/register', { method: 'POST', body: { email: supportEmail, password, fullName: 'Admin E2E Support' } }), 201);
  const ordinary = requireSuccess(await request(urls.gateway, '/auth/register', { method: 'POST', body: { email: userEmail, password, fullName: 'Admin E2E User' } }), 201);

  const promoted = requireSuccess(await request(urls.gateway, '/admin/staff', { method: 'POST', token: adminToken, body: { email: supportEmail, role: 'support', reason: 'Create support account for administrator API integration test' } }), 201);
  assert.equal(promoted.role, 'support');
  const supportToken = await login(urls.gateway, supportEmail, password);
  const supportSession = requireSuccess(await request(urls.gateway, '/admin/session', { token: supportToken }));
  assert.equal(supportSession.role, 'support');

  const userList = requireSuccess(await request(urls.gateway, `/admin/users?email=${encodeURIComponent(userEmail)}`, { token: supportToken }));
  assert.equal(userList.items.some((item) => item.id === ordinary.id), true);
  requireSuccess(await request(urls.gateway, `/admin/users/${ordinary.id}`, { token: supportToken }));
  requireSuccess(await request(urls.gateway, `/admin/users/${ordinary.id}/profiles`, { token: supportToken }));
  requireSuccess(await request(urls.gateway, `/admin/users/${ordinary.id}/sessions`, { token: supportToken }));
  requireSuccess(await request(urls.gateway, `/admin/users/${ordinary.id}/subscriptions`, { token: supportToken }));

  const missingReason = await request(urls.gateway, `/admin/users/${ordinary.id}/suspend`, { method: 'POST', token: supportToken, body: {} });
  assert.equal(missingReason.status, 400);
  requireSuccess(await request(urls.gateway, `/admin/users/${ordinary.id}/suspend`, { method: 'POST', token: supportToken, body: { reason: 'Suspend ordinary test account for session revocation verification' } }));
  const rejectedLogin = await request(urls.gateway, '/auth/login', { method: 'POST', body: { email: userEmail, password, deviceId: randomUUID(), deviceName: 'blocked-user' } });
  assert.equal(rejectedLogin.status, 401);
  requireSuccess(await request(urls.gateway, `/admin/users/${ordinary.id}/unsuspend`, { method: 'POST', token: supportToken, body: { reason: 'Restore ordinary test account after suspension verification' } }));
  const ordinaryToken = await login(urls.gateway, userEmail, password);
  assert.ok(ordinaryToken);
  const sessions = requireSuccess(await request(urls.gateway, `/admin/users/${ordinary.id}/sessions`, { token: supportToken }));
  assert.ok(sessions.items[0]?.id);
  requireSuccess(await request(urls.gateway, `/admin/users/${ordinary.id}/sessions/${sessions.items[0].id}/revoke`, { method: 'POST', token: supportToken, body: { reason: 'Revoke one ordinary account session during administrator API test' } }));
  requireSuccess(await request(urls.gateway, `/admin/users/${ordinary.id}/sessions/revoke-all`, { method: 'POST', token: supportToken, body: { reason: 'Revoke all ordinary account sessions during administrator API test' } }));

  const supportPlans = await request(urls.gateway, '/admin/plans', { token: supportToken });
  assert.equal(supportPlans.status, 403);
  requireSuccess(await request(urls.gateway, '/admin/plans', { token: adminToken }));
  const noReasonPlan = await request(urls.gateway, '/admin/plans', { method: 'POST', token: adminToken, body: { name: `Invalid ${suffix}`, price: 0, durationDays: 30, maxConcurrentStreams: 1, maxResolution: '720p' } });
  assert.equal(noReasonPlan.status, 400);
  const plan = requireSuccess(await request(urls.gateway, '/admin/plans', { method: 'POST', token: adminToken, body: { name: `Admin E2E ${suffix}`, price: 0, durationDays: 30, maxConcurrentStreams: 1, maxResolution: '720p', reason: 'Create a temporary free plan for administrator API integration test' } }), 201);
  requireSuccess(await request(urls.gateway, `/admin/plans/${plan.id}`, { method: 'PATCH', token: adminToken, body: { active: false, reason: 'Deactivate temporary administrator API integration test plan' } }));
  requireSuccess(await request(urls.gateway, '/admin/transactions', { token: supportToken }));

  const playback = requireSuccess(await request(urls.gateway, '/admin/playback-sessions', { token: adminToken }));
  assert.ok(Array.isArray(playback.items));
  assert.equal(playback.items.every((item) => item.leaseStatus === 'active'), true, 'default playback view only includes live leases');
  const playbackHistory = requireSuccess(await request(urls.gateway, '/admin/playback-sessions?status=all', { token: adminToken }));
  assert.equal(playbackHistory.items.every((item) => item.leaseStatus === 'active' || item.leaseStatus === 'stale'), true);
  const invalidPlaybackStatus = await request(urls.gateway, '/admin/playback-sessions?status=invalid', { token: adminToken });
  assert.equal(invalidPlaybackStatus.status, 400);
  const supportPlayback = await request(urls.gateway, '/admin/playback-sessions', { token: supportToken });
  assert.equal(supportPlayback.status, 403);
  const invalidTerminate = await request(urls.gateway, `/admin/playback-sessions/${randomUUID()}/terminate`, { method: 'POST', token: adminToken, body: { reason: 'Verify administrator playback session termination route validation' } });
  assert.equal(invalidTerminate.status, 404);

  const audit = requireSuccess(await request(urls.gateway, `/admin/audit-logs?targetUserId=${ordinary.id}`, { token: supportToken }));
  assert.equal(audit.items.some((item) => item.action === 'user.suspended'), true);
  assert.equal(audit.items.some((item) => item.action === 'user.unsuspended'), true);
  const overview = requireSuccess(await request(urls.gateway, '/admin/overview', { token: adminToken }));
  assert.equal(typeof overview.activeUsers, 'number');
  requireSuccess(await request(urls.gateway, `/admin/staff/${promoted.id}`, { method: 'PATCH', token: adminToken, body: { role: 'content_editor', reason: 'Verify staff role updates through administrator API integration test' } }));
  const staff = requireSuccess(await request(urls.gateway, '/admin/staff', { token: adminToken }));
  assert.equal(staff.items.some((item) => item.id === promoted.id && item.role === 'content_editor'), true);
  const removedStaff = await request(urls.gateway, `/admin/staff/${promoted.id}`, { method: 'DELETE', token: adminToken, body: { reason: 'Remove temporary staff account after administrator API integration test' } });
  assert.equal(removedStaff.status, 204);
  const deletedUser = await request(urls.gateway, `/admin/users/${ordinary.id}`, { method: 'DELETE', token: adminToken, body: { reason: 'Delete temporary ordinary account after administrator API integration test' } });
  assert.equal(deletedUser.status, 202);

  console.log('PASS admin API integration: session roles, user/profile/session/subscription reads, suspension and session revocation, staff lifecycle, user deletion, plan policy, transaction permissions, playback permissions, audit logs and overview');
} finally {
  await Promise.all(processes.reverse().map((processInfo) => stop(processInfo).catch(() => undefined)));
}
