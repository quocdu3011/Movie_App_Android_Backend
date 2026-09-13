import 'dotenv/config';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import Redis from 'ioredis';
import https from 'node:https';

const { Client, Pool } = pg;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const required = ['AUTH_DATABASE_URL', 'PROFILE_DATABASE_URL', 'CATALOG_DATABASE_URL', 'PAYMENT_DATABASE_URL', 'STREAMING_DATABASE_URL', 'POSTGRES_ADMIN_URL', 'REDIS_URL', 'KAFKA_BROKERS'];
for (const key of required) assert.ok(process.env[key], `${key} must point to Compose infrastructure`);

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
  let timer;
  try {
    await Promise.race([
      new Promise((resolveExit) => child.once('exit', resolveExit)),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${child.serviceName} did not stop cleanly: ${child.output()}`)), 5000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

async function ready(child, url, path = '/ready') {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`${child.serviceName} exited before ready: ${child.output()}`);
    try { const response = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(500) }); if (response.ok) return; } catch { /* service is starting */ }
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

async function waitFor(fn, message, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await fn();
    if (result) return result;
    await delay(100);
  }
  throw new Error(message);
}

function p95(samples) { return [...samples].sort((left, right) => left - right)[Math.ceil(samples.length * 0.95) - 1]; }

function idFromJwt(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).sid;
}

function httpsFixtureGet(url) {
  return new Promise((resolveRequest, reject) => {
    const parsed = new URL(url);
    const req = https.get(parsed, {
      rejectUnauthorized: false,
      lookup: (_hostname, options, callback) => options?.all
        ? callback(null, [{ address: '127.0.0.1', family: 4 }])
        : callback(null, '127.0.0.1', 4),
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolveRequest({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('Media fixture request timed out')));
  });
}

const suffix = randomUUID().replaceAll('-', '');
const password = 'G5-Streaming-E2E-password-2026!';
const gatewayToken = `g5-gateway-${randomUUID()}-${randomUUID()}`;
const authStreamingToken = `g5-auth-${randomUUID()}-${randomUUID()}`;
const profileStreamingToken = `g5-profile-${randomUUID()}-${randomUUID()}`;
const catalogStreamingToken = `g5-catalog-${randomUUID()}-${randomUUID()}`;
const paymentStreamingToken = `g5-payment-${randomUUID()}-${randomUUID()}`;
const incomingProfileToken = `g5-profile-to-streaming-${randomUUID()}-${randomUUID()}`;
const workerStreamingToken = `g5-worker-to-streaming-${randomUUID()}-${randomUUID()}`;
const profileCatalogToken = `g5-catalog-to-profile-${randomUUID()}-${randomUUID()}`;
const providerCalls = new Map();
const movieRows = [];
const userRows = [];
const profileRows = [];
const sessionRows = [];
const mediaPort = await unusedPort();
const tempDir = await mkdtemp(resolve(tmpdir(), 'movieapp-g5-'));
const privateKeyPath = resolve(tempDir, 'auth-private.pem');
const publicKeyPath = resolve(tempDir, 'auth-public.pem');
const mediaKeyPath = resolve(tempDir, 'media-key.pem');
const mediaCertPath = resolve(tempDir, 'media-cert.pem');
const keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
await writeFile(privateKeyPath, keys.privateKey, { mode: 0o600 });
await writeFile(publicKeyPath, keys.publicKey);
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', mediaKeyPath, '-out', mediaCertPath, '-subj', '/CN=media.fixture.invalid', '-days', '1'], { stdio: 'ignore' });
const { readFile } = await import('node:fs/promises');
const hlsFixture = createHttpsServer({ key: await readFile(mediaKeyPath), cert: await readFile(mediaCertPath) }, (req, res) => {
  if (req.url?.startsWith('/hls/master.m3u8')) {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:2.0,\nsegment.ts\n#EXT-X-ENDLIST\n');
  } else if (req.url === '/hls/segment.ts') {
    res.writeHead(200, { 'content-type': 'video/mp2t' });
    res.end(Buffer.from([0x47, 0x45, 0x35, 0x30]));
  } else { res.writeHead(404).end(); }
});
await new Promise((resolveListen, reject) => { hlsFixture.once('error', reject); hlsFixture.listen(mediaPort, '127.0.0.1', resolveListen); });

let generatedUrl = 0;
const provider = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const slug = decodeURIComponent(url.pathname.slice('/phim/'.length));
  const callCount = (providerCalls.get(slug) ?? 0) + 1;
  providerCalls.set(slug, callCount);
  res.setHeader('content-type', 'application/json');
  if (slug.startsWith('recover-') && callCount <= 3) { res.writeHead(503).end(JSON.stringify({ status: false })); return; }
  if (slug.startsWith('down-')) { res.writeHead(503).end(JSON.stringify({ status: false })); return; }
  const source = movieRows.find((row) => row.slug === slug);
  if (!source) { res.writeHead(404).end(JSON.stringify({ status: false })); return; }
  generatedUrl += 1;
  const unsafeHost = slug.startsWith('unsafe-');
  const playbackUrl = unsafeHost
    ? `https://evil.fixture.invalid/hls/master.m3u8?version=${generatedUrl}`
    : `https://media.fixture.invalid:${mediaPort}/hls/master.m3u8?version=${generatedUrl}`;
  const episode = { name: 'Full', slug: `full-${slug}`, filename: `full-${slug}` };
  if (source.mode === 'external_embed') episode.link_embed = 'https://player.fixture.invalid/embed/123';
  else episode.link_m3u8 = playbackUrl;
  res.end(JSON.stringify({
    status: true, movie: { _id: `provider-${slug}`, slug, name: `Fixture ${slug}`, type: 'single' },
    episodes: [
      { server_name: 'Dub', server_data: [{ name: 'Full', slug: `wrong-${slug}`, filename: `wrong-${slug}`, link_m3u8: `https://evil.fixture.invalid/hls/wrong.m3u8?version=${generatedUrl}` }] },
      { server_name: 'Vietsub', server_data: [episode] },
    ],
  }));
});

const ports = {};
for (const service of ['auth', 'gateway', 'profile', 'catalog', 'payment', 'streaming', 'provider', 'outage']) ports[service] = await unusedPort();
await new Promise((resolveListen, reject) => { provider.once('error', reject); provider.listen(ports.provider, '127.0.0.1', resolveListen); });
const urls = Object.fromEntries(Object.entries(ports).map(([name, port]) => [name, `http://127.0.0.1:${port}`]));
const providerUrl = urls.provider;
const authDatabaseUrl = process.env.AUTH_DATABASE_URL;
const profileDatabaseUrl = process.env.PROFILE_DATABASE_URL;
const catalogDatabaseUrl = process.env.CATALOG_DATABASE_URL;
const paymentDatabaseUrl = process.env.PAYMENT_DATABASE_URL;
const streamingDatabaseUrl = process.env.STREAMING_DATABASE_URL;
const authPool = new Pool({ connectionString: authDatabaseUrl });
const profilePool = new Pool({ connectionString: profileDatabaseUrl });
const catalogPool = new Pool({ connectionString: catalogDatabaseUrl });
const paymentPool = new Pool({ connectionString: paymentDatabaseUrl });
const streamingPool = new Pool({ connectionString: streamingDatabaseUrl });
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });

