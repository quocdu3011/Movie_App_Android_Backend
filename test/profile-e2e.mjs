import 'dotenv/config';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { Kafka } from 'kafkajs';

const { Pool } = pg;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const password = 'G2-Profile-E2E-password-2026!';
const gatewayToken = 'g2-e2e-api-gateway-service-token-0123456789';
const streamingToken = 'g2-e2e-streaming-service-token-0123456789';
const catalogToken = 'g2-e2e-catalog-service-token-0123456789';
const paymentToken = 'g2-e2e-payment-service-token-0123456789';
const profileDatabaseUrl = process.env.PROFILE_DATABASE_URL;
const brokers = (process.env.KAFKA_BROKERS ?? '127.0.0.1:19092').split(',').map((item) => item.trim());
assert.ok(profileDatabaseUrl, 'PROFILE_DATABASE_URL must point at the Compose profile_db');
assert.ok(process.env.AUTH_DATABASE_URL, 'AUTH_DATABASE_URL must point at the Compose auth_db');

async function unusedPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = server.address().port;
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

function runMigration(script) {
  execFileSync('npm', ['run', script], { cwd: root, stdio: 'inherit', env: process.env });
}

function startService(name, port, extra = {}) {
  const child = spawn(process.execPath, [resolve(root, 'dist', `apps/${name}/main.js`)], {
    cwd: root,
    env: { ...process.env, ...extra, NODE_ENV: 'test', [`${name === 'api-gateway' ? 'GATEWAY' : name === 'auth-service' ? 'AUTH' : 'PROFILE'}_PORT`]: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.testOutput = () => output;
  return child;
}

async function stopService(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    delay(5_000).then(() => { throw new Error(`Service did not stop cleanly: ${child.testOutput()}`); }),
  ]);
}

async function waitReady(child, url) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Service exited during startup: ${child.testOutput()}`);
    try {
      const response = await fetch(`${url}/ready`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // The listener may not have opened yet.
    }
    await delay(100);
  }
  throw new Error(`Service readiness timed out at ${url}: ${child.testOutput()}`);
}

async function request(baseUrl, path, { method = 'GET', body, token, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function registerAndLogin(gatewayUrl, email) {
  const register = await request(gatewayUrl, '/auth/register', {
    method: 'POST', body: { email, password, fullName: 'G2 profile test' },
  });
  assert.equal(register.status, 201, JSON.stringify(register.body));
  const login = await request(gatewayUrl, '/auth/login', {
    method: 'POST', body: { email, password, deviceId: `g2-${randomUUID()}` },
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { user: register.body.data, token: login.body.data.accessToken };
}

const tempDir = await mkdtemp(resolve(tmpdir(), 'movieapp-g2-'));
const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const privateKeyPath = resolve(tempDir, 'auth-private.pem');
const publicKeyPath = resolve(tempDir, 'auth-public.pem');
await writeFile(privateKeyPath, keys.privateKey, { mode: 0o600 });
await writeFile(publicKeyPath, keys.publicKey);

const authPort = await unusedPort();
const gatewayPort = await unusedPort();
const profilePort = await unusedPort();
const authUrl = `http://127.0.0.1:${authPort}`;
const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
const profileUrl = `http://127.0.0.1:${profilePort}`;
const baseEnv = {
  AUTH_DATABASE_URL: process.env.AUTH_DATABASE_URL,
  AUTH_JWT_ISSUER: process.env.AUTH_JWT_ISSUER ?? 'https://auth.movieapp.local',
  AUTH_JWT_AUDIENCE: process.env.AUTH_JWT_AUDIENCE ?? 'movieapp-api',
  AUTH_JWT_KID: `g2-${randomUUID()}`,
  AUTH_PRIVATE_KEY_PATH: privateKeyPath,
  AUTH_PUBLIC_KEY_PATH: publicKeyPath,
  AUTH_INTERNAL_TOKENS_JSON: JSON.stringify({ 'api-gateway': gatewayToken }),
  AUTH_SERVICE_URL: authUrl,
  GATEWAY_SERVICE_TOKEN: gatewayToken,
  GATEWAY_URL: gatewayUrl,
  PROFILE_DATABASE_URL: profileDatabaseUrl,
  PROFILE_INTERNAL_TOKENS_JSON: JSON.stringify({
    'api-gateway': gatewayToken,
    'streaming-service': streamingToken,
    'catalog-service': catalogToken,
    'payment-service': paymentToken,
  }),
  PROFILE_SERVICE_URL: profileUrl,
  PROFILE_OUTBOX_POLL_MS: '250',
};

let authProcess;
let gatewayProcess;
let profileProcess;
let consumer;
let profilePool;
try {
  runMigration('migration:run');
  runMigration('migration:profile:run');
  authProcess = startService('auth-service', authPort, { ...baseEnv, AUTH_PORT: String(authPort) });
  profileProcess = startService('profile-service', profilePort, {
    ...baseEnv,
    PROFILE_PORT: String(profilePort),
    PROFILE_KAFKA_BROKERS: '127.0.0.1:1',
  });
  gatewayProcess = startService('api-gateway', gatewayPort, {
    ...baseEnv,
    GATEWAY_PORT: String(gatewayPort),
    PROFILE_SERVICE_URL: profileUrl,
  });
  await Promise.all([
    waitReady(authProcess, authUrl),
    waitReady(gatewayProcess, gatewayUrl),
    waitReady(profileProcess, profileUrl),
  ]);
  console.log('PASS G2 startup: Auth, Gateway and Profile are ready on Compose PostgreSQL');

  const userA = await registerAndLogin(gatewayUrl, `g2-${randomUUID()}@example.test`);
  const userB = await registerAndLogin(gatewayUrl, `g2-${randomUUID()}@example.test`);
  const noToken = await request(gatewayUrl, '/profiles');
  assert.equal(noToken.status, 401, 'profile routes require an authenticated session');

  const creates = await Promise.all(Array.from({ length: 6 }, (_, index) => request(gatewayUrl, '/profiles', {
    method: 'POST', token: userA.token, body: { name: `Concurrent ${index + 1}` },
    headers: { 'x-user-id': userB.user.id },
  })));
  const created = creates.filter((result) => result.status === 201);
  assert.equal(created.length, 5, `quota race must create exactly five profiles: ${JSON.stringify(creates)}`);
  assert.equal(creates.filter((result) => result.status === 409).length, 1);
  const userAProfiles = created.map((result) => result.body.data);
  assert.ok(userAProfiles.every((profile) => profile.name.startsWith('Concurrent')));
  const spoofedList = await request(gatewayUrl, '/profiles', {
    token: userA.token, headers: { 'x-user-id': userB.user.id },
  });
  assert.equal(spoofedList.status, 200);
  assert.equal(spoofedList.body.data.length, 5, 'Gateway must overwrite client-supplied user identity');
  const userBProfiles = await request(gatewayUrl, '/profiles', { token: userB.token });
  assert.equal(userBProfiles.status, 200);
  assert.deepEqual(userBProfiles.body.data, []);
  console.log('PASS G2 quota/ownership: six concurrent creates yield five; spoofed userId does not cross accounts');

  const target = userAProfiles[0];
  const forgedUser = await request(gatewayUrl, '/profiles', {
    method: 'POST', token: userA.token, body: { name: 'forged', userId: userB.user.id },
  });
  assert.equal(forgedUser.status, 400, 'client-supplied owner fields are rejected');
  const updated = await request(gatewayUrl, `/profiles/${target.id}`, {
    method: 'PATCH', token: userA.token, body: { name: 'Kids profile', isKids: true, avatarId: null },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.data.isKids, true);
  assert.equal(updated.body.data.avatarId, null);
  for (const [method, path, body] of [
    ['PATCH', `/profiles/${target.id}`, { name: 'stolen' }],
    ['DELETE', `/profiles/${target.id}`],
  ]) {
    const result = await request(gatewayUrl, path, { method, token: userB.token, body });
    assert.equal(result.status, 404, `${method} by a different owner must be hidden as not found`);
  }

  const noServiceToken = await request(profileUrl, '/internal/profiles/validate', {
    method: 'POST', body: { userId: userA.user.id, profileId: target.id },
  });
  assert.equal(noServiceToken.status, 401);
  const forbiddenService = await request(profileUrl, '/internal/profiles/validate', {
    method: 'POST', token: paymentToken, body: { userId: userA.user.id, profileId: target.id },
  });
  assert.equal(forbiddenService.status, 403, 'payment is not an allowed profile validation caller');
  const validated = await request(profileUrl, '/internal/profiles/validate', {
    method: 'POST', token: streamingToken, body: { userId: userA.user.id, profileId: target.id },
  });
  assert.equal(validated.status, 201);
  assert.equal(validated.body.data.active, true);
  assert.equal(validated.body.data.isKids, true);
  const wrongOwnerValidation = await request(profileUrl, '/internal/profiles/validate', {
    method: 'POST', token: catalogToken, body: { userId: userB.user.id, profileId: target.id },
  });
  assert.equal(wrongOwnerValidation.status, 404);
  console.log('PASS G2 internal validation: service token, caller allowlist, owner, active state and isKids are enforced');

  const deleted = await request(gatewayUrl, `/profiles/${target.id}`, { method: 'DELETE', token: userA.token });
  assert.equal(deleted.status, 204);
  const deletedAgain = await request(gatewayUrl, `/profiles/${target.id}`, { method: 'DELETE', token: userA.token });
  assert.equal(deletedAgain.status, 204, 'deleting an already soft-deleted owned profile is idempotent');
  const deletedValidation = await request(profileUrl, '/internal/profiles/validate', {
    method: 'POST', token: streamingToken, body: { userId: userA.user.id, profileId: target.id },
  });
  assert.equal(deletedValidation.status, 404);
  const stillFive = await request(gatewayUrl, '/profiles', { token: userA.token });
  assert.equal(stillFive.body.data.length, 4);
  const refilled = await request(gatewayUrl, '/profiles', {
    method: 'POST', token: userA.token, body: { name: 'Quota released' },
  });
  assert.equal(refilled.status, 201, 'soft deleting a profile releases its active slot');

  profilePool = new Pool({ connectionString: profileDatabaseUrl });
  let outboxRow;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await profilePool.query(
      `SELECT event_id, attempts, published_at, last_error, envelope
       FROM outbox_events WHERE aggregate_id = $1`, [target.id],
    );
    outboxRow = result.rows[0];
    if (outboxRow?.attempts > 0 && outboxRow.last_error) break;
    await delay(250);
  }
  assert.ok(outboxRow, 'soft-delete must insert an outbox event');
  assert.equal(outboxRow.published_at, null, 'Kafka outage must leave event durable and unpublished');
  assert.ok(outboxRow.attempts > 0, 'publisher attempted delivery while Kafka was unavailable');
  assert.ok(outboxRow.last_error, `delivery error must be observable for retry: ${JSON.stringify(outboxRow)}`);
  assert.equal(outboxRow.envelope.eventType, 'profile.deleted');
  assert.equal(outboxRow.envelope.payload.userId, userA.user.id);
  const outboxCount = await profilePool.query(
    `SELECT count(*)::int AS count FROM outbox_events WHERE aggregate_id = $1`, [target.id],
  );
  assert.equal(outboxCount.rows[0].count, 1, 'repeated deletes must not duplicate profile.deleted');
  console.log('PASS G2 outbox durability: Kafka unavailable leaves exactly one retryable profile.deleted event');

  const delivered = [];
  const kafka = new Kafka({ clientId: `profile-e2e-${randomUUID()}`, brokers, connectionTimeout: 3_000 });
  consumer = kafka.consumer({ groupId: `profile-e2e-${randomUUID()}` });
  await consumer.connect();
  await consumer.subscribe({ topic: 'profile.deleted', fromBeginning: true });
  let consumerError;
  void consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const envelope = JSON.parse(message.value.toString());
      if (envelope.payload?.userId === userA.user.id && envelope.payload?.profileId === target.id) delivered.push(envelope);
    },
  }).catch((error) => { consumerError = error; });
  await stopService(profileProcess);
  profileProcess = startService('profile-service', profilePort, {
    ...baseEnv,
    PROFILE_PORT: String(profilePort),
    PROFILE_KAFKA_BROKERS: brokers.join(','),
  });
  await waitReady(profileProcess, profileUrl);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (consumerError) throw consumerError;
    const published = await profilePool.query('SELECT published_at FROM outbox_events WHERE event_id = $1', [outboxRow.event_id]);
    if (published.rows[0]?.published_at && delivered.length === 1) break;
    await delay(250);
  }
  const published = await profilePool.query(
    'SELECT published_at, attempts FROM outbox_events WHERE event_id = $1', [outboxRow.event_id],
  );
  assert.ok(published.rows[0]?.published_at, 'outbox row must be marked only after broker acknowledgement');
  assert.equal(delivered.length, 1, 'Kafka consumer must receive exactly one event for the deleted profile');
  assert.equal(delivered[0].eventId, outboxRow.event_id);
  assert.equal(delivered[0].payload.profileId, target.id);
  console.log('PASS G2 recovery: Kafka consumer receives profile.deleted and outbox records broker acknowledgement');
  console.log('G2 Profile core E2E passed: CRUD, ownership, quota concurrency, internal validation, soft-delete, transactional outbox and Kafka recovery.');
} catch (error) {
  for (const [name, child] of [['Auth', authProcess], ['Gateway', gatewayProcess], ['Profile', profileProcess]]) {
    if (child) console.error(`${name} process output (last 5000 chars):\n${child.testOutput().slice(-5000)}`);
  }
  throw error;
} finally {
  await consumer?.disconnect().catch(() => undefined);
  await profilePool?.end();
  await stopService(gatewayProcess).catch(() => undefined);
  await stopService(authProcess).catch(() => undefined);
  await stopService(profileProcess).catch(() => undefined);
  await rm(tempDir, { recursive: true, force: true });
}
