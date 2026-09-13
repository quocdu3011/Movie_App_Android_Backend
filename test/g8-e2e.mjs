import 'dotenv/config';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Kafka } from 'kafkajs';
import pg from 'pg';

const { Pool } = pg;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const key of ['AUTH_DATABASE_URL', 'PROFILE_DATABASE_URL', 'CATALOG_DATABASE_URL', 'STREAMING_DATABASE_URL', 'POSTGRES_ADMIN_URL', 'NOTIFICATION_DB_PASSWORD', 'RECOMMENDATION_DB_PASSWORD', 'REDIS_URL', 'KAFKA_BROKERS']) assert.ok(process.env[key], `${key} must point to Compose infrastructure`);
function databaseUrl(name, user, password) { const value = new URL(process.env.POSTGRES_ADMIN_URL); value.username = user; value.password = password; value.pathname = `/${name}`; return value.toString(); }
const notificationDatabaseUrl = process.env.NOTIFICATION_DATABASE_URL ?? databaseUrl('notification_db', 'movieapp_notification', process.env.NOTIFICATION_DB_PASSWORD);
const recommendationDatabaseUrl = process.env.RECOMMENDATION_DATABASE_URL ?? databaseUrl('recommendation_db', 'movieapp_recommendation', process.env.RECOMMENDATION_DB_PASSWORD);