const tokens = {
  auth: { 'api-gateway': gatewayToken, 'streaming-service': authStreamingToken },
  profile: { 'api-gateway': gatewayToken, 'streaming-service': profileStreamingToken, 'catalog-service': profileCatalogToken },
  catalog: { 'api-gateway': gatewayToken, 'streaming-service': catalogStreamingToken },
  payment: { 'api-gateway': gatewayToken, 'streaming-service': paymentStreamingToken },
  streamingInbound: { 'api-gateway': gatewayToken, 'profile-service': incomingProfileToken, 'transcode-worker': workerStreamingToken },
  streamingDownstream: {
    'auth-service': authStreamingToken, 'profile-service': profileStreamingToken,
    'catalog-service': catalogStreamingToken, 'payment-service': paymentStreamingToken,
  },
};
const sharedEnv = {
  NODE_ENV: 'test',
  AUTH_DATABASE_URL: authDatabaseUrl, PROFILE_DATABASE_URL: profileDatabaseUrl, CATALOG_DATABASE_URL: catalogDatabaseUrl,
  PAYMENT_DATABASE_URL: paymentDatabaseUrl, STREAMING_DATABASE_URL: streamingDatabaseUrl,
  AUTH_JWT_ISSUER: process.env.AUTH_JWT_ISSUER ?? 'https://auth.movieapp.local',
  AUTH_JWT_AUDIENCE: process.env.AUTH_JWT_AUDIENCE ?? 'movieapp-api', AUTH_JWT_KID: `g5-${suffix}`,
  AUTH_PRIVATE_KEY_PATH: privateKeyPath, AUTH_PUBLIC_KEY_PATH: publicKeyPath,
  AUTH_INTERNAL_TOKENS_JSON: JSON.stringify(tokens.auth), GATEWAY_SERVICE_TOKEN: gatewayToken,
  PROFILE_INTERNAL_TOKENS_JSON: JSON.stringify(tokens.profile),
  CATALOG_INTERNAL_TOKENS_JSON: JSON.stringify(tokens.catalog),
  PAYMENT_INTERNAL_TOKENS_JSON: JSON.stringify(tokens.payment),
  PAYMENT_MOCK_ENABLED: 'true', PAYMENT_MOCK_HMAC_SECRET: `g5-hmac-${randomUUID()}-${randomUUID()}`,
  PAYMENT_MAINTENANCE_POLL_MS: '250', PAYMENT_FREE_MAX_CONCURRENT_STREAMS: '1', PAYMENT_FREE_MAX_RESOLUTION: '720p',
  STREAMING_INTERNAL_TOKENS_JSON: JSON.stringify(tokens.streamingInbound),
  STREAMING_DOWNSTREAM_TOKENS_JSON: JSON.stringify(tokens.streamingDownstream),
  STREAMING_SESSION_TTL_SECONDS: '5', STREAMING_MAINTENANCE_POLL_MS: '250', STREAMING_OUTBOX_POLL_MS: '250',
  STREAMING_SOURCE_RETRY_BASE_MS: '500', STREAMING_PROVIDER_TIMEOUT_MS: '1500', STREAMING_MAX_PROVIDER_RESOLVES: '10',
  MEDIA_AUTH_SECRET: `g5-media-${randomUUID()}-${randomUUID()}`,
  STREAMING_TEST_MEDIA_PORT: String(mediaPort), KKPHIM_MEDIA_HOST_ALLOWLIST: 'media.fixture.invalid',
  REDIS_URL: process.env.REDIS_URL, KAFKA_BROKERS: process.env.KAFKA_BROKERS,
  PROFILE_KAFKA_BROKERS: process.env.KAFKA_BROKERS, STREAMING_KAFKA_BROKERS: process.env.KAFKA_BROKERS,
  AUTH_SERVICE_URL: urls.auth, PROFILE_SERVICE_URL: urls.profile, CATALOG_SERVICE_URL: urls.catalog,
  PAYMENT_SERVICE_URL: urls.payment, STREAMING_SERVICE_URL: urls.streaming,
  KKPHIM_API_BASE_URL: providerUrl, KKPHIM_TIMEOUT_MS: '1000', CATALOG_SYNC_POLL_MS: '250', PROFILE_OUTBOX_POLL_MS: '250',
  AUTH_PORT: String(ports.auth), GATEWAY_PORT: String(ports.gateway), PROFILE_PORT: String(ports.profile),
  CATALOG_PORT: String(ports.catalog), PAYMENT_PORT: String(ports.payment), STREAMING_PORT: String(ports.streaming),
};

