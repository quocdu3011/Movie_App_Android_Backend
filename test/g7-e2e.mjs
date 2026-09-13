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
for (const key of ['AUTH_DATABASE_URL', 'PROFILE_DATABASE_URL', 'CATALOG_DATABASE_URL', 'STREAMING_DATABASE_URL', 'REDIS_URL', 'KAFKA_BROKERS']) {
  assert.ok(process.env[key], `${key} must point to running Compose infrastructure`);
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const port = server.address().port;
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

function start(name, script, env) {
  const child = spawn(process.execPath, [resolve(root, 'dist', script)], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.serviceName = name;
  child.output = () => output;
  return child;
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    delay(5_000).then(() => { throw new Error(`${child.serviceName} did not stop cleanly: ${child.output()}`); }),
  ]);
}

async function ready(child, url) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`${child.serviceName} exited before ready: ${child.output()}`);
    try { if ((await fetch(`${url}/ready`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* starting */ }
    await delay(100);
  }
  throw new Error(`${child.serviceName} readiness timeout: ${child.output()}`);
}

async function request(base, path, { method = 'GET', body, token, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const raw = await response.text();
  return { status: response.status, headers: response.headers, body: raw ? JSON.parse(raw) : null };
}

async function waitFor(check, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  throw new Error(message);
}

const suffix = randomUUID().replaceAll('-', '');
const gatewayToken = `g7-gateway-${randomUUID()}-${randomUUID()}`;
const catalogStreamingToken = `g7-catalog-streaming-${randomUUID()}-${randomUUID()}`;
const catalogProfileToken = `g7-catalog-profile-${randomUUID()}-${randomUUID()}`;
const profileCatalogToken = `g7-profile-catalog-${randomUUID()}-${randomUUID()}`;
const profileStreamingToken = `g7-profile-streaming-${randomUUID()}-${randomUUID()}`;
const authStreamingToken = `g7-auth-streaming-${randomUUID()}-${randomUUID()}`;
const paymentStreamingToken = `g7-payment-streaming-${randomUUID()}-${randomUUID()}`;
const password = 'G7-search-e2e-password-2026!';
const adminEmail = `g7-admin-${suffix}@example.test`;
const tempDir = await mkdtemp(resolve(tmpdir(), 'movieapp-g7-'));
const keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const privateKeyPath = resolve(tempDir, 'private.pem');
const publicKeyPath = resolve(tempDir, 'public.pem');
await writeFile(privateKeyPath, keys.privateKey, { mode: 0o600 });
await writeFile(publicKeyPath, keys.publicKey, { mode: 0o600 });
const [authPort, gatewayPort, profilePort, catalogPort, streamingPort] = await Promise.all([unusedPort(), unusedPort(), unusedPort(), unusedPort(), unusedPort()]);
const urls = { auth: `http://127.0.0.1:${authPort}`, gateway: `http://127.0.0.1:${gatewayPort}`, profile: `http://127.0.0.1:${profilePort}`, catalog: `http://127.0.0.1:${catalogPort}`, streaming: `http://127.0.0.1:${streamingPort}` };
const env = {
  AUTH_PORT: String(authPort), GATEWAY_PORT: String(gatewayPort), PROFILE_PORT: String(profilePort), CATALOG_PORT: String(catalogPort), STREAMING_PORT: String(streamingPort),
  AUTH_SERVICE_URL: urls.auth, PROFILE_SERVICE_URL: urls.profile, CATALOG_SERVICE_URL: urls.catalog, STREAMING_SERVICE_URL: urls.streaming,
  AUTH_PRIVATE_KEY_PATH: privateKeyPath, AUTH_PUBLIC_KEY_PATH: publicKeyPath, AUTH_JWT_KID: `g7-${randomUUID()}`,
  AUTH_INTERNAL_TOKENS_JSON: JSON.stringify({ 'api-gateway': gatewayToken, 'streaming-service': authStreamingToken }),
  GATEWAY_SERVICE_TOKEN: gatewayToken,
  PROFILE_INTERNAL_TOKENS_JSON: JSON.stringify({ 'api-gateway': gatewayToken, 'catalog-service': profileCatalogToken, 'streaming-service': profileStreamingToken }),
  PROFILE_CATALOG_TOKEN: catalogProfileToken, PROFILE_STREAMING_TOKEN: profileStreamingToken,
  CATALOG_INTERNAL_TOKENS_JSON: JSON.stringify({ 'api-gateway': gatewayToken, 'streaming-service': catalogStreamingToken, 'profile-service': catalogProfileToken }),
  STREAMING_INTERNAL_TOKENS_JSON: JSON.stringify({ 'api-gateway': gatewayToken, 'profile-service': profileStreamingToken, 'transcode-worker': `g7-worker-${randomUUID()}-${randomUUID()}` }),
  STREAMING_DOWNSTREAM_TOKENS_JSON: JSON.stringify({ 'auth-service': authStreamingToken, 'profile-service': profileStreamingToken, 'catalog-service': catalogStreamingToken, 'payment-service': paymentStreamingToken }),
  PAYMENT_SERVICE_URL: 'http://127.0.0.1:9', RECOMMENDATION_SERVICE_URL: 'http://127.0.0.1:9',
  OPENSEARCH_URL: process.env.OPENSEARCH_URL ?? 'http://127.0.0.1:9200',
  SEED_ADMIN_EMAIL: adminEmail, SEED_ADMIN_PASSWORD: password, SEED_ADMIN_FULL_NAME: 'G7 Admin',
  CATALOG_SYNC_POLL_MS: '250', PROFILE_OUTBOX_POLL_MS: '250', STREAMING_MAINTENANCE_POLL_MS: '250', STREAMING_OUTBOX_POLL_MS: '250',
};
const catalogPool = new Pool({ connectionString: process.env.CATALOG_DATABASE_URL });
const streamingPool = new Pool({ connectionString: process.env.STREAMING_DATABASE_URL });
const processes = [];

async function createMovie(adminToken, title, isKidsSafe) {
  const created = await request(urls.gateway, '/admin/movies', { method: 'POST', token: adminToken, body: { title, type: 'movie', isKidsSafe, averageRating: 8.5 } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const movieId = created.body.data.movieId;
  const playable = await request(urls.gateway, `/admin/movies/${movieId}/playable-items`, { method: 'POST', token: adminToken, body: { kind: 'movie', label: 'Full', sortOrder: 1, durationSeconds: 120 } });
  assert.equal(playable.status, 201, JSON.stringify(playable.body));
  const source = await request(urls.gateway, `/admin/movies/${movieId}/content-sources`, { method: 'POST', token: adminToken, body: { sourceType: 'third_party', provider: 'g7-fixture', externalId: `g7-${movieId}`, externalSlug: `g7-${movieId}` } });
  assert.equal(source.status, 201, JSON.stringify(source.body));
  const sourceItem = await request(urls.gateway, `/admin/content-sources/${source.body.data.id}/items`, { method: 'POST', token: adminToken, body: { playableId: playable.body.data.id, serverKey: 'fixture', serverLabel: 'Fixture', externalEpisodeKey: 'full', playbackMode: 'external_hls', sourceStatus: 'available' } });
  assert.equal(sourceItem.status, 201, JSON.stringify(sourceItem.body));
  const published = await request(urls.gateway, `/admin/movies/${movieId}/publish`, { method: 'POST', token: adminToken });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  return { movieId, playableId: playable.body.data.id };
}

try {
  for (const script of ['migration:run', 'migration:profile:run', 'migration:catalog:run', 'migration:streaming:run']) {
    execFileSync('npm', ['run', script], { cwd: root, env: { ...process.env, ...env }, stdio: 'pipe' });
  }
  for (const pair of [['Auth', 'apps/auth-service/main.js', env], ['Profile', 'apps/profile-service/main.js', env], ['Catalog', 'apps/catalog-service/main.js', env], ['Streaming', 'apps/streaming-service/main.js', env], ['Gateway', 'apps/api-gateway/main.js', env]]) {
    processes.push(start(...pair));
  }
  await Promise.all(processes.map((process, index) => ready(process, [urls.auth, urls.profile, urls.catalog, urls.streaming, urls.gateway][index])));
  console.log('PASS G7 startup: Auth, Profile, Catalog, Streaming, Gateway, PostgreSQL, Kafka and OpenSearch are ready');

  const admin = await request(urls.gateway, '/auth/login', { method: 'POST', body: { email: adminEmail, password, deviceId: `g7-admin-${suffix}` } });
  assert.equal(admin.status, 200, JSON.stringify(admin.body));
  const ownerEmail = `g7-owner-${suffix}@example.test`;
  const otherEmail = `g7-other-${suffix}@example.test`;
  for (const email of [ownerEmail, otherEmail]) {
    const registered = await request(urls.gateway, '/auth/register', { method: 'POST', body: { email, password, fullName: 'G7 User' } });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
  }
  const owner = await request(urls.gateway, '/auth/login', { method: 'POST', body: { email: ownerEmail, password, deviceId: `g7-owner-${suffix}` } });
  const other = await request(urls.gateway, '/auth/login', { method: 'POST', body: { email: otherEmail, password, deviceId: `g7-other-${suffix}` } });
  assert.equal(owner.status, 200); assert.equal(other.status, 200);
  const profile = await request(urls.gateway, '/profiles', { method: 'POST', token: owner.body.data.accessToken, body: { name: 'Adult' } });
  const kids = await request(urls.gateway, '/profiles', { method: 'POST', token: owner.body.data.accessToken, body: { name: 'Kids', isKids: true } });
  const otherProfile = await request(urls.gateway, '/profiles', { method: 'POST', token: other.body.data.accessToken, body: { name: 'Other' } });
  assert.equal(profile.status, 201); assert.equal(kids.status, 201); assert.equal(otherProfile.status, 201);

  const safe = await createMovie(admin.body.data.accessToken, `Điện Ảnh Việt G7 A ${suffix}`, true);
  const unsafe = await createMovie(admin.body.data.accessToken, `Điện Ảnh Việt G7 B ${suffix}`, false);
  await waitFor(async () => {
    const search = await request(urls.gateway, `/catalog/search?q=${encodeURIComponent(`dien anh viet g7 ${suffix}`)}&sort=title&page=1&pageSize=10`);
    return search.status === 200 && search.body.data.items.some((item) => item.id === safe.movieId) && search.body.data.items.some((item) => item.id === unsafe.movieId);
  }, 'OpenSearch did not project published catalog movies');
  const first = await request(urls.gateway, `/catalog/search?q=${encodeURIComponent(`dien anh viet g7 ${suffix}`)}&sort=title&page=1&pageSize=1`);
  const repeated = await request(urls.gateway, `/catalog/search?q=${encodeURIComponent(`dien anh viet g7 ${suffix}`)}&sort=title&page=1&pageSize=1`);
  assert.deepEqual(first.body.data.items.map((item) => item.id), repeated.body.data.items.map((item) => item.id), 'search pagination must be stable for a fixed catalog');
  const kidsSearch = await request(urls.gateway, `/catalog/search?q=${encodeURIComponent(`dien anh viet g7 ${suffix}`)}&profileId=${kids.body.data.id}`, { token: owner.body.data.accessToken });
  assert.equal(kidsSearch.status, 200, JSON.stringify(kidsSearch.body));
  assert.deepEqual(kidsSearch.body.data.items.map((item) => item.id), [safe.movieId], 'kids search must be rechecked against current Catalog publication/kids state');
  console.log('PASS G7 search: Vietnamese accent folding, OpenSearch filters and stable pagination pass with current Catalog recheck');

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const favorite = await request(urls.gateway, `/profiles/${profile.body.data.id}/favorites/${safe.movieId}`, { method: 'PUT', token: owner.body.data.accessToken });
    assert.equal(favorite.status, 200, JSON.stringify(favorite.body));
  }
  const profilePool = new Pool({ connectionString: process.env.PROFILE_DATABASE_URL });
  try {
    const count = await profilePool.query('SELECT count(*)::int AS count FROM favorite_movies WHERE profile_id=$1 AND movie_id=$2', [profile.body.data.id, safe.movieId]);
    assert.equal(count.rows[0].count, 1, 'favorite uniqueness is per profile/movie even when a movie has multiple sources');
  } finally { await profilePool.end(); }
  const forbidden = await request(urls.gateway, `/profiles/${profile.body.data.id}/favorites`, { token: other.body.data.accessToken });
  assert.equal(forbidden.status, 404, 'another user cannot read a profile favorite list');
  console.log('PASS G7 favorites: PUT is idempotent and profile ownership is enforced');

  await streamingPool.query(`INSERT INTO watch_progress(profile_id,playable_id,movie_id,source_item_id,session_ordinal,last_seq,position_seconds,duration_seconds) VALUES($1,$2,$3,$4,1,1,42,120),($1,$5,$6,$7,1,1,21,120)`, [profile.body.data.id, safe.playableId, safe.movieId, randomUUID(), unsafe.playableId, unsafe.movieId, randomUUID()]);
  const archived = await request(urls.gateway, `/admin/movies/${safe.movieId}/archive`, { method: 'POST', token: admin.body.data.accessToken });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  await waitFor(async () => {
    const search = await request(urls.gateway, `/catalog/search?q=${encodeURIComponent(`dien anh viet g7 ${suffix}`)}&page=1&pageSize=10`);
    return search.status === 200 && !search.body.data.items.some((item) => item.id === safe.movieId);
  }, 'archived movie remained visible in OpenSearch results');
  const producer = new Kafka({ clientId: `g7-out-of-order-${suffix}`, brokers: process.env.KAFKA_BROKERS.split(',') }).producer({ allowAutoTopicCreation: false });
  await producer.connect();
  try {
    await producer.send({ topic: 'movie.published', messages: [{ key: safe.movieId, value: JSON.stringify({ eventId: randomUUID(), eventType: 'movie.published', schemaVersion: 1, aggregateId: safe.movieId, aggregateVersion: '1', occurredAt: new Date().toISOString(), producer: 'g7-test', correlationId: 'g7-out-of-order', payload: { movieId: safe.movieId } }) }] });
  } finally { await producer.disconnect(); }
  await delay(500);
  const afterOldEvent = await request(urls.gateway, `/catalog/search?q=${encodeURIComponent(`dien anh viet g7 ${suffix}`)}&page=1&pageSize=10`);
  assert.equal(afterOldEvent.body.data.items.some((item) => item.id === safe.movieId), false, 'out-of-order publish event cannot revive an archived movie');
  const internalProgress = await request(urls.streaming, `/internal/streaming/profiles/${profile.body.data.id}/progress`, { headers: { authorization: `Bearer ${profileStreamingToken}`, 'x-caller-service': 'profile-service' } });
  assert.equal(internalProgress.status, 200, JSON.stringify(internalProgress.body));
  const internalCatalog = await request(urls.catalog, '/internal/catalog/movies/batch', { method: 'POST', headers: { authorization: `Bearer ${catalogProfileToken}`, 'x-caller-service': 'profile-service' }, body: { movieIds: [safe.movieId, unsafe.movieId], includeTombstones: true } });
  assert.equal(internalCatalog.status, 200, JSON.stringify(internalCatalog.body));
  const history = await request(urls.gateway, `/profiles/${profile.body.data.id}/watch-history`, { token: owner.body.data.accessToken });
  assert.equal(history.status, 200, JSON.stringify(history.body));
  assert.equal(history.body.data.items.find((item) => item.movieId === safe.movieId).tombstone, true, 'archived history item is a tombstone');
  assert.equal(history.body.data.items.find((item) => item.movieId === unsafe.movieId).movie.id, unsafe.movieId, 'current history is hydrated through Catalog');
  console.log('PASS G7 projection/history: archive and out-of-order event stay hidden; Profile history hydrates current movies and tombstones archives');

  const home = await request(urls.gateway, `/home?profileId=${profile.body.data.id}`, { token: owner.body.data.accessToken });
  assert.equal(home.status, 200, JSON.stringify(home.body));
  assert.equal(home.headers.get('cache-control'), 'no-store');
  assert.equal(home.body.data.sections[0].type, 'continue_watching');
  assert.equal(home.body.data.sections[1].type, 'fallback_new_releases', 'recommendation failure must not fail Home');
  const publicHome = await request(urls.gateway, `/catalog/home?profileId=${profile.body.data.id}`);
  assert.equal(publicHome.status, 200, JSON.stringify(publicHome.body));
  assert.equal(JSON.stringify(publicHome.body).includes(profile.body.data.id), false, 'public Catalog home ignores profileId and never exposes profile state');
  assert.equal(JSON.stringify(publicHome.body).includes('playbackUrl'), false, 'public Catalog home never exposes raw stream URLs');
  console.log('PASS G7 home: verified profile composition is no-store, recommendation fallback survives failure, and public Home remains profile-free');
  console.log('G7 E2E passed.');
} finally {
  await Promise.all(processes.reverse().map((process) => stop(process).catch(() => undefined)));
  await catalogPool.end();
  await streamingPool.end();
  await rm(tempDir, { recursive: true, force: true });
}
