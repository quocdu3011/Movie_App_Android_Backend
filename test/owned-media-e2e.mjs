import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { S3ObjectStorage } = require('@movie/object-storage');
const { Pool } = pg;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workerDatabaseUrl = process.env.WORKER_DATABASE_URL ?? (() => { const url = new URL(process.env.STREAMING_DATABASE_URL); url.username = 'movieapp_worker'; url.password = process.env.WORKER_DB_PASSWORD ?? ''; url.pathname = '/worker_db'; return url.toString(); })();
const minioEndpoint = process.env.MINIO_ENDPOINT ?? `http://127.0.0.1:${process.env.MINIO_API_PORT ?? '9000'}`;
for (const key of ['AUTH_DATABASE_URL', 'PROFILE_DATABASE_URL', 'CATALOG_DATABASE_URL', 'PAYMENT_DATABASE_URL', 'STREAMING_DATABASE_URL', 'REDIS_URL', 'KAFKA_BROKERS', 'MINIO_ROOT_USER', 'MINIO_ROOT_PASSWORD']) assert.ok(process.env[key], `${key} is required for owned media E2E`);
assert.ok(process.env.WORKER_DATABASE_URL || process.env.WORKER_DB_PASSWORD, 'WORKER_DATABASE_URL or WORKER_DB_PASSWORD is required for owned media E2E');