async function unusedPort() { const server = createServer(); await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); }); const port = server.address().port; await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())); return port; }
function start(name, script, env) { const child = spawn(process.execPath, [resolve(root, 'dist', script)], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; }); child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; }); child.serviceName = name; child.output = () => output; return child; }
async function stop(child) { if (!child || child.exitCode !== null) return; child.kill('SIGTERM'); await Promise.race([new Promise((resolveExit) => child.once('exit', resolveExit)), delay(5_000).then(() => { throw new Error(`${child.serviceName} did not stop cleanly: ${child.output()}`); })]); }
async function ready(child, url) { for (let attempt = 0; attempt < 100; attempt += 1) { if (child.exitCode !== null) throw new Error(`${child.serviceName} exited before ready: ${child.output()}`); try { if ((await fetch(`${url}/ready`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* starting */ } await delay(100); } throw new Error(`${child.serviceName} readiness timeout: ${child.output()}`); }
async function request(base, path, { method = 'GET', body, token, headers = {} } = {}) { const response = await fetch(`${base}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const raw = await response.text(); return { status: response.status, headers: response.headers, body: raw ? JSON.parse(raw) : null }; }
async function waitFor(check, message) { for (let attempt = 0; attempt < 120; attempt += 1) { const value = await check(); if (value) return value; await delay(100); } throw new Error(message); }

const suffix = randomUUID().replaceAll('-', '');
const gatewayToken = `g8-gateway-${randomUUID()}-${randomUUID()}`;
const catalogStreamingToken = `g8-catalog-streaming-${randomUUID()}-${randomUUID()}`;
const catalogProfileToken = `g8-catalog-profile-${randomUUID()}-${randomUUID()}`;
const catalogRecommendationToken = `g8-catalog-recommendation-${randomUUID()}-${randomUUID()}`;
const profileCatalogToken = `g8-profile-catalog-${randomUUID()}-${randomUUID()}`;
const profileStreamingToken = `g8-profile-streaming-${randomUUID()}-${randomUUID()}`;
const profileRecommendationToken = `g8-profile-recommendation-${randomUUID()}-${randomUUID()}`;
const authStreamingToken = `g8-auth-streaming-${randomUUID()}-${randomUUID()}`;
const paymentStreamingToken = `g8-payment-streaming-${randomUUID()}-${randomUUID()}`;
const catalogRecommendationInbound = `g8-catalog-recommendation-inbound-${randomUUID()}-${randomUUID()}`;
const password = 'G8-notification-recommendation-password-2026!';
const adminEmail = `g8-admin-${suffix}@example.test`;
const tempDir = await mkdtemp(resolve(tmpdir(), 'movieapp-g8-'));
const keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const privateKeyPath = resolve(tempDir, 'private.pem'); const publicKeyPath = resolve(tempDir, 'public.pem');
await writeFile(privateKeyPath, keys.privateKey, { mode: 0o600 }); await writeFile(publicKeyPath, keys.publicKey, { mode: 0o600 });
const [authPort, gatewayPort, profilePort, catalogPort, streamingPort, notificationPort, recommendationPort] = await Promise.all([unusedPort(), unusedPort(), unusedPort(), unusedPort(), unusedPort(), unusedPort(), unusedPort()]);
const urls = { auth: `http://127.0.0.1:${authPort}`, gateway: `http://127.0.0.1:${gatewayPort}`, profile: `http://127.0.0.1:${profilePort}`, catalog: `http://127.0.0.1:${catalogPort}`, streaming: `http://127.0.0.1:${streamingPort}`, notification: `http://127.0.0.1:${notificationPort}`, recommendation: `http://127.0.0.1:${recommendationPort}` };
const env = {
  AUTH_PORT: String(authPort), GATEWAY_PORT: String(gatewayPort), PROFILE_PORT: String(profilePort), CATALOG_PORT: String(catalogPort), STREAMING_PORT: String(streamingPort), NOTIFICATION_PORT: String(notificationPort), RECOMMENDATION_PORT: String(recommendationPort),
  NOTIFICATION_DATABASE_URL: notificationDatabaseUrl, RECOMMENDATION_DATABASE_URL: recommendationDatabaseUrl,
  OPENSEARCH_URL: process.env.OPENSEARCH_URL ?? 'http://127.0.0.1:9200',
  AUTH_SERVICE_URL: urls.auth, PROFILE_SERVICE_URL: urls.profile, CATALOG_SERVICE_URL: urls.catalog, STREAMING_SERVICE_URL: urls.streaming, RECOMMENDATION_SERVICE_URL: urls.recommendation, PAYMENT_SERVICE_URL: 'http://127.0.0.1:9',
  AUTH_PRIVATE_KEY_PATH: privateKeyPath, AUTH_PUBLIC_KEY_PATH: publicKeyPath, AUTH_JWT_KID: `g8-${randomUUID()}`,
  AUTH_INTERNAL_TOKENS_JSON: JSON.stringify({ 'api-gateway': gatewayToken, 'streaming-service': authStreamingToken }), GATEWAY_SERVICE_TOKEN: gatewayToken,
  PROFILE_INTERNAL_TOKENS_JSON: JSON.stringify({ 'api-gateway': gatewayToken, 'catalog-service': profileCatalogToken, 'streaming-service': profileStreamingToken, 'recommendation-service': profileRecommendationToken }), PROFILE_CATALOG_TOKEN: catalogProfileToken, PROFILE_STREAMING_TOKEN: profileStreamingToken,
  CATALOG_INTERNAL_TOKENS_JSON: JSON.stringify({ 'api-gateway': gatewayToken, 'streaming-service': catalogStreamingToken, 'profile-service': catalogProfileToken, 'recommendation-service': catalogRecommendationToken }),
  STREAMING_INTERNAL_TOKENS_JSON: JSON.stringify({ 'api-gateway': gatewayToken, 'profile-service': profileStreamingToken, 'transcode-worker': `g8-worker-${randomUUID()}-${randomUUID()}` }), STREAMING_DOWNSTREAM_TOKENS_JSON: JSON.stringify({ 'auth-service': authStreamingToken, 'profile-service': profileStreamingToken, 'catalog-service': catalogStreamingToken, 'payment-service': paymentStreamingToken }),
  RECOMMENDATION_INTERNAL_TOKENS_JSON: JSON.stringify({ 'api-gateway': gatewayToken, 'catalog-service': catalogRecommendationInbound }), RECOMMENDATION_CATALOG_TOKEN: catalogRecommendationToken, RECOMMENDATION_PROFILE_TOKEN: profileRecommendationToken,
  NOTIFICATION_INTERNAL_TOKENS_JSON: JSON.stringify({ 'api-gateway': gatewayToken }), NOTIFICATION_POLL_MS: '100', NOTIFICATION_MAX_ATTEMPTS: '3', NOTIFICATION_MOCK_FAIL_RECIPIENTS: 'fail-recipient',
  SEED_ADMIN_EMAIL: adminEmail, SEED_ADMIN_PASSWORD: password, SEED_ADMIN_FULL_NAME: 'G8 Admin', CATALOG_SYNC_POLL_MS: '250', PROFILE_OUTBOX_POLL_MS: '250', STREAMING_MAINTENANCE_POLL_MS: '250', STREAMING_OUTBOX_POLL_MS: '250',
};
const catalogPool = new Pool({ connectionString: process.env.CATALOG_DATABASE_URL }); const notificationPool = new Pool({ connectionString: notificationDatabaseUrl }); const recommendationPool = new Pool({ connectionString: recommendationDatabaseUrl });
const processes = [];
let notificationPublishedEventId; let notificationFailureEventId; let qualifiedEvent;

async function createMovie(adminToken, title, isKidsSafe) {
  const created = await request(urls.gateway, '/admin/movies', { method: 'POST', token: adminToken, body: { title, type: 'movie', isKidsSafe, averageRating: 8.5 } }); assert.equal(created.status, 201, JSON.stringify(created.body)); const movieId = created.body.data.movieId;
  const playable = await request(urls.gateway, `/admin/movies/${movieId}/playable-items`, { method: 'POST', token: adminToken, body: { kind: 'movie', label: 'Full', sortOrder: 1, durationSeconds: 120 } }); assert.equal(playable.status, 201, JSON.stringify(playable.body));
  const source = await request(urls.gateway, `/admin/movies/${movieId}/content-sources`, { method: 'POST', token: adminToken, body: { sourceType: 'third_party', provider: 'g8-fixture', externalId: `g8-${movieId}`, externalSlug: `g8-${movieId}` } }); assert.equal(source.status, 201, JSON.stringify(source.body));
  const item = await request(urls.gateway, `/admin/content-sources/${source.body.data.id}/items`, { method: 'POST', token: adminToken, body: { playableId: playable.body.data.id, serverKey: 'fixture', serverLabel: 'Fixture', externalEpisodeKey: 'full', playbackMode: 'external_hls', sourceStatus: 'available' } }); assert.equal(item.status, 201, JSON.stringify(item.body));
  const published = await request(urls.gateway, `/admin/movies/${movieId}/publish`, { method: 'POST', token: adminToken }); assert.equal(published.status, 200, JSON.stringify(published.body)); return movieId;
}
function envelope(eventType, aggregateId, payload, occurredAt = new Date()) { return { eventId: randomUUID(), eventType, schemaVersion: 1, aggregateId, aggregateVersion: '1', occurredAt: occurredAt.toISOString(), producer: 'g8-test', correlationId: 'g8-e2e', payload }; }
async function restart(name, script, url) { const index = processes.findIndex((process) => process.serviceName === name); assert.notEqual(index, -1, `${name} process is missing`); await stop(processes[index]); const replacement = start(name, script, env); processes[index] = replacement; await ready(replacement, url); }

try {
  for (const script of ['migration:run', 'migration:profile:run', 'migration:catalog:run', 'migration:streaming:run', 'migration:notification:run', 'migration:recommendation:run']) execFileSync('npm', ['run', script], { cwd: root, env: { ...process.env, ...env }, stdio: 'pipe' });
  for (const [name, script] of [['Auth', 'apps/auth-service/main.js'], ['Profile', 'apps/profile-service/main.js'], ['Catalog', 'apps/catalog-service/main.js'], ['Streaming', 'apps/streaming-service/main.js'], ['Notification', 'apps/notification-service/main.js'], ['Recommendation', 'apps/recommendation-service/main.js'], ['Gateway', 'apps/api-gateway/main.js']]) processes.push(start(name, script, env));
  await Promise.all(processes.map((process, index) => ready(process, [urls.auth, urls.profile, urls.catalog, urls.streaming, urls.notification, urls.recommendation, urls.gateway][index])));
  console.log('PASS G8 startup: Auth, Profile, Catalog, Streaming, Notification, Recommendation, Gateway, PostgreSQL and Kafka are ready');
  const admin = await request(urls.gateway, '/auth/login', { method: 'POST', body: { email: adminEmail, password, deviceId: `g8-admin-${suffix}` } }); assert.equal(admin.status, 200, JSON.stringify(admin.body));
  const ownerEmail = `g8-owner-${suffix}@example.test`; const registered = await request(urls.gateway, '/auth/register', { method: 'POST', body: { email: ownerEmail, password, fullName: 'G8 User' } }); assert.equal(registered.status, 201);
  const owner = await request(urls.gateway, '/auth/login', { method: 'POST', body: { email: ownerEmail, password, deviceId: `g8-owner-${suffix}` } }); assert.equal(owner.status, 200);
  const profile = await request(urls.gateway, '/profiles', { method: 'POST', token: owner.body.data.accessToken, body: { name: 'G8 Adult' } }); const kids = await request(urls.gateway, '/profiles', { method: 'POST', token: owner.body.data.accessToken, body: { name: 'G8 Kids', isKids: true } }); assert.equal(profile.status, 201); assert.equal(kids.status, 201);
  const watched = await createMovie(admin.body.data.accessToken, `G8 Action watched ${suffix}`, true); const suggested = await createMovie(admin.body.data.accessToken, `G8 Action older watched ${suffix}`, true); const suggestedFresh = await createMovie(admin.body.data.accessToken, `G8 Action suggested ${suffix}`, true); const kidsUnsafe = await createMovie(admin.body.data.accessToken, `G8 Action unsafe ${suffix}`, false);
  const genreId = randomUUID(); await catalogPool.query(`INSERT INTO genres(id,slug,name) VALUES($1,$2,'Action')`, [genreId, `g8-action-${suffix}`]); for (const movieId of [watched, suggested, suggestedFresh, kidsUnsafe]) await catalogPool.query(`INSERT INTO movie_genres(movie_id,genre_id) VALUES($1,$2)`, [movieId, genreId]);
  await delay(1_500);
  const producer = new Kafka({ clientId: `g8-e2e-${suffix}`, brokers: process.env.KAFKA_BROKERS.split(',') }).producer({ allowAutoTopicCreation: false }); await producer.connect();
  try {
    qualifiedEvent = envelope('playback.qualified', randomUUID(), { sessionId: randomUUID(), userId: owner.body.data.user.id, profileId: profile.body.data.id, movieId: watched, playedSeconds: 45 });
    await producer.send({ topic: 'playback.qualified', messages: [{ key: qualifiedEvent.aggregateId, value: JSON.stringify(qualifiedEvent) }, { key: qualifiedEvent.aggregateId, value: JSON.stringify(qualifiedEvent) }, { key: qualifiedEvent.aggregateId, value: JSON.stringify({ ...qualifiedEvent, eventId: randomUUID() }) }] });
    const old = envelope('playback.qualified', randomUUID(), { sessionId: randomUUID(), userId: owner.body.data.user.id, profileId: profile.body.data.id, movieId: suggested, playedSeconds: 45 }, new Date(Date.now() - 8 * 24 * 60 * 60_000)); await producer.send({ topic: 'playback.qualified', messages: [{ key: old.aggregateId, value: JSON.stringify(old) }] });
    const published = envelope('movie.published', watched, { movieId: watched }); const failingPayment = envelope('payment.success', randomUUID(), { userId: 'fail-recipient', subscriptionId: randomUUID(), paymentId: randomUUID() }); notificationPublishedEventId = published.eventId; notificationFailureEventId = failingPayment.eventId;
    await producer.send({ topic: 'movie.published', messages: [{ key: watched, value: JSON.stringify(published) }, { key: watched, value: JSON.stringify(published) }] }); await producer.send({ topic: 'payment.success', messages: [{ key: failingPayment.aggregateId, value: JSON.stringify(failingPayment) }, { key: failingPayment.aggregateId, value: JSON.stringify(failingPayment) }] });
  } finally { await producer.disconnect(); }
  await waitFor(async () => (await recommendationPool.query('SELECT count(*)::int AS count FROM watch_events WHERE profile_id=$1', [profile.body.data.id])).rows[0].count === 2, 'Recommendation did not consume qualified events idempotently');
  const recommendation = await request(urls.recommendation, `/internal/recommendations/${profile.body.data.id}`, { headers: { authorization: `Bearer ${gatewayToken}`, 'x-caller-service': 'api-gateway', 'x-user-id': owner.body.data.user.id } }); assert.equal(recommendation.status, 200, JSON.stringify(recommendation.body)); assert.equal(recommendation.body.data.items.some((item) => item.id === suggestedFresh), true, 'same-genre unseen movie is recommended');
  const kidsRecommendation = await request(urls.recommendation, `/internal/recommendations/${kids.body.data.id}`, { headers: { authorization: `Bearer ${gatewayToken}`, 'x-caller-service': 'api-gateway', 'x-user-id': owner.body.data.user.id } }); assert.equal(kidsRecommendation.status, 200); assert.equal(kidsRecommendation.body.data.items.some((item) => item.id === kidsUnsafe), false, 'kids-unsafe movies are filtered from recommendations');
  const trending = await request(urls.recommendation, '/internal/trending', { headers: { authorization: `Bearer ${gatewayToken}`, 'x-caller-service': 'api-gateway' } }); assert.equal(trending.status, 200); assert.equal(trending.body.data.items.some((item) => item.id === watched), true); assert.equal(trending.body.data.items.some((item) => item.id === suggested), false, 'views older than seven days do not trend');
  const recommendationMetrics = await (await fetch(`${urls.recommendation}/metrics`)).text(); assert.match(recommendationMetrics, /movieapp_recommendation_qualified_views [1-9]\d*/); assert.doesNotMatch(recommendationMetrics, /userId|movieId/);
  console.log('PASS G8 recommendation: one session creates one view despite replay, seven-day trending and genre/kids hydration are enforced');
  const notificationRows = await waitFor(async () => { const rows = await notificationPool.query(`SELECT id,status,event_id,recipient_id FROM notification_deliveries WHERE event_id = ANY($1::uuid[]) ORDER BY created_at`, [[notificationPublishedEventId, notificationFailureEventId]]); return rows.rows.some((row) => row.event_id === notificationPublishedEventId && row.status === 'delivered') && rows.rows.some((row) => row.event_id === notificationFailureEventId && row.status === 'dlq') ? rows.rows : null; }, 'Notification deliveries did not reach delivered and DLQ states');
  assert.equal(notificationRows.filter((row) => row.event_id === notificationPublishedEventId).length, 1, 'notification replay does not duplicate a delivery'); assert.equal(notificationRows.filter((row) => row.event_id === notificationFailureEventId).length, 1, 'failed notification replay does not duplicate a delivery');
  const dlq = notificationRows.find((row) => row.event_id === notificationFailureEventId); const replay = await request(urls.notification, `/internal/notifications/dlq/${dlq.id}/replay`, { method: 'POST', headers: { authorization: `Bearer ${gatewayToken}`, 'x-caller-service': 'api-gateway' } }); assert.equal(replay.status, 204); await waitFor(async () => (await notificationPool.query('SELECT status FROM notification_deliveries WHERE id=$1', [dlq.id])).rows[0]?.status === 'dlq', 'DLQ replay did not retry and return to DLQ');
  console.log('PASS G8 notification: recipient policy, inbox/delivery idempotency, bounded retry, DLQ and replay are durable');
  const notificationMetrics = await (await fetch(`${urls.notification}/metrics`)).text(); assert.match(notificationMetrics, /movieapp_notification_deliveries\{status="dlq"\} [1-9]\d*/); assert.doesNotMatch(notificationMetrics, /userId|movieId/);
  await restart('Recommendation', 'apps/recommendation-service/main.js', urls.recommendation); await restart('Notification', 'apps/notification-service/main.js', urls.notification);
  const afterRestartQualified = envelope('playback.qualified', randomUUID(), { sessionId: randomUUID(), userId: owner.body.data.user.id, profileId: profile.body.data.id, movieId: watched, playedSeconds: 45 }); const afterRestartNotification = envelope('subscription.expiring', randomUUID(), { userId: 'after-restart-recipient', subscriptionId: randomUUID() });
  const replayProducer = new Kafka({ clientId: `g8-restart-${suffix}`, brokers: process.env.KAFKA_BROKERS.split(',') }).producer({ allowAutoTopicCreation: false }); await replayProducer.connect(); try { await replayProducer.send({ topic: 'playback.qualified', messages: [{ key: qualifiedEvent.aggregateId, value: JSON.stringify(qualifiedEvent) }, { key: afterRestartQualified.aggregateId, value: JSON.stringify(afterRestartQualified) }] }); await replayProducer.send({ topic: 'movie.published', messages: [{ key: watched, value: JSON.stringify({ ...envelope('movie.published', watched, { movieId: watched }), eventId: notificationPublishedEventId }) }] }); await replayProducer.send({ topic: 'subscription.expiring', messages: [{ key: afterRestartNotification.aggregateId, value: JSON.stringify(afterRestartNotification) }] }); } finally { await replayProducer.disconnect(); }
  await waitFor(async () => { const views = (await recommendationPool.query('SELECT count(*)::int AS count FROM watch_events WHERE profile_id=$1', [profile.body.data.id])).rows[0].count; const deliveries = await notificationPool.query(`SELECT event_id,status FROM notification_deliveries WHERE event_id = ANY($1::uuid[])`, [[notificationPublishedEventId, afterRestartNotification.eventId]]); return views === 3 && deliveries.rows.filter((row) => row.event_id === notificationPublishedEventId).length === 1 && deliveries.rows.filter((row) => row.event_id === afterRestartNotification.eventId && row.status === 'delivered').length === 2; }, 'restarted consumers did not process new events or deduplicate replayed events');
  console.log('PASS G8 consumer restart: replayed events retain one delivery/view and restarted consumers process new events');
  const home = await request(urls.gateway, `/home?profileId=${profile.body.data.id}`, { token: owner.body.data.accessToken }); assert.equal(home.status, 200, JSON.stringify(home.body)); assert.equal(home.body.data.sections[1].type, 'recommendations', 'Gateway Home composes live Recommendation response');
  const deleted = envelope('profile.deleted', profile.body.data.id, { profileId: profile.body.data.id, userId: owner.body.data.user.id }); const cleanupProducer = new Kafka({ clientId: `g8-cleanup-${suffix}`, brokers: process.env.KAFKA_BROKERS.split(',') }).producer({ allowAutoTopicCreation: false }); await cleanupProducer.connect(); try { await cleanupProducer.send({ topic: 'profile.deleted', messages: [{ key: profile.body.data.id, value: JSON.stringify(deleted) }] }); } finally { await cleanupProducer.disconnect(); }
  await waitFor(async () => (await recommendationPool.query('SELECT count(*)::int AS count FROM watch_events WHERE profile_id=$1', [profile.body.data.id])).rows[0].count === 0, 'profile.deleted did not clean recommendation data');
  await delay(5_500);
  console.log('PASS G8 cleanup/home: profile deletion removes recommendation data and Gateway Home includes recommendation section'); console.log('G8 E2E passed.');
} finally { await Promise.all(processes.reverse().map((process) => stop(process).catch(() => undefined))); await catalogPool.end(); await notificationPool.end(); await recommendationPool.end(); await rm(tempDir, { recursive: true, force: true }); }