const processes = [];
let admin;
let probeDatabase;
let movieCounter = 0;
const gatewayUrl = urls.gateway;

async function makeMovie({ slugPrefix = 'ok', accessTier = 'free', kidsSafe = false, status = 'published', mode = 'external_hls' } = {}) {
  const slug = `${slugPrefix}-${suffix}-${++movieCounter}`;
  const movieId = randomUUID(); const playableId = randomUUID(); const sourceId = randomUUID(); const sourceItemId = randomUUID();
  await catalogPool.query(`INSERT INTO movies(id,title,type,content_kind,status,access_tier,is_kids_safe,average_rating,published_at)
    VALUES($1,$2,'movie','film',$3,$4,$5,0,CASE WHEN $3='published' THEN now() ELSE NULL END)`, [movieId, `G5 Fixture ${slug}`, status, accessTier, kidsSafe]);
  await catalogPool.query(`INSERT INTO playable_items(id,movie_id,kind,label,sort_order,duration_seconds) VALUES($1,$2,'movie','Full',1,120)`, [playableId, movieId]);
  await catalogPool.query(`INSERT INTO content_sources(id,movie_id,source_type,provider,external_id,external_slug,source_status)
    VALUES($1,$2,'third_party','kkphim',$3,$4,'available')`, [sourceId, movieId, `ext-${slug}`, slug]);
  await catalogPool.query(`INSERT INTO source_items(id,movie_id,source_id,playable_id,server_key,server_label,external_episode_key,external_episode_slug,playback_mode,source_status)
    VALUES($1,$2,$3,$4,'vietsub','Vietsub',$5,$6,$7,'available')`, [sourceItemId, movieId, sourceId, playableId, `full-${slug}`, `full-${slug}`, mode]);
  const row = { movieId, playableId, sourceId, sourceItemId, slug, mode };
  movieRows.push(row);
  return row;
}

async function makeOwnedMovie() {
  const movieId = randomUUID(); const playableId = randomUUID(); const sourceId = randomUUID(); const sourceItemId = randomUUID();
  await catalogPool.query(`INSERT INTO movies(id,title,type,content_kind,status,access_tier,is_kids_safe,average_rating,published_at)
    VALUES($1,'G5 owned fixture','movie','film','published','free',true,0,now())`, [movieId]);
  await catalogPool.query(`INSERT INTO playable_items(id,movie_id,kind,label,sort_order,duration_seconds) VALUES($1,$2,'movie','Full',1,120)`, [playableId, movieId]);
  await catalogPool.query(`INSERT INTO content_sources(id,movie_id,source_type,provider,external_id,external_slug,source_status)
    VALUES($1,$2,'owned',NULL,NULL,NULL,'available')`, [sourceId, movieId]);
  await catalogPool.query(`INSERT INTO source_items(id,movie_id,source_id,playable_id,server_key,server_label,external_episode_key,playback_mode,source_status)
    VALUES($1,$2,$3,$4,'owned','Self-distributed',NULL,'owned_hls','available')`, [sourceItemId, movieId, sourceId, playableId]);
  const row = { movieId, playableId, sourceId, sourceItemId, slug: `owned-${suffix}`, mode: 'owned_hls' };
  movieRows.push(row);
  return row;
}

async function registerUser(label) {
  const email = `g5-${label}-${randomUUID()}@example.test`;
  const registered = await request(gatewayUrl, '/auth/register', { method: 'POST', body: { email, password, fullName: `G5 ${label}` } });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const login = await request(gatewayUrl, '/auth/login', { method: 'POST', body: { email, password, deviceId: `g5-${randomUUID()}` } });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const user = { userId: registered.body.data.id, email, accessToken: login.body.data.accessToken, authSessionId: idFromJwt(login.body.data.accessToken) };
  userRows.push(user);
  return user;
}