async function unusedPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const port = server.address().port; await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())); return port;
}
function start(name, script, env) {
  const child = spawn(process.execPath, [resolve(root, 'dist', script)], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; }); child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; }); child.serviceName = name; child.output = () => output; return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([new Promise((resolveExit) => child.once('exit', () => resolveExit(true))), delay(10_000).then(() => false)]);
  if (exited || child.exitCode !== null) return;
  child.kill('SIGKILL');
  await Promise.race([new Promise((resolveExit) => child.once('exit', resolveExit)), delay(2_000).then(() => { throw new Error(`${child.serviceName} did not stop after SIGKILL`); })]);
}
async function ready(child, url, path = '/ready') { for (let attempt = 0; attempt < 150; attempt += 1) { if (child.exitCode !== null) throw new Error(`${child.serviceName} exited: ${child.output()}`); try { if ((await fetch(`${url}${path}`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* starting */ } await delay(100); } throw new Error(`${child.serviceName} readiness timeout: ${child.output()}`); }
async function waitFor(callback, message, attempts = 180) { for (let attempt = 0; attempt < attempts; attempt += 1) { const result = await callback(); if (result) return result; await delay(150); } throw new Error(message); }
async function request(base, path, { method = 'GET', body, token, headers = {} } = {}) { const response = await fetch(`${base}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const raw = await response.text(); return { status: response.status, headers: response.headers, body: raw ? JSON.parse(raw) : null }; }
function jwtSession(token) { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).sid; }
function sha256(buffer) { return createHash('sha256').update(buffer).digest('hex'); }

const suffix = randomUUID().replaceAll('-', ''); const password = 'G6-owned-media-password-2026!'; const temporary = await mkdtemp(join(tmpdir(), 'movieapp-g6-'));
const keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const privateKey = join(temporary, 'auth-private.pem'); const publicKey = join(temporary, 'auth-public.pem'); await writeFile(privateKey, keys.privateKey, { mode: 0o600 }); await writeFile(publicKey, keys.publicKey);
const ports = {}; for (const service of ['auth', 'profile', 'catalog', 'payment', 'streaming', 'gateway', 'worker', 'edge']) ports[service] = await unusedPort();
const urls = Object.fromEntries(Object.entries(ports).map(([name, port]) => [name, `http://127.0.0.1:${port}`]));
const gatewayToken = `g6-gateway-${randomUUID()}-${randomUUID()}`; const workerToken = `g6-worker-${randomUUID()}-${randomUUID()}`;
const tokenMap = {
  auth: { 'api-gateway': gatewayToken, 'streaming-service': `g6-auth-${randomUUID()}-${randomUUID()}` },
  profile: { 'api-gateway': gatewayToken, 'streaming-service': `g6-profile-${randomUUID()}-${randomUUID()}`, 'catalog-service': `g6-catalog-profile-${randomUUID()}-${randomUUID()}` },
  catalog: { 'api-gateway': gatewayToken, 'streaming-service': `g6-catalog-${randomUUID()}-${randomUUID()}` },
  payment: { 'api-gateway': gatewayToken, 'streaming-service': `g6-payment-${randomUUID()}-${randomUUID()}` },
  streaming: { 'api-gateway': gatewayToken, 'profile-service': `g6-profile-inbound-${randomUUID()}-${randomUUID()}`, 'transcode-worker': workerToken },
};
const env = {
  NODE_ENV: 'test', AUTH_DATABASE_URL: process.env.AUTH_DATABASE_URL, PROFILE_DATABASE_URL: process.env.PROFILE_DATABASE_URL, CATALOG_DATABASE_URL: process.env.CATALOG_DATABASE_URL, PAYMENT_DATABASE_URL: process.env.PAYMENT_DATABASE_URL, STREAMING_DATABASE_URL: process.env.STREAMING_DATABASE_URL, WORKER_DATABASE_URL: workerDatabaseUrl,
  AUTH_JWT_ISSUER: process.env.AUTH_JWT_ISSUER ?? 'https://auth.movieapp.local', AUTH_JWT_AUDIENCE: process.env.AUTH_JWT_AUDIENCE ?? 'movieapp-api', AUTH_JWT_KID: `g6-${suffix}`, AUTH_PRIVATE_KEY_PATH: privateKey, AUTH_PUBLIC_KEY_PATH: publicKey,
  AUTH_INTERNAL_TOKENS_JSON: JSON.stringify(tokenMap.auth), PROFILE_INTERNAL_TOKENS_JSON: JSON.stringify(tokenMap.profile), CATALOG_INTERNAL_TOKENS_JSON: JSON.stringify(tokenMap.catalog), PAYMENT_INTERNAL_TOKENS_JSON: JSON.stringify(tokenMap.payment), STREAMING_INTERNAL_TOKENS_JSON: JSON.stringify(tokenMap.streaming), STREAMING_DOWNSTREAM_TOKENS_JSON: JSON.stringify({ 'auth-service': tokenMap.auth['streaming-service'], 'profile-service': tokenMap.profile['streaming-service'], 'catalog-service': tokenMap.catalog['streaming-service'], 'payment-service': tokenMap.payment['streaming-service'] }), GATEWAY_SERVICE_TOKEN: gatewayToken,
  PAYMENT_MOCK_ENABLED: 'true', PAYMENT_MOCK_HMAC_SECRET: `g6-hmac-${randomUUID()}-${randomUUID()}`, PAYMENT_FREE_MAX_CONCURRENT_STREAMS: '2', PAYMENT_FREE_MAX_RESOLUTION: '720p', PAYMENT_MAINTENANCE_POLL_MS: '250',
  AUTH_SERVICE_URL: urls.auth, PROFILE_SERVICE_URL: urls.profile, CATALOG_SERVICE_URL: urls.catalog, PAYMENT_SERVICE_URL: urls.payment, STREAMING_SERVICE_URL: urls.streaming, MEDIA_EDGE_URL: urls.edge,
  REDIS_URL: process.env.REDIS_URL, KAFKA_BROKERS: process.env.KAFKA_BROKERS, PROFILE_KAFKA_BROKERS: process.env.KAFKA_BROKERS, STREAMING_KAFKA_BROKERS: process.env.KAFKA_BROKERS, WORKER_KAFKA_BROKERS: process.env.KAFKA_BROKERS,
  KKPHIM_API_BASE_URL: urls.catalog, KKPHIM_MEDIA_HOST_ALLOWLIST: 'media.fixture.invalid', STREAMING_PROVIDER_TIMEOUT_MS: '1000', STREAMING_OUTBOX_POLL_MS: '250', STREAMING_MAINTENANCE_POLL_MS: '250', STREAMING_UPLOAD_EXPIRY_SECONDS: '120', STREAMING_MEDIA_AUTH_TTL_SECONDS: '120',
  MINIO_ENDPOINT: minioEndpoint, MINIO_ROOT_USER: process.env.MINIO_ROOT_USER, MINIO_ROOT_PASSWORD: process.env.MINIO_ROOT_PASSWORD, MINIO_BUCKET_UPLOADS: process.env.MINIO_BUCKET_UPLOADS ?? 'movieapp-uploads', MINIO_BUCKET_MEDIA: process.env.MINIO_BUCKET_MEDIA ?? 'movieapp-media', MEDIA_AUTH_SECRET: `g6-media-${randomUUID()}-${randomUUID()}`,
  WORKER_STREAMING_TOKEN: workerToken, WORKER_POLL_MS: '150', WORKER_LEASE_SECONDS: '10', WORKER_RETRY_BASE_MS: '150', WORKER_FFMPEG_TIMEOUT_MS: '60000',
  AUTH_PORT: String(ports.auth), PROFILE_PORT: String(ports.profile), CATALOG_PORT: String(ports.catalog), PAYMENT_PORT: String(ports.payment), STREAMING_PORT: String(ports.streaming), GATEWAY_PORT: String(ports.gateway), TRANSCODE_PORT: String(ports.worker), MEDIA_EDGE_PORT: String(ports.edge),
};
const pools = Object.fromEntries(Object.entries({ auth: env.AUTH_DATABASE_URL, catalog: env.CATALOG_DATABASE_URL, streaming: env.STREAMING_DATABASE_URL, worker: env.WORKER_DATABASE_URL }).map(([name, connectionString]) => [name, new Pool({ connectionString })]));
const storage = new S3ObjectStorage({ endpoint: env.MINIO_ENDPOINT, accessKey: env.MINIO_ROOT_USER, secretKey: env.MINIO_ROOT_PASSWORD, region: 'us-east-1' });
const processes = []; const created = { users: [], movies: [], assets: [] };

async function createOwned(type, title) {
  const movieId = randomUUID(); const sourceId = randomUUID(); const playableId = randomUUID(); const sourceItemId = randomUUID();
  await pools.catalog.query(`INSERT INTO movies(id,title,type,content_kind,status,access_tier,is_kids_safe,average_rating,published_at) VALUES($1,$2,$3,'film','published','free',true,0,now())`, [movieId, title, type]);
  if (type === 'series') { const seasonId = randomUUID(); await pools.catalog.query(`INSERT INTO seasons(id,movie_id,season_number,is_synthetic) VALUES($1,$2,1,false)`, [seasonId, movieId]); await pools.catalog.query(`INSERT INTO playable_items(id,movie_id,season_id,kind,episode_number,label,sort_order,duration_seconds) VALUES($1,$2,$3,'episode',1,'Episode 1',1,120)`, [playableId, movieId, seasonId]); }
  else await pools.catalog.query(`INSERT INTO playable_items(id,movie_id,kind,label,sort_order,duration_seconds) VALUES($1,$2,'movie','Full',1,120)`, [playableId, movieId]);
  await pools.catalog.query(`INSERT INTO content_sources(id,movie_id,source_type,source_status) VALUES($1,$2,'owned','unknown')`, [sourceId, movieId]);
  await pools.catalog.query(`INSERT INTO source_items(id,movie_id,source_id,playable_id,server_key,server_label,playback_mode,source_status) VALUES($1,$2,$3,$4,'owned','Self-distributed','owned_hls','unknown')`, [sourceItemId, movieId, sourceId, playableId]);
  created.movies.push(movieId); return { movieId, playableId, sourceItemId };
}
async function loginAdmin() {
  const email = `g6-admin-${randomUUID()}@example.test`; const registered = await request(urls.gateway, '/auth/register', { method: 'POST', body: { email, password, fullName: 'G6 Admin' } }); assert.equal(registered.status, 201, JSON.stringify(registered.body)); created.users.push(registered.body.data.id);
  await pools.auth.query(`UPDATE users SET role='content_manager' WHERE id=$1`, [registered.body.data.id]);
  const login = await request(urls.gateway, '/auth/login', { method: 'POST', body: { email, password, deviceId: `g6-device-${randomUUID()}` } }); assert.equal(login.status, 200, JSON.stringify(login.body)); return { userId: registered.body.data.id, token: login.body.data.accessToken, sessionId: jwtSession(login.body.data.accessToken) };
}
async function createProfile(user) { const response = await request(urls.gateway, '/profiles', { method: 'POST', token: user.token, body: { name: 'Owner', isKids: false } }); assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.data.id; }
async function uploadAndAwait(admin, source, clip, label) {
  const checksum = sha256(clip); const key = `g6-upload-${label}-${randomUUID()}`;
  const begun = await request(urls.gateway, '/admin/videos/uploads', { method: 'POST', token: admin.token, headers: { 'idempotency-key': key }, body: { sourceItemId: source.sourceItemId, sizeBytes: clip.length, checksumSha256: checksum } }); assert.equal(begun.status, 201, JSON.stringify(begun.body)); const asset = begun.body.data; created.assets.push(asset.assetId);
  const missing = await request(urls.gateway, `/admin/videos/${asset.assetId}/upload-complete`, { method: 'POST', token: admin.token }); assert.equal(missing.status, 422, 'completion rejects an absent direct upload');
  const uploaded = await fetch(asset.uploadUrl, { method: 'PUT', headers: { ...asset.requiredHeaders, 'content-type': 'video/mp4' }, body: clip }); assert.equal(uploaded.status, 200, `MinIO direct upload failed: ${uploaded.status}`);
  const completed = await request(urls.gateway, `/admin/videos/${asset.assetId}/upload-complete`, { method: 'POST', token: admin.token }); assert.equal(completed.status, 200, JSON.stringify(completed.body));
  const repeat = await request(urls.gateway, `/admin/videos/${asset.assetId}/upload-complete`, { method: 'POST', token: admin.token }); assert.equal(repeat.status, 200); assert.equal(repeat.body.data.duplicate, true, 'repeat complete does not enqueue a second job');
  const readyAsset = await waitFor(async () => { const result = await pools.streaming.query(`SELECT * FROM video_assets WHERE id=$1 AND processing_status='ready'`, [asset.assetId]); return result.rows[0] ?? null; }, `asset ${asset.assetId} did not reach ready`);
  const jobs = await pools.worker.query(`SELECT count(*)::int AS count FROM transcode_jobs WHERE asset_id=$1 AND generation=$2`, [asset.assetId, asset.generation]); assert.equal(jobs.rows[0].count, 1, 'exactly one durable job exists for an idempotent complete'); return { asset, readyAsset };
}
async function enqueueUpload(admin, source, payload, label) {
  const begun = await request(urls.gateway, '/admin/videos/uploads', { method: 'POST', token: admin.token, headers: { 'idempotency-key': `g6-enqueue-${label}-${randomUUID()}` }, body: { sourceItemId: source.sourceItemId, sizeBytes: payload.length, checksumSha256: sha256(payload) } });
  assert.equal(begun.status, 201, JSON.stringify(begun.body)); const asset = begun.body.data; created.assets.push(asset.assetId);
  const put = await fetch(asset.uploadUrl, { method: 'PUT', headers: { ...asset.requiredHeaders, 'content-type': 'video/mp4' }, body: payload }); assert.equal(put.status, 200);
  const complete = await request(urls.gateway, `/admin/videos/${asset.assetId}/upload-complete`, { method: 'POST', token: admin.token }); assert.equal(complete.status, 200, JSON.stringify(complete.body)); return asset;
}

try {
  await storage.ensureBucket(env.MINIO_BUCKET_UPLOADS); await storage.ensureBucket(env.MINIO_BUCKET_MEDIA);
  for (const migration of ['migration:run', 'migration:profile:run', 'migration:catalog:run', 'migration:payment:run', 'migration:streaming:run', 'migration:worker:run']) execFileSync('npm', ['run', migration], { cwd: root, env: { ...process.env, ...env }, stdio: 'pipe' });
  const movie = await createOwned('movie', `G6 movie ${suffix}`); const series = await createOwned('series', `G6 series ${suffix}`);
  const auth = start('Auth', 'apps/auth-service/main.js', env); const profile = start('Profile', 'apps/profile-service/main.js', env); const catalog = start('Catalog', 'apps/catalog-service/main.js', env); const payment = start('Payment', 'apps/payment-service/main.js', env); const streaming = start('Streaming', 'apps/streaming-service/main.js', env); const worker = start('Worker', 'apps/transcode-worker/main.js', env); const edge = start('Media edge', 'apps/media-edge/main.js', env); const gateway = start('Gateway', 'apps/api-gateway/main.js', env); processes.push(auth, profile, catalog, payment, streaming, worker, edge, gateway);
  await Promise.all([ready(auth, urls.auth), ready(profile, urls.profile), ready(catalog, urls.catalog), ready(payment, urls.payment), ready(streaming, urls.streaming), ready(worker, urls.worker), ready(edge, urls.edge, '/health'), ready(gateway, urls.gateway)]);
  console.log('PASS G6 startup: Auth, Profile, Catalog, Payment, Streaming, Worker, Media edge, PostgreSQL, Kafka and MinIO are ready');
  const clipPath = join(temporary, 'clip.mp4'); execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clipPath], { stdio: 'pipe' }); const clip = await readFile(clipPath);
  const admin = await loginAdmin(); const profileId = await createProfile(admin);
  const forbidden = await request(urls.gateway, '/admin/videos/uploads', { method: 'POST', token: `${admin.token}x`, headers: { 'idempotency-key': `g6-bad-${randomUUID()}` }, body: { sourceItemId: movie.sourceItemId, sizeBytes: clip.length, checksumSha256: sha256(clip) } }); assert.ok([401, 403].includes(forbidden.status), `invalid caller cannot initiate upload: ${JSON.stringify(forbidden.body)}`);
  const movieResult = await uploadAndAwait(admin, movie, clip, 'movie'); const seriesResult = await uploadAndAwait(admin, series, clip, 'series');
  assert.deepEqual(movieResult.readyAsset.available_resolutions, ['480p', '720p'], 'no-upscale rendition set follows 720p input');
  assert.deepEqual(seriesResult.readyAsset.available_resolutions, ['480p', '720p'], 'series episode is transcoded with the same source-aware rendition policy');
  console.log('PASS G6 upload/transcode: direct signed PUT, HEAD verification, durable worker job, FFprobe and multi-rendition HLS for movie and series');
  await stop(worker);
  const restartSource = await createOwned('movie', `G6 restart ${suffix}`); const restartAsset = await enqueueUpload(admin, restartSource, clip, 'restart');
  const delayedWorker = start('Delayed worker', 'apps/transcode-worker/main.js', { ...env, WORKER_POLL_MS: '5000' }); processes.push(delayedWorker); await ready(delayedWorker, urls.worker);
  await waitFor(async () => (await pools.worker.query(`SELECT state FROM transcode_jobs WHERE asset_id=$1 AND generation=$2`, [restartAsset.assetId, restartAsset.generation])).rows[0]?.state === 'queued', 'worker did not durably persist queued upload before restart');
  await stop(delayedWorker);
  const restartedWorker = start('Restarted worker', 'apps/transcode-worker/main.js', env); processes.push(restartedWorker); await ready(restartedWorker, urls.worker);
  await waitFor(async () => (await pools.streaming.query(`SELECT processing_status FROM video_assets WHERE id=$1`, [restartAsset.assetId])).rows[0]?.processing_status === 'ready', 'restarted worker did not complete a persisted queued job');
  const invalidSource = await createOwned('movie', `G6 invalid ${suffix}`); const invalidAsset = await enqueueUpload(admin, invalidSource, Buffer.from('not-a-media-file'), 'invalid');
  await waitFor(async () => (await pools.streaming.query(`SELECT processing_status FROM video_assets WHERE id=$1`, [invalidAsset.assetId])).rows[0]?.processing_status === 'failed', 'worker did not exhaust retries into failed state');
  const failedJob = await pools.worker.query(`SELECT state,attempt FROM transcode_jobs WHERE asset_id=$1 AND generation=$2`, [invalidAsset.assetId, invalidAsset.generation]); assert.equal(failedJob.rows[0]?.state, 'failed'); assert.equal(Number(failedJob.rows[0]?.attempt), 4, 'worker makes the initial attempt plus three persisted retries');
  console.log('PASS G6 recovery: durable queued job survives worker restart; invalid media exhausts four attempts and marks the asset failed');
  const playback = await request(urls.gateway, '/streaming/playback-sessions', { method: 'POST', token: admin.token, headers: { 'idempotency-key': `g6-play-${randomUUID()}` }, body: { ...movie, profileId } }); assert.equal(playback.status, 201, JSON.stringify(playback.body)); assert.match(playback.body.data.playbackUrl, new RegExp(`^${urls.edge.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/media/assets/`)); const credential = playback.body.data.mediaAuth; assert.ok(credential?.cookieValue, 'owned playback provides scoped media credential');
  const cookie = `${credential.cookieName}=${credential.cookieValue}`; const deniedMaster = await fetch(playback.body.data.playbackUrl); assert.equal(deniedMaster.status, 403, 'master without credential is denied');
  const master = await fetch(playback.body.data.playbackUrl, { headers: { cookie } }); assert.equal(master.status, 200); const masterText = await master.text(); assert.match(masterText, /^#EXTM3U/); const variantName = masterText.split('\n').find((line) => line.endsWith('.m3u8')); assert.ok(variantName); const variantUrl = new URL(variantName, playback.body.data.playbackUrl).toString(); const variant = await fetch(variantUrl, { headers: { cookie } }); assert.equal(variant.status, 200); const variantText = await variant.text(); const segmentName = variantText.split('\n').find((line) => line.endsWith('.ts')); assert.ok(segmentName); const segmentUrl = new URL(segmentName, variantUrl).toString(); assert.equal((await fetch(segmentUrl)).status, 403, 'segment without credential is denied'); const segment = await fetch(segmentUrl, { headers: { cookie } }); assert.equal(segment.status, 200); const localMaster = join(temporary, 'master.m3u8'); await writeFile(localMaster, masterText); await writeFile(join(temporary, variantName), variantText); await writeFile(join(temporary, segmentName), Buffer.from(await segment.arrayBuffer())); const decoded = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', localMaster], { encoding: 'utf8' })); assert.ok(Number(decoded.format.duration) > 0, 'downloaded HLS media decodes through ffprobe');
  const origin = await fetch(`${env.MINIO_ENDPOINT}/${env.MINIO_BUCKET_MEDIA}/${movieResult.readyAsset.master_manifest_key}`); assert.ok([401, 403].includes(origin.status), 'private MinIO origin rejects unauthenticated media access'); const renewal = await request(urls.gateway, `/streaming/playback-sessions/${playback.body.data.sessionId}/media-auth`, { method: 'POST', token: admin.token }); assert.equal(renewal.status, 200); assert.notEqual(renewal.body.data.cookieValue, credential.cookieValue, 'active owned session receives a fresh media credential');
  const next = await request(urls.gateway, '/admin/videos/uploads', { method: 'POST', token: admin.token, headers: { 'idempotency-key': `g6-generation-${randomUUID()}` }, body: { sourceItemId: movie.sourceItemId, sizeBytes: clip.length, checksumSha256: sha256(clip) } }); assert.equal(next.status, 201); assert.equal(next.body.data.generation, movieResult.asset.generation + 1); const stale = await request(urls.streaming, `/internal/streaming/assets/${movieResult.asset.assetId}/transcoded`, { method: 'POST', headers: { authorization: `Bearer ${workerToken}`, 'x-caller-service': 'transcode-worker' }, body: { generation: movieResult.asset.generation, attempt: 99, attemptToken: randomUUID(), manifestKey: movieResult.readyAsset.master_manifest_key, durationSeconds: 2, resolutions: ['720p'] } }); assert.equal(stale.status, 201); assert.equal(stale.body.data.applied, false, 'late older generation cannot overwrite a newer upload generation');
  console.log('PASS G6 delivery: protected master/variant/segment, private origin, credential renewal, ffprobe decode and generation CAS');
} finally {
  for (const process of processes.reverse()) await stop(process).catch(() => undefined);
  if (created.assets.length) { await pools.streaming.query(`DELETE FROM video_assets WHERE id=ANY($1::uuid[])`, [created.assets]).catch(() => undefined); await pools.worker.query(`DELETE FROM transcode_jobs WHERE asset_id=ANY($1::uuid[])`, [created.assets]).catch(() => undefined); }
  if (created.movies.length) { await pools.catalog.query(`DELETE FROM outbox_events WHERE aggregate_id=ANY($1::uuid[])`, [created.movies]).catch(() => undefined); await pools.catalog.query(`DELETE FROM movies WHERE id=ANY($1::uuid[])`, [created.movies]).catch(() => undefined); }
  if (created.users.length) await pools.auth.query(`DELETE FROM users WHERE id=ANY($1::uuid[])`, [created.users]).catch(() => undefined);
  await Promise.all(Object.values(pools).map((pool) => pool.end().catch(() => undefined))); await rm(temporary, { recursive: true, force: true });
}
