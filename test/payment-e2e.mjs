import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

const { Client, Pool } = pg;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const authDatabaseUrl = process.env.AUTH_DATABASE_URL;
const paymentDatabaseUrl = process.env.PAYMENT_DATABASE_URL;
const kafkaBrokers = process.env.KAFKA_BROKERS ?? '127.0.0.1:19092';
assert.ok(authDatabaseUrl && paymentDatabaseUrl, 'Auth and Payment databases must point at Compose PostgreSQL');

async function unusedPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const port = server.address().port;
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

function start(name, scriptPath, env) {
  const child = spawn(process.execPath, [resolve(root, 'dist', scriptPath)], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.output = () => output;
  child.serviceName = name;
  return child;
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    delay(5000).then(() => { throw new Error(`${child.serviceName} did not stop cleanly: ${child.output()}`); }),
  ]);
}

async function ready(child, url) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`${child.serviceName} exited before ready: ${child.output()}`);
    try { const response = await fetch(`${url}/ready`, { signal: AbortSignal.timeout(500) }); if (response.ok) return; } catch { /* service is starting */ }
    await delay(100);
  }
  throw new Error(`${child.serviceName} readiness timeout: ${child.output()}`);
}

async function request(base, path, { method = 'GET', body, token, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

async function signedWebhook(gatewayUrl, event, secret, signatureOverride, rawBodyOverride) {
  const rawBody = rawBodyOverride ?? JSON.stringify(event);
  const signature = signatureOverride ?? `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const response = await fetch(`${gatewayUrl}/payments/webhook/mock`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-payment-signature': signature }, body: rawBody,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function registerAndLogin(gatewayUrl, email, password) {
  const register = await request(gatewayUrl, '/auth/register', { method: 'POST', body: { email, password, fullName: 'G4 payment e2e' } });
  assert.equal(register.status, 201, JSON.stringify(register.body));
  const login = await request(gatewayUrl, '/auth/login', { method: 'POST', body: { email, password, deviceId: `g4-${randomUUID()}` } });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { user: register.body.data, accessToken: login.body.data.accessToken };
}

async function waitFor(pool, query, params, predicate, message, attempts = 80) {
  let result;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    result = await pool.query(query, params);
    if (predicate(result.rows[0])) return result.rows[0];
    await delay(100);
  }
  throw new Error(`${message}: ${JSON.stringify(result?.rows?.[0])}`);
}

async function waitForPublished(pool, eventType, aggregateId) {
  return waitFor(pool, `SELECT published_at FROM outbox_events WHERE event_type=$1 AND aggregate_id=$2 ORDER BY occurred_at LIMIT 1`, [eventType, aggregateId], (row) => Boolean(row?.published_at), `Kafka did not acknowledge ${eventType}`);
}

const password = 'G4-Payment-E2E-password-2026!';
const gatewayToken = `g4-e2e-gateway-${randomUUID()}-token-long-enough`;
const streamingToken = `g4-e2e-streaming-${randomUUID()}-token-long-enough`;
const webhookSecret = `g4-hmac-${randomUUID()}-${randomUUID()}-secret`;
const testPlanId = `g4-test-${randomUUID()}`;
const users = [];
const paymentIds = [];
const subscriptionIds = [];
const tempDir = await mkdtemp(resolve(tmpdir(), 'movieapp-g4-'));
const migrationProbeDatabase = `payment_g4_probe_${randomUUID().replaceAll('-', '')}`;
let migrationProbeCreated = false;
let adminClient;
const keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const privateKeyPath = resolve(tempDir, 'auth-private.pem');
const publicKeyPath = resolve(tempDir, 'auth-public.pem');
await writeFile(privateKeyPath, keys.privateKey, { mode: 0o600 });
await writeFile(publicKeyPath, keys.publicKey);

const authPort = await unusedPort();
const gatewayPort = await unusedPort();
const paymentPort = await unusedPort();
const authUrl = `http://127.0.0.1:${authPort}`;
const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
const paymentUrl = `http://127.0.0.1:${paymentPort}`;
const commonEnv = {
  AUTH_DATABASE_URL: authDatabaseUrl,
  PAYMENT_DATABASE_URL: paymentDatabaseUrl,
  AUTH_JWT_ISSUER: process.env.AUTH_JWT_ISSUER ?? 'https://auth.movieapp.local',
  AUTH_JWT_AUDIENCE: process.env.AUTH_JWT_AUDIENCE ?? 'movieapp-api',
  AUTH_JWT_KID: `g4-${randomUUID()}`,
  AUTH_PRIVATE_KEY_PATH: privateKeyPath,
  AUTH_PUBLIC_KEY_PATH: publicKeyPath,
  AUTH_INTERNAL_TOKENS_JSON: JSON.stringify({ 'api-gateway': gatewayToken }),
  GATEWAY_SERVICE_TOKEN: gatewayToken,
  PAYMENT_INTERNAL_TOKENS_JSON: JSON.stringify({ 'api-gateway': gatewayToken, 'streaming-service': streamingToken }),
  PAYMENT_MOCK_ENABLED: 'true',
  PAYMENT_MOCK_HMAC_SECRET: webhookSecret,
  PAYMENT_PENDING_TTL_MINUTES: '30',
  PAYMENT_MAINTENANCE_POLL_MS: '250',
  PAYMENT_FREE_MAX_CONCURRENT_STREAMS: '1',
  PAYMENT_FREE_MAX_RESOLUTION: '720p',
  KAFKA_BROKERS: kafkaBrokers,
  AUTH_SERVICE_URL: authUrl,
  PAYMENT_SERVICE_URL: paymentUrl,
  AUTH_PORT: String(authPort),
  GATEWAY_PORT: String(gatewayPort),
  PAYMENT_PORT: String(paymentPort),
};
const pool = new Pool({ connectionString: paymentDatabaseUrl });
let authProcess; let gatewayProcess; let paymentProcess;

try {
  assert.ok(process.env.POSTGRES_ADMIN_URL, 'POSTGRES_ADMIN_URL is required for the blank-database migration check');
  const paymentRole = decodeURIComponent(new URL(paymentDatabaseUrl).username);
  assert.match(paymentRole, /^[a-z][a-z0-9_]{0,62}$/);
  adminClient = new Client({ connectionString: process.env.POSTGRES_ADMIN_URL });
  await adminClient.connect();
  await adminClient.query(`CREATE DATABASE "${migrationProbeDatabase}" OWNER "${paymentRole}"`);
  migrationProbeCreated = true;
  const probeUrl = new URL(paymentDatabaseUrl);
  probeUrl.pathname = `/${migrationProbeDatabase}`;
  execFileSync('npm', ['run', 'migration:payment:run'], {
    cwd: root,
    env: { ...process.env, PAYMENT_DATABASE_URL: probeUrl.toString() },
    stdio: 'pipe',
  });
  const probePool = new Pool({ connectionString: probeUrl.toString() });
  try {
    const probeTables = await probePool.query(`SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1::text[])`, [[
      'plans', 'subscriptions', 'payments', 'payment_requests', 'payment_webhook_receipts', 'subscription_reminders', 'purchase_guards', 'mock_provider_orders', 'outbox_events',
    ]]);
    assert.equal(probeTables.rows[0].count, 9, 'blank-database migration creates all Payment G4 tables');
    const seededPlans = await probePool.query(`SELECT count(*)::int AS count FROM plans WHERE id IN ('demo-monthly','demo-annual')`);
    assert.equal(seededPlans.rows[0].count, 2, 'development demo-plan seed is present');
    await assert.rejects(probePool.query(`INSERT INTO plans(id,name,price,currency,duration_days,max_concurrent_streams,max_resolution) VALUES('invalid-price','Invalid',-1,'VND',30,1,'720p')`), (error) => error.code === '23514');
  } finally {
    await probePool.end();
  }
  await adminClient.query(`DROP DATABASE "${migrationProbeDatabase}" WITH (FORCE)`);
  migrationProbeCreated = false;
  await adminClient.end();
  adminClient = undefined;
  console.log('PASS G4 migration: clean PostgreSQL database, all tables, demo seed and CHECK constraint');

  execFileSync('npm', ['run', 'migration:run'], { cwd: root, stdio: 'inherit', env: process.env });
  execFileSync('npm', ['run', 'migration:payment:run'], { cwd: root, stdio: 'inherit', env: process.env });
  await pool.query(`INSERT INTO plans(id,name,price,currency,duration_days,max_concurrent_streams,max_resolution,active) VALUES($1,'G4 snapshot plan',12345.67,'VND',30,3,'1440p',true)`, [testPlanId]);

  const productionConfigFailure = start('Payment production-config guard', 'apps/payment-service/main.js', {
    ...commonEnv, NODE_ENV: 'production', PAYMENT_MOCK_ENABLED: 'true',
  });
  const productionResult = await Promise.race([
    new Promise((resolveExit) => productionConfigFailure.once('exit', (code) => resolveExit({ code }))),
    delay(5000).then(() => ({ timeout: true })),
  ]);
  if (productionResult.timeout) await stop(productionConfigFailure);
  assert.equal(productionResult.timeout, undefined, 'Payment must refuse production startup with the mock enabled');
  assert.notEqual(productionResult.code, 0);
  assert.match(productionConfigFailure.output(), /Payment mock is forbidden in production/);
  console.log('PASS G4 config: mock provider fails startup in production');

  authProcess = start('Auth', 'apps/auth-service/main.js', { ...commonEnv, NODE_ENV: 'test' });
  paymentProcess = start('Payment', 'apps/payment-service/main.js', { ...commonEnv, NODE_ENV: 'test' });
  gatewayProcess = start('Gateway', 'apps/api-gateway/main.js', { ...commonEnv, NODE_ENV: 'test' });
  await Promise.all([ready(authProcess, authUrl), ready(paymentProcess, paymentUrl), ready(gatewayProcess, gatewayUrl)]);
  console.log('PASS G4 startup: Auth, Gateway and Payment are ready against Compose PostgreSQL');

  const plans = await request(gatewayUrl, '/subscriptions/plans');
  assert.equal(plans.status, 200, JSON.stringify(plans.body));
  assert.ok(plans.body.data.items.some((plan) => plan.id === 'demo-monthly'));
  assert.equal((await request(gatewayUrl, '/subscriptions/current')).status, 401);

  const owner = await registerAndLogin(gatewayUrl, `g4-owner-${randomUUID()}@example.test`, password);
  users.push(owner.user.id);
  const freeBeforePurchase = await request(paymentUrl, `/internal/subscriptions/users/${owner.user.id}/entitlement`, { headers: { 'x-caller-service': 'streaming-service', authorization: `Bearer ${streamingToken}` } });
  assert.equal(freeBeforePurchase.status, 200, JSON.stringify(freeBeforePurchase.body));
  assert.equal(freeBeforePurchase.body.data.hasSubscription, false);
  assert.deepEqual(freeBeforePurchase.body.data.limits, { maxConcurrentStreams: 1, maxResolution: '720p' });
  const noAuthOrder = await request(gatewayUrl, '/subscriptions/subscribe', { method: 'POST', body: { planId: testPlanId, paymentMethod: 'card' }, headers: { 'Idempotency-Key': `g4-no-auth-${randomUUID()}` } });
  assert.equal(noAuthOrder.status, 401);

  const idempotencyKey = `g4-order-${randomUUID()}`;
  const subscribeBody = { planId: testPlanId, paymentMethod: 'card' };
  const order = await request(gatewayUrl, '/subscriptions/subscribe', { method: 'POST', token: owner.accessToken, body: subscribeBody, headers: { 'Idempotency-Key': idempotencyKey } });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  assert.equal(order.body.data.amount, 12345.67, 'server prices the order from the selected plan');
  assert.equal(order.body.data.planSnapshot.maxConcurrentStreams, 3);
  const paymentId = order.body.data.paymentId;
  const subscriptionId = order.body.data.subscriptionId;
  paymentIds.push(paymentId); subscriptionIds.push(subscriptionId);
  const replay = await request(gatewayUrl, '/subscriptions/subscribe', { method: 'POST', token: owner.accessToken, body: subscribeBody, headers: { 'Idempotency-Key': idempotencyKey } });
  assert.equal(replay.status, 201, JSON.stringify(replay.body));
  assert.equal(replay.body.data.paymentId, paymentId);
  assert.equal(replay.body.data.idempotentReplay, true);
  const keyConflict = await request(gatewayUrl, '/subscriptions/subscribe', { method: 'POST', token: owner.accessToken, body: { ...subscribeBody, paymentMethod: 'wallet' }, headers: { 'Idempotency-Key': idempotencyKey } });
  assert.equal(keyConflict.status, 409, 'an idempotency key cannot be reused for a different request');

  const blockedPurchase = await request(gatewayUrl, '/subscriptions/subscribe', { method: 'POST', token: owner.accessToken, body: subscribeBody, headers: { 'Idempotency-Key': `g4-competitor-${randomUUID()}` } });
  assert.equal(blockedPurchase.status, 409, 'different keys cannot create two open subscriptions');
  console.log('PASS G4 subscribe: plans, server-side price snapshot, idempotent replay and open-order guard');

  const invalidSignature = await signedWebhook(gatewayUrl, { eventId: `bad-${randomUUID()}`, orderId: paymentId, status: 'success', amount: '12345.67', currency: 'VND', providerTransactionId: `txn-${randomUUID()}` }, webhookSecret, 'sha256=' + '0'.repeat(64));
  assert.equal(invalidSignature.status, 401);
  const unknownOrder = await signedWebhook(gatewayUrl, { eventId: `unknown-order-${randomUUID()}`, orderId: randomUUID(), status: 'success', amount: '12345.67', currency: 'VND', providerTransactionId: `txn-${randomUUID()}` }, webhookSecret);
  assert.equal(unknownOrder.status, 404, 'a correctly signed event cannot settle an unknown order');
  const badAmountEvent = { eventId: `amount-${randomUUID()}`, orderId: paymentId, status: 'success', amount: '1.00', currency: 'VND', providerTransactionId: `txn-${randomUUID()}` };
  const badAmount = await signedWebhook(gatewayUrl, badAmountEvent, webhookSecret);
  assert.equal(badAmount.status, 409, 'a valid signature cannot override the server amount');
  const wrongProvider = await fetch(`${gatewayUrl}/payments/webhook/unknown`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-payment-signature': 'sha256=' + '0'.repeat(64) }, body: '{}' });
  assert.equal(wrongProvider.status, 404);
  const pendingAfterReject = await pool.query(`SELECT p.status,s.status AS subscription_status FROM payments p JOIN subscriptions s ON s.id=p.subscription_id WHERE p.id=$1`, [paymentId]);
  assert.deepEqual(pendingAfterReject.rows[0], { status: 'pending', subscription_status: 'pending' });

  const successEvent = { eventId: `success-${randomUUID()}`, orderId: paymentId, status: 'success', amount: '12345.67', currency: 'VND', providerTransactionId: `txn-${randomUUID()}` };
  const rawSuccessBody = JSON.stringify(successEvent, null, 2);
  const [success1, success2] = await Promise.all([
    signedWebhook(gatewayUrl, successEvent, webhookSecret, undefined, rawSuccessBody),
    signedWebhook(gatewayUrl, successEvent, webhookSecret, undefined, rawSuccessBody),
  ]);
  assert.equal(success1.status, 200, JSON.stringify(success1.body));
  assert.equal(success2.status, 200, JSON.stringify(success2.body));
  const settled = await pool.query(`SELECT p.status,p.paid_at,s.status AS subscription_status,s.start_at,s.end_at FROM payments p JOIN subscriptions s ON s.id=p.subscription_id WHERE p.id=$1`, [paymentId]);
  assert.equal(settled.rows[0].status, 'success');
  assert.equal(settled.rows[0].subscription_status, 'active');
  const receipts = await pool.query(`SELECT count(*)::int AS count FROM payment_webhook_receipts WHERE provider='mock' AND event_id=$1`, [successEvent.eventId]);
  assert.equal(receipts.rows[0].count, 1, 'concurrent duplicate webhook is applied once');
  const successOutbox = await pool.query(`SELECT count(*)::int AS count FROM outbox_events WHERE aggregate_id=$1 AND event_type='payment.success'`, [subscriptionId]);
  assert.equal(successOutbox.rows[0].count, 1);
  await waitForPublished(pool, 'payment.success', subscriptionId);
  console.log('PASS G4 webhook: raw-body HMAC, amount validation, concurrent dedupe, one activation and Kafka ACK');

  const eventConflict = await signedWebhook(gatewayUrl, { ...successEvent, status: 'failed' }, webhookSecret);
  assert.equal(eventConflict.status, 409, 'one event ID cannot be replayed with different signed bytes');
  const failedAfterPaid = await signedWebhook(gatewayUrl, { eventId: `late-failure-${randomUUID()}`, orderId: paymentId, status: 'failed', amount: '12345.67', currency: 'VND' }, webhookSecret);
  assert.equal(failedAfterPaid.status, 200);
  assert.equal(failedAfterPaid.body.data.status, 'success', 'failed event cannot downgrade a paid order');
  const samePaidEvent = await signedWebhook(gatewayUrl, successEvent, webhookSecret, undefined, rawSuccessBody);
  assert.equal(samePaidEvent.status, 200);
  assert.equal(samePaidEvent.body.data.duplicate, true);
  const endAtBeforePlanEdit = settled.rows[0].end_at;
  await pool.query(`UPDATE plans SET name='Plan changed after purchase',price=999999.00,duration_days=365,max_concurrent_streams=8,max_resolution='8K',version=version+1,updated_at=now() WHERE id=$1`, [testPlanId]);
  const current = await request(gatewayUrl, '/subscriptions/current', { token: owner.accessToken });
  assert.equal(current.status, 200, JSON.stringify(current.body));
  assert.equal(current.body.data.plan.name, 'G4 snapshot plan');
  assert.equal(current.body.data.plan.price, 12345.67);
  assert.equal(current.body.data.plan.maxConcurrentStreams, 3);
  assert.equal(current.body.data.autoRenew, false);
  assert.equal(new Date(current.body.data.endAt).getTime(), new Date(endAtBeforePlanEdit).getTime(), 'webhook replay and plan edit do not recalculate endAt');

  const freeEntitlement = await request(paymentUrl, `/internal/subscriptions/users/${owner.user.id}/entitlement`, { headers: { 'x-caller-service': 'api-gateway', authorization: `Bearer ${gatewayToken}` } });
  assert.equal(freeEntitlement.status, 403, 'entitlement is reserved to Streaming, not the API Gateway');
  const missingInternal = await request(paymentUrl, `/internal/subscriptions/users/${owner.user.id}/entitlement`);
  assert.equal(missingInternal.status, 401);
  const paidEntitlement = await request(paymentUrl, `/internal/subscriptions/users/${owner.user.id}/entitlement`, { headers: { 'x-caller-service': 'streaming-service', authorization: `Bearer ${streamingToken}` } });
  assert.equal(paidEntitlement.status, 200, JSON.stringify(paidEntitlement.body));
  assert.equal(paidEntitlement.body.data.hasSubscription, true);
  assert.deepEqual(paidEntitlement.body.data.limits, { maxConcurrentStreams: 3, maxResolution: '1440p' });
  const reminderDate = await pool.query(`UPDATE subscriptions SET end_at=now()+interval '2 days',updated_at=now() WHERE id=$1 RETURNING end_at`, [subscriptionId]);
  const reminder = await waitFor(pool, `SELECT event_id FROM subscription_reminders WHERE subscription_id=$1`, [subscriptionId], (row) => Boolean(row?.event_id), 'Three-day reminder was not persisted');
  await waitForPublished(pool, 'subscription.expiring', subscriptionId);
  await pool.query(`SELECT * FROM (SELECT 1) AS keepalive`);
  await delay(400);
  const reminderCount = await pool.query(`SELECT count(*)::int AS count FROM subscription_reminders WHERE subscription_id=$1`, [subscriptionId]);
  assert.equal(reminderCount.rows[0].count, 1, 'maintenance retries cannot duplicate an expiry reminder');
  const expiredEntitlementAfterEnd = await pool.query(`UPDATE subscriptions SET end_at=now()-interval '1 second',updated_at=now() WHERE id=$1 RETURNING end_at`, [subscriptionId]);
  assert.ok(reminderDate.rows[0].end_at && expiredEntitlementAfterEnd.rows[0].end_at && reminder.event_id);
  const expiredEntitlement = await request(paymentUrl, `/internal/subscriptions/users/${owner.user.id}/entitlement`, { headers: { 'x-caller-service': 'streaming-service', authorization: `Bearer ${streamingToken}` } });
  assert.equal(expiredEntitlement.body.data.hasSubscription, false, 'entitlement checks endAt even before the expiry job updates status');
  assert.deepEqual(expiredEntitlement.body.data.limits, { maxConcurrentStreams: 1, maxResolution: '720p' });
  await waitFor(pool, `SELECT status FROM subscriptions WHERE id=$1`, [subscriptionId], (row) => row?.status === 'expired', 'Expiry job did not close the subscription');
  const afterExpiryOrder = await request(gatewayUrl, '/subscriptions/subscribe', { method: 'POST', token: owner.accessToken, body: subscribeBody, headers: { 'Idempotency-Key': `g4-after-expiry-${randomUUID()}` } });
  assert.equal(afterExpiryOrder.status, 201, JSON.stringify(afterExpiryOrder.body));
  assert.equal(afterExpiryOrder.body.data.amount, 999999, 'an expired active subscription no longer blocks a new purchase and the current price is snapshotted');
  paymentIds.push(afterExpiryOrder.body.data.paymentId); subscriptionIds.push(afterExpiryOrder.body.data.subscriptionId);
  console.log('PASS G4 entitlement: Streaming-only service auth, frozen limits, free fallback, endAt expiry and deduplicated reminder');

  const lateOwner = await registerAndLogin(gatewayUrl, `g4-late-${randomUUID()}@example.test`, password);
  users.push(lateOwner.user.id);
  const lateOrder = await request(gatewayUrl, '/subscriptions/subscribe', { method: 'POST', token: lateOwner.accessToken, body: subscribeBody, headers: { 'Idempotency-Key': `g4-late-${randomUUID()}` } });
  assert.equal(lateOrder.status, 201, JSON.stringify(lateOrder.body));
  const latePaymentId = lateOrder.body.data.paymentId;
  const lateSubscriptionId = lateOrder.body.data.subscriptionId;
  paymentIds.push(latePaymentId); subscriptionIds.push(lateSubscriptionId);
  await pool.query(`UPDATE payments SET payment_expires_at=now()-interval '1 second' WHERE id=$1`, [latePaymentId]);
  await pool.query(`UPDATE subscriptions SET payment_expires_at=now()-interval '1 second' WHERE id=$1`, [lateSubscriptionId]);
  await delay(500);
  const stillPending = await pool.query(`SELECT status FROM payments WHERE id=$1`, [latePaymentId]);
  assert.equal(stillPending.rows[0].status, 'pending', 'expired local timeout does not infer that the provider failed');
  await pool.query(`UPDATE mock_provider_orders SET provider_status='failed',updated_at=now() WHERE order_id=$1`, [latePaymentId]);
  await waitFor(pool, `SELECT status FROM payments WHERE id=$1`, [latePaymentId], (row) => row?.status === 'failed', 'Confirmed provider failure was not reconciled');
  const lateSuccessEvent = { eventId: `late-success-${randomUUID()}`, orderId: latePaymentId, status: 'success', amount: lateOrder.body.data.amount.toFixed(2), currency: lateOrder.body.data.currency, providerTransactionId: `txn-${randomUUID()}` };
  const lateSuccess = await signedWebhook(gatewayUrl, lateSuccessEvent, webhookSecret);
  assert.equal(lateSuccess.status, 200, JSON.stringify(lateSuccess.body));
  assert.equal(lateSuccess.body.data.status, 'reconciliation_required');
  const lateState = await pool.query(`SELECT p.status,s.status AS subscription_status FROM payments p JOIN subscriptions s ON s.id=p.subscription_id WHERE p.id=$1`, [latePaymentId]);
  assert.deepEqual(lateState.rows[0], { status: 'reconciliation_required', subscription_status: 'cancelled' });
  assert.equal(await pool.query(`SELECT count(*)::int AS count FROM subscriptions WHERE user_id=$1 AND status='active' AND end_at>now()`, [lateOwner.user.id]).then((result) => result.rows[0].count), 0, 'late success must not grant an overlapping subscription');
  await waitForPublished(pool, 'payment.reconciliation_required', latePaymentId);
  console.log('PASS G4 reconciliation: provider pending is not treated as failure; confirmed failure closes order; late success is durable without entitlement');

  const raceOwner = await registerAndLogin(gatewayUrl, `g4-race-${randomUUID()}@example.test`, password);
  users.push(raceOwner.user.id);
  const raceKeyBase = randomUUID();
  const competing = await Promise.all([
    request(gatewayUrl, '/subscriptions/subscribe', { method: 'POST', token: raceOwner.accessToken, body: subscribeBody, headers: { 'Idempotency-Key': `g4-race-a-${raceKeyBase}` } }),
    request(gatewayUrl, '/subscriptions/subscribe', { method: 'POST', token: raceOwner.accessToken, body: subscribeBody, headers: { 'Idempotency-Key': `g4-race-b-${raceKeyBase}` } }),
  ]);
  assert.equal(competing.filter((item) => item.status === 201).length, 1, 'purchase_guards serialize different concurrent idempotency keys');
  assert.equal(competing.filter((item) => item.status === 409).length, 1);
  const winningOrder = competing.find((item) => item.status === 201).body.data;
  paymentIds.push(winningOrder.paymentId); subscriptionIds.push(winningOrder.subscriptionId);
  assert.equal(await pool.query(`SELECT count(*)::int AS count FROM subscriptions WHERE user_id=$1 AND status IN ('pending','active')`, [raceOwner.user.id]).then((result) => result.rows[0].count), 1);
  console.log('PASS G4 database race: concurrent different keys create exactly one open subscription');
} catch (error) {
  console.error(error);
  for (const child of [paymentProcess, gatewayProcess, authProcess]) if (child && child.exitCode === null) console.error(`${child.serviceName} output:\n${child.output()}`);
  process.exitCode = 1;
} finally {
  if (migrationProbeCreated && adminClient) await adminClient.query(`DROP DATABASE IF EXISTS "${migrationProbeDatabase}" WITH (FORCE)`).catch(() => undefined);
  await adminClient?.end().catch(() => undefined);
  const uniquePayments = [...new Set(paymentIds)];
  const uniqueSubscriptions = [...new Set(subscriptionIds)];
  if (uniquePayments.length) {
    await pool.query(`DELETE FROM outbox_events WHERE aggregate_id=ANY($1::uuid[]) OR aggregate_id=ANY($2::uuid[])`, [uniquePayments, uniqueSubscriptions]).catch(() => undefined);
    await pool.query(`DELETE FROM subscription_reminders WHERE subscription_id=ANY($1::uuid[])`, [uniqueSubscriptions]).catch(() => undefined);
    await pool.query(`DELETE FROM payment_webhook_receipts WHERE payment_id=ANY($1::uuid[])`, [uniquePayments]).catch(() => undefined);
    await pool.query(`DELETE FROM payment_requests WHERE payment_id=ANY($1::uuid[])`, [uniquePayments]).catch(() => undefined);
    await pool.query(`DELETE FROM mock_provider_orders WHERE order_id=ANY($1::uuid[])`, [uniquePayments]).catch(() => undefined);
    await pool.query(`DELETE FROM payments WHERE id=ANY($1::uuid[])`, [uniquePayments]).catch(() => undefined);
    await pool.query(`DELETE FROM subscriptions WHERE id=ANY($1::uuid[])`, [uniqueSubscriptions]).catch(() => undefined);
  }
  if (users.length) await pool.query(`DELETE FROM purchase_guards WHERE user_id=ANY($1::uuid[])`, [users]).catch(() => undefined);
  await pool.query(`DELETE FROM plans WHERE id=$1`, [testPlanId]).catch(() => undefined);
  await pool.end();
  for (const child of [paymentProcess, gatewayProcess, authProcess]) await stop(child).catch((error) => { console.error(error); process.exitCode = 1; });
  await rm(tempDir, { recursive: true, force: true });
}

if (process.exitCode) process.exit(process.exitCode);
console.log('G4 Payment E2E passed: plans, idempotent purchases, signed raw webhook, concurrency, entitlement, expiry and reconciliation.');