async function makeProfile(user, { isKids = false, name = 'Viewer' } = {}) {
  const result = await request(gatewayUrl, '/profiles', { method: 'POST', token: user.accessToken, body: { name: `${name}-${randomUUID().slice(0, 5)}`, isKids } });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const profile = { id: result.body.data.id, userId: user.userId, accessToken: user.accessToken, authSessionId: user.authSessionId };
  profileRows.push(profile);
  return profile;
}

async function createPlayback(profile, movie, key = `g5-key-${randomUUID()}`) {
  const response = await request(gatewayUrl, '/streaming/playback-sessions', {
    method: 'POST', token: profile.accessToken, headers: { 'idempotency-key': key },
    body: { movieId: movie.movieId, playableId: movie.playableId, sourceItemId: movie.sourceItemId, profileId: profile.id },
  });
  if (response.status === 201) sessionRows.push(response.body.data.sessionId);
  return response;
}

async function playbackEvent(profile, sessionId, type, playedSeconds) {
  return request(gatewayUrl, `/streaming/playback-sessions/${sessionId}/events`, {
    method: 'POST', token: profile.accessToken,
    body: { eventId: randomUUID(), type, ...(playedSeconds === undefined ? {} : { playedSeconds }) },
  });
}

try {
  const adminUrl = new URL(process.env.POSTGRES_ADMIN_URL);
  const streamingRole = decodeURIComponent(adminUrl.username) === 'movieapp_admin' ? 'movieapp_streaming' : decodeURIComponent(new URL(streamingDatabaseUrl).username);
  assert.match(streamingRole, /^[a-z][a-z0-9_]{0,62}$/);
  admin = new Client({ connectionString: process.env.POSTGRES_ADMIN_URL });
  await admin.connect();
  probeDatabase = `streaming_g5_probe_${suffix}`;
  await admin.query(`CREATE DATABASE "${probeDatabase}" OWNER "${streamingRole}"`);
  const probeUrl = new URL(streamingDatabaseUrl); probeUrl.pathname = `/${probeDatabase}`;
  execFileSync('npm', ['run', 'migration:streaming:run'], { cwd: root, env: { ...process.env, ...sharedEnv, STREAMING_DATABASE_URL: probeUrl.toString() }, stdio: 'pipe' });
  const probePool = new Pool({ connectionString: probeUrl.toString() });
  try {
    const tableResult = await probePool.query(`SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1::text[])`, [[
      'video_assets', 'playback_sessions', 'playback_requests', 'watch_progress', 'playback_events', 'processed_events', 'outbox_events',
    ]]);
    assert.equal(tableResult.rows[0].count, 7, 'fresh Streaming migration creates all 7 G5/G6 tables');
    const columns = await probePool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='playback_sessions'`);
    assert.equal(columns.rows.some((row) => /playback.?url|external.?url/i.test(row.column_name)), false, 'playback sessions never persist provider media URLs');
    await assert.rejects(probePool.query(`INSERT INTO playback_sessions(id,user_id,auth_session_id,profile_id,movie_id,playable_id,source_item_id,source_type,state,last_seq,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'third_party','ready',-1,now()+interval '1 minute')`, [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()]), (error) => error.code === '23514');
  } finally { await probePool.end(); }
  await admin.query(`DROP DATABASE "${probeDatabase}" WITH (FORCE)`); probeDatabase = undefined;
  await admin.end(); admin = undefined;
  console.log('PASS G5 migration: fresh PostgreSQL database, 7 tables, no external URL persistence, CHECK constraint');

  for (const script of ['migration:run', 'migration:profile:run', 'migration:catalog:run', 'migration:payment:run', 'migration:streaming:run']) {
    execFileSync('npm', ['run', script], { cwd: root, env: { ...process.env, ...sharedEnv }, stdio: 'pipe' });
  }
  const free = await makeMovie();
  const subscription = await makeMovie({ slugPrefix: 'sub', accessTier: 'subscription' });
  const kidsUnsafe = await makeMovie({ slugPrefix: 'kids', kidsSafe: false });
  const archived = await makeMovie({ slugPrefix: 'archived', status: 'archived' });
  const embed = await makeMovie({ slugPrefix: 'embed', mode: 'external_embed' });
  const recover = await makeMovie({ slugPrefix: 'recover' });
  const alwaysDown = await makeMovie({ slugPrefix: 'down' });
  const unsafeUrl = await makeMovie({ slugPrefix: 'unsafe' });
  const owned = await makeOwnedMovie();

  const auth = start('Auth', 'apps/auth-service/main.js', sharedEnv);
  const profileService = start('Profile', 'apps/profile-service/main.js', sharedEnv);
  const catalog = start('Catalog', 'apps/catalog-service/main.js', sharedEnv);
  const payment = start('Payment', 'apps/payment-service/main.js', sharedEnv);
  const streaming = start('Streaming', 'apps/streaming-service/main.js', sharedEnv);
  const gateway = start('Gateway', 'apps/api-gateway/main.js', sharedEnv);
  processes.push(auth, profileService, catalog, payment, streaming, gateway);
  await Promise.all([
    ready(auth, urls.auth), ready(profileService, urls.profile), ready(catalog, urls.catalog),
    ready(payment, urls.payment), ready(streaming, urls.streaming), ready(gateway, gatewayUrl),
  ]);
  console.log('PASS G5 startup: Auth, Profile, Catalog, Payment, Streaming, Gateway, PostgreSQL and Redis are ready');

  const owner = await registerUser('owner');
  const ownerProfile = await makeProfile(owner);
  const kidsProfile = await makeProfile(owner, { isKids: true, name: 'Kids' });
  const other = await registerUser('other');
  const otherProfile = await makeProfile(other);

  const missingKey = await request(gatewayUrl, '/streaming/playback-sessions', { method: 'POST', token: owner.accessToken, body: { movieId: free.movieId, playableId: free.playableId, sourceItemId: free.sourceItemId, profileId: ownerProfile.id } });
  assert.equal(missingKey.status, 400, 'gateway requires idempotency key');
  const spoofedIdentity = await request(gatewayUrl, '/streaming/playback-sessions', { method: 'POST', token: owner.accessToken, headers: { 'idempotency-key': `g5-spoof-${randomUUID()}` }, body: { movieId: free.movieId, playableId: free.playableId, sourceItemId: free.sourceItemId, profileId: ownerProfile.id, userId: other.userId } });
  assert.equal(spoofedIdentity.status, 400, 'client cannot inject a user identity into the playback DTO');
  const firstKey = `g5-idem-${randomUUID()}`;
  const first = await createPlayback(ownerProfile, free, firstKey);
  if (first.status >= 500) console.error(processes.map((child) => {
    const errors = child.output().split('\n').filter((line) => /ERROR|Unexpected playback|error.*status/.test(line));
    return errors.length ? `--- ${child.serviceName} ---\n${errors.slice(-8).join('\n')}` : '';
  }).filter(Boolean).join('\n'));
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.match(first.body.data.playbackUrl, /^https:\/\/media\.fixture\.invalid:/);
  assert.equal(first.body.data.protocol, 'hls');
  assert.equal(first.headers.get('cache-control'), 'no-store');
  const noMediaAuth = await request(gatewayUrl, `/streaming/playback-sessions/${first.body.data.sessionId}/media-auth`, { method: 'POST', token: owner.accessToken });
  assert.equal(noMediaAuth.status, 422, 'external playback does not mint owned-media cookies');
  const mediaManifest = await httpsFixtureGet(first.body.data.playbackUrl);
  assert.equal(mediaManifest.status, 200);
  assert.match(mediaManifest.body.toString(), /^#EXTM3U/);
  const segment = await httpsFixtureGet(new URL('segment.ts', first.body.data.playbackUrl).toString());
  assert.equal(segment.status, 200);
  assert.equal(segment.body.length, 4, 'separate local HTTPS media fixture serves a media segment');
  const replay = await createPlayback(ownerProfile, free, firstKey);
  assert.equal(replay.status, 201, JSON.stringify(replay.body));
  assert.equal(replay.body.data.sessionId, first.body.data.sessionId, 'same idempotency key reuses its active session');
  assert.equal(replay.body.data.idempotentReplay, true);
  assert.notEqual(replay.body.data.playbackUrl, first.body.data.playbackUrl, 'KKPhim detail is refetched and the media URL is fresh');
  const activeSlots = await redis.zcard(`movieapp:playback:user:${owner.userId}:sessions`);
  assert.equal(activeSlots, 1, 'idempotent replay does not consume a second Redis slot');
  const progress2 = await request(gatewayUrl, `/streaming/playback-sessions/${first.body.data.sessionId}/progress`, { method: 'POST', token: owner.accessToken, body: { seq: '2', positionSeconds: 80, durationSeconds: 120 } });
  assert.equal(progress2.status, 200, JSON.stringify(progress2.body));
  const progress3 = await request(gatewayUrl, `/streaming/playback-sessions/${first.body.data.sessionId}/progress`, { method: 'POST', token: owner.accessToken, body: { seq: '3', positionSeconds: 30, durationSeconds: null } });
  assert.equal(progress3.body.data.progress.positionSeconds, 30, 'rewind is accepted and nullable duration is retained');
  const stale = await request(gatewayUrl, `/streaming/playback-sessions/${first.body.data.sessionId}/progress`, { method: 'POST', token: owner.accessToken, body: { seq: '2', positionSeconds: 110, durationSeconds: 120 } });
  assert.equal(stale.body.data.applied, false, 'out-of-order sequence cannot overwrite progress');
  assert.equal(stale.body.data.progress.positionSeconds, 30);
  const otherHeartbeat = await request(gatewayUrl, `/streaming/playback-sessions/${first.body.data.sessionId}/heartbeat`, { method: 'POST', token: other.accessToken });
  assert.equal(otherHeartbeat.status, 404, 'another account cannot heartbeat this session');
  const otherProgress = await request(gatewayUrl, `/streaming/playback-sessions/${first.body.data.sessionId}/progress`, { method: 'POST', token: other.accessToken, body: { seq: '1', positionSeconds: 1 } });
  assert.equal(otherProgress.status, 404, 'another account cannot write progress to this session');
  const secondOwnerLogin = await request(gatewayUrl, '/auth/login', { method: 'POST', body: { email: owner.email, password, deviceId: `g5-second-device-${randomUUID()}` } });
  assert.equal(secondOwnerLogin.status, 200);
  const otherDeviceHeartbeat = await request(gatewayUrl, `/streaming/playback-sessions/${first.body.data.sessionId}/heartbeat`, { method: 'POST', token: secondOwnerLogin.body.data.accessToken });
  assert.equal(otherDeviceHeartbeat.status, 404, 'a different Auth session cannot reuse the playback session');
  const quota = await createPlayback(ownerProfile, free, `g5-quota-${randomUUID()}`);
  assert.equal(quota.status, 409, 'free tier concurrent playback limit is enforced');
  const heartbeat = await request(gatewayUrl, `/streaming/playback-sessions/${first.body.data.sessionId}/heartbeat`, { method: 'POST', token: owner.accessToken });
  assert.equal(heartbeat.status, 200, JSON.stringify(heartbeat.body));
  const started = await playbackEvent(ownerProfile, first.body.data.sessionId, 'started');
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const qualifiedEventId = randomUUID();
  const qualified = await request(gatewayUrl, `/streaming/playback-sessions/${first.body.data.sessionId}/events`, { method: 'POST', token: owner.accessToken, body: { eventId: qualifiedEventId, type: 'qualified', playedSeconds: 30 } });
  assert.equal(qualified.status, 200, JSON.stringify(qualified.body));
  const qualifiedReplay = await request(gatewayUrl, `/streaming/playback-sessions/${first.body.data.sessionId}/events`, { method: 'POST', token: owner.accessToken, body: { eventId: qualifiedEventId, type: 'qualified', playedSeconds: 30 } });
  assert.equal(qualifiedReplay.body.data.duplicate, true, 'qualified event replay is idempotent');
  await waitFor(async () => (await streamingPool.query(`SELECT published_at FROM outbox_events WHERE event_type='playback.qualified' AND aggregate_id=$1`, [first.body.data.sessionId])).rows[0]?.published_at, 'playback.qualified was not published by the transactional outbox');
  const stopped = await playbackEvent(ownerProfile, first.body.data.sessionId, 'stopped');
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  const stoppedReplay = await request(gatewayUrl, `/streaming/playback-sessions/${first.body.data.sessionId}/events`, { method: 'POST', token: owner.accessToken, body: { eventId: stopped.body.data.eventId, type: 'stopped' } });
  assert.equal(stoppedReplay.body.data.duplicate, true, 'terminal event duplicate does not repeat side effects');
  const terminalKeyReplay = await createPlayback(ownerProfile, free, firstKey);
  assert.equal(terminalKeyReplay.status, 409, 'terminal idempotency key cannot silently open a replacement session');

  const second = await createPlayback(ownerProfile, free);
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const newSessionProgress = await request(gatewayUrl, `/streaming/playback-sessions/${second.body.data.sessionId}/progress`, { method: 'POST', token: owner.accessToken, body: { seq: '1', positionSeconds: 10 } });
  assert.equal(newSessionProgress.body.data.applied, true, 'server-issued session ordinal lets a new session replace the old progress');
  const cached = await redis.hget(`movieapp:progress:${ownerProfile.id}:${free.playableId}`, 'payload');
  assert.ok(cached);
  await redis.hset(`movieapp:progress:${ownerProfile.id}:${free.playableId}`, 'ordinal', 'broken', 'seq', 'broken', 'payload', '{');
  const profileProgress = await request(urls.streaming, `/internal/streaming/profiles/${ownerProfile.id}/progress?playableId=${free.playableId}`, {
    headers: { authorization: `Bearer ${incomingProfileToken}`, 'x-caller-service': 'profile-service' },
  });
  assert.equal(profileProgress.status, 200, JSON.stringify(profileProgress.body));
  assert.equal(profileProgress.body.data.positionSeconds, 10, 'corrupt Redis cache falls back to PostgreSQL');
  await playbackEvent(ownerProfile, second.body.data.sessionId, 'stopped');
  const third = await createPlayback(ownerProfile, free);
  assert.equal(third.status, 201, JSON.stringify(third.body));
  assert.equal(third.body.data.resumePositionSeconds, 10, 'new session resumes from committed PostgreSQL progress');
  if (process.env.G9_LOAD === 'true') {
    const durations = [];
    for (let offset = 0; offset < 50; offset += 10) {
      const batch = await Promise.all(Array.from({ length: 10 }, async (_, index) => {
        const startedAt = performance.now();
        const response = await request(gatewayUrl, `/streaming/playback-sessions/${third.body.data.sessionId}/progress`, { method: 'POST', token: owner.accessToken, body: { seq: String(1_000 + offset + index), positionSeconds: 20 + offset + index, durationSeconds: 120 } });
        durations.push(performance.now() - startedAt);
        return response;
      }));
      assert.equal(batch.every((response) => response.status === 200), true, 'all progress-load requests must receive a durable response');
    }
    console.log(`G9_METRIC progress_write_p95_ms=${p95(durations).toFixed(2)} requests=${durations.length} concurrency=10`);
  }
  await playbackEvent(ownerProfile, third.body.data.sessionId, 'stopped');
  console.log('PASS G5 playback: fresh KKPhim URL, actual HLS fixture, session idempotency, slot limit, ownership, heartbeat, rewind/order/resume, qualified outbox');

  const mismatch = await createPlayback(ownerProfile, { ...free, movieId: subscription.movieId });
  assert.equal(mismatch.status, 404, 'movie/playable/source cross-mapping is rejected');
  const kidsDenied = await createPlayback(kidsProfile, kidsUnsafe);
  assert.equal(kidsDenied.status, 404, 'kids profile cannot access unsuitable content');
  const subscriptionDenied = await createPlayback(ownerProfile, subscription);
  assert.equal(subscriptionDenied.status, 403, 'subscription tier requires entitlement');
  const archivedDenied = await createPlayback(ownerProfile, archived);
  assert.equal(archivedDenied.status, 404, 'archived content cannot start a session');
  const embedDenied = await createPlayback(ownerProfile, embed);
  assert.equal(embedDenied.status, 422, 'embed-only source does not return a playback URL');
  const unsafeDenied = await createPlayback(ownerProfile, unsafeUrl);
  assert.equal(unsafeDenied.status, 503, 'resolver rejects an HLS URL outside the exact host allowlist');
  const ownedDenied = await createPlayback(ownerProfile, owned);
  assert.equal(ownedDenied.status, 409, 'owned source without uploaded asset returns VIDEO_NOT_READY');
  assert.equal(ownedDenied.body.error.code, 'VIDEO_NOT_READY');

  const recoverFail = await createPlayback(ownerProfile, recover);
  assert.equal(recoverFail.status, 503, 'three real fixture HTTP 503 responses fail resolution');
  assert.equal(await redis.zcard(`movieapp:playback:user:${owner.userId}:sessions`), 0, 'failed provider resolution releases the Redis lease');
  await delay(700);
  const recovered = await createPlayback(ownerProfile, recover);
  assert.equal(recovered.status, 201, JSON.stringify(recovered.body));
  assert.ok((providerCalls.get(recover.slug) ?? 0) >= 4, 'provider was called again after retry backoff and recovered');
  await playbackEvent(ownerProfile, recovered.body.data.sessionId, 'stopped');
  const downFailed = await createPlayback(ownerProfile, alwaysDown);
  assert.equal(downFailed.status, 503, 'permanently failing provider returns controlled unavailable response');
  assert.equal(await redis.zcard(`movieapp:playback:user:${owner.userId}:sessions`), 0, 'provider errors never leak the playback slot');
  console.log('PASS G5 provider resilience: selector/mode/URL policy, 503 retry recovery and lease release');

  const raceMovie = await makeMovie({ slugPrefix: 'race' });
  const raceResults = await Promise.all([
    createPlayback(otherProfile, raceMovie, `g5-race-a-${randomUUID()}`),
    createPlayback(otherProfile, raceMovie, `g5-race-b-${randomUUID()}`),
  ]);
  assert.deepEqual(raceResults.map((result) => result.status).sort(), [201, 409], 'concurrent requests cannot exceed the one-slot quota');
  const raceSuccess = raceResults.find((result) => result.status === 201);
  await playbackEvent(otherProfile, raceSuccess.body.data.sessionId, 'stopped');
  console.log('PASS G5 quota race: concurrent reservations return exactly one slot');

  const deletedProfile = await makeProfile(other, { name: 'Delete' });
  const deleteSession = await createPlayback(deletedProfile, free);
  assert.equal(deleteSession.status, 201, JSON.stringify(deleteSession.body));
  const deleteSessionId = deleteSession.body.data.sessionId;
  await request(gatewayUrl, `/streaming/playback-sessions/${deleteSessionId}/progress`, { method: 'POST', token: other.accessToken, body: { seq: '1', positionSeconds: 15, durationSeconds: null } });
  assert.equal(await redis.exists(`movieapp:progress:${deletedProfile.id}:${free.playableId}`), 1, 'progress cache exists before profile cleanup');
  const deleted = await request(gatewayUrl, `/profiles/${deletedProfile.id}`, { method: 'DELETE', token: other.accessToken });
  assert.equal(deleted.status, 204, 'Profile delete commits through Profile service');
  await waitFor(async () => {
    const result = await streamingPool.query(`SELECT state FROM playback_sessions WHERE id=$1`, [deleteSessionId]);
    return result.rows[0]?.state === 'stopped';
  }, 'profile.deleted event did not close the playback session');
  const deletedProgress = await streamingPool.query(`SELECT 1 FROM watch_progress WHERE profile_id=$1`, [deletedProfile.id]);
  assert.equal(deletedProgress.rowCount, 0, 'profile.deleted event removes progress');
  assert.equal(await redis.exists(`movieapp:progress:${deletedProfile.id}:${free.playableId}`), 0, 'profile.deleted removes cached progress');
  assert.equal(await redis.zscore(`movieapp:playback:user:${other.userId}:sessions`, deleteSessionId), null, 'profile.deleted releases the Redis slot');
  console.log('PASS G5 profile.deleted consumer: session, progress, cache and lease cleanup');

  const expiry = await createPlayback(ownerProfile, free);
  assert.equal(expiry.status, 201, JSON.stringify(expiry.body));
  await delay(5_300);
  const expiredHeartbeat = await request(gatewayUrl, `/streaming/playback-sessions/${expiry.body.data.sessionId}/heartbeat`, { method: 'POST', token: owner.accessToken });
  assert.equal(expiredHeartbeat.status, 409, 'expired session cannot be revived');
  await waitFor(async () => {
    const result = await streamingPool.query(`SELECT state FROM playback_sessions WHERE id=$1`, [expiry.body.data.sessionId]);
    return result.rows[0]?.state === 'expired';
  }, 'maintenance job did not mark the expired session');
  assert.equal(await redis.zscore(`movieapp:playback:user:${owner.userId}:sessions`, expiry.body.data.sessionId), null, 'expiry reaper also releases the Redis slot');
  console.log('PASS G5 lease expiry: heartbeat cannot revive and maintenance reaps the session');

  const outageToken = `g5-outage-gateway-${randomUUID()}-${randomUUID()}`;
  const outageService = start('Streaming Redis-outage probe', 'apps/streaming-service/main.js', {
    ...sharedEnv,
    STREAMING_PORT: String(ports.outage),
    REDIS_URL: 'redis://127.0.0.1:1/0',
    STREAMING_INTERNAL_TOKENS_JSON: JSON.stringify({ 'api-gateway': outageToken, 'profile-service': incomingProfileToken, 'transcode-worker': workerStreamingToken }),
  });
  processes.push(outageService);
  await ready(outageService, urls.outage, '/health');
  const noRedisKey = `g5-no-redis-${randomUUID()}`;
  const noRedis = await request(urls.outage, '/streaming/playback-sessions', {
    method: 'POST', headers: { authorization: `Bearer ${outageToken}`, 'x-caller-service': 'api-gateway', 'x-user-id': owner.userId,
      'x-auth-session-id': owner.authSessionId, 'idempotency-key': noRedisKey },
    body: { movieId: free.movieId, playableId: free.playableId, sourceItemId: free.sourceItemId, profileId: ownerProfile.id },
  });
  assert.equal(noRedis.status, 503, JSON.stringify(noRedis.body));
  const unreserved = await streamingPool.query(`SELECT 1 FROM playback_requests WHERE user_id=$1 AND idempotency_key=$2`, [owner.userId, noRedisKey]);
  assert.equal(unreserved.rowCount, 0, 'Redis lease failure fails closed before any session/request is committed');
  console.log('PASS G5 Redis outage: creation fails closed and writes no session request');

  const leaked = await streamingPool.query(`SELECT count(*)::int AS count FROM playback_sessions WHERE to_jsonb(playback_sessions)::text ILIKE '%media.fixture.invalid%'`);
  assert.equal(leaked.rows[0].count, 0, 'external media URLs are never stored in PostgreSQL sessions');
  const externalAssets = await streamingPool.query(`SELECT count(*)::int AS count FROM video_assets WHERE source_item_id=ANY($1::uuid[])`, [movieRows.map((row) => row.sourceItemId)]);
  assert.equal(externalAssets.rows[0].count, 0, 'KKPhim source items never create owned video assets');
  console.log('PASS G5 persistence boundary: no third-party HLS URL or video_assets row persisted');
} finally {
  for (const child of processes.reverse()) await stop(child).catch(() => undefined);
  await closeServer(provider).catch(() => undefined);
  await closeServer(hlsFixture).catch(() => undefined);
  if (probeDatabase && admin) await admin.query(`DROP DATABASE "${probeDatabase}" WITH (FORCE)`).catch(() => undefined);
  if (userRows.length) {
    const userIds = userRows.map((user) => user.userId);
    const profileIds = profileRows.map((profile) => profile.id);
    const sessionIds = sessionRows;
    await streamingPool.query(`DELETE FROM outbox_events WHERE aggregate_id=ANY($1::uuid[])`, [sessionIds]).catch(() => undefined);
    await streamingPool.query(`DELETE FROM watch_progress WHERE profile_id=ANY($1::uuid[])`, [profileIds]).catch(() => undefined);
    await streamingPool.query(`DELETE FROM playback_sessions WHERE user_id=ANY($1::uuid[])`, [userIds]).catch(() => undefined);
    await profilePool.query(`DELETE FROM outbox_events WHERE aggregate_id=ANY($1::uuid[])`, [profileIds]).catch(() => undefined);
    await profilePool.query(`DELETE FROM profiles WHERE user_id=ANY($1::uuid[])`, [userIds]).catch(() => undefined);
    await profilePool.query(`DELETE FROM profile_quotas WHERE user_id=ANY($1::uuid[])`, [userIds]).catch(() => undefined);
    await authPool.query(`DELETE FROM users WHERE id=ANY($1::uuid[])`, [userIds]).catch(() => undefined);
  }
  if (movieRows.length) {
    await catalogPool.query(`DELETE FROM outbox_events WHERE aggregate_id=ANY($1::uuid[])`, [movieRows.map((movie) => movie.movieId)]).catch(() => undefined);
    await catalogPool.query(`DELETE FROM movies WHERE id=ANY($1::uuid[])`, [movieRows.map((movie) => movie.movieId)]).catch(() => undefined);
  }
  for (const profile of profileRows) {
    const keys = movieRows.map((movie) => `movieapp:progress:${profile.id}:${movie.playableId}`);
    if (keys.length) await redis.del(...keys).catch(() => undefined);
  }
  for (const user of userRows) await redis.del(`movieapp:playback:user:${user.userId}:sessions`).catch(() => undefined);
  await Promise.all([authPool.end().catch(() => undefined), profilePool.end().catch(() => undefined), catalogPool.end().catch(() => undefined), paymentPool.end().catch(() => undefined), streamingPool.end().catch(() => undefined), redis.quit().catch(() => undefined)]);
  if (admin) await admin.end().catch(() => undefined);
  await rm(tempDir, { recursive: true, force: true });
}
