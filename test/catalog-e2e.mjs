import 'dotenv/config';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

const { Pool } = pg;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const authDatabaseUrl = process.env.AUTH_DATABASE_URL;
const profileDatabaseUrl = process.env.PROFILE_DATABASE_URL;
const catalogDatabaseUrl = process.env.CATALOG_DATABASE_URL;
assert.ok(authDatabaseUrl && profileDatabaseUrl && catalogDatabaseUrl, 'Auth, Profile and Catalog databases must point to Compose PostgreSQL');

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
    try { const response = await fetch(`${url}/ready`, { signal: AbortSignal.timeout(500) }); if (response.ok) return; } catch { /* listener is still starting */ }
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

async function login(gatewayUrl, email, password, deviceId) {
  const result = await request(gatewayUrl, '/auth/login', { method: 'POST', body: { email, password, deviceId } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.data;
}

async function pollRun(gatewayUrl, runId, token) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request(gatewayUrl, '/admin/providers/kkphim/sync-runs?page=1&pageSize=50', { token });
    const run = response.body?.data?.items?.find((item) => item.id === runId);
    if (run && ['completed', 'partial', 'failed'].includes(run.status)) return run;
    await delay(100);
  }
  throw new Error(`Sync run ${runId} did not finish`);
}

async function waitForPublishedEvent(pool, aggregateId, eventType) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await pool.query(`SELECT published_at FROM outbox_events WHERE aggregate_id=$1 AND event_type=$2 ORDER BY occurred_at LIMIT 1`, [aggregateId, eventType]);
    if (result.rows[0]?.published_at) return result.rows[0].published_at;
    await delay(100);
  }
  throw new Error(`Catalog outbox event ${eventType} for ${aggregateId} was not acknowledged by Kafka`);
}

const gatewayToken = `g3-e2e-gateway-${randomUUID()}-token-long-enough`;
const catalogServiceToken = `g3-e2e-catalog-${randomUUID()}-token-long-enough`;
const streamingToken = `g3-e2e-streaming-${randomUUID()}-token-long-enough`;
const paymentToken = `g3-e2e-payment-${randomUUID()}-token-long-enough`;
const password = 'G3-Catalog-E2E-password-2026!';
const adminEmail = `g3-admin-${randomUUID()}@example.test`;
const adminPassword = password;
const fixtureMovieId = `kk-g3-film-${randomUUID()}`;
const fixtureSeriesId = `kk-g3-series-${randomUUID()}`;
const suffix = randomUUID().replaceAll('-', '');
const filmSlug = `g3-film-${suffix}`;
const seriesSlug = `g3-series-${suffix}`;
const seriesRenamedSlug = `${seriesSlug}-renamed`;
const fixtureUrl = 'https://media.fixture.invalid/hls/master.m3u8?credential=must-not-persist';
const fixtureEmbed = 'https://player.fixture.invalid/embed?id=must-not-persist';
const film = {
  status: true, pathImage: 'https://images.fixture.invalid/uploads/',
  movie: { _id: fixtureMovieId, slug: filmSlug, name: 'G3 Hoạt hình Full', origin_name: 'G3 Animation Full', content: '<p>Đủ metadata</p>', type: 'single', year: 2024, time: '90 phút', tmdb: { vote_average: 10 }, poster_url: 'poster.jpg', category: [{ name: 'Hoạt hình', slug: 'hoat-hinh' }], country: [{ name: 'Việt Nam', slug: 'viet-nam' }] },
  episodes: [
    { server_name: 'Vietsub', server_data: [{ name: 'Full', slug: 'full-vietsub', filename: 'film-vietsub-full', link_m3u8: fixtureUrl }] },
    { server_name: 'Thuyết minh', server_data: [{ name: 'Full', slug: 'full-thuyet-minh', filename: 'film-dub-full', link_m3u8: fixtureUrl }] },
  ],
};
let series = {
  status: true, pathImage: 'https://images.fixture.invalid/uploads/',
  movie: { _id: fixtureSeriesId, slug: seriesSlug, name: 'G3 Series ban đầu', origin_name: 'G3 Series Original', content: '<p>Series</p>', type: 'series', episode_total: '2', year: 2025, tmdb: { vote_average: 10 }, poster_url: 'series.jpg', category: [{ name: 'Tâm lý', slug: 'tam-ly' }], country: [] },
  episodes: [
    { server_name: 'Server A', server_data: [{ name: 'Tập 1', slug: 'tap-1-a', filename: 'series-a-episode-1', link_m3u8: fixtureUrl }, { name: 'Special', slug: 'special-a', filename: 'series-a-special', link_embed: fixtureEmbed }] },
    { server_name: 'Server B', server_data: [{ name: 'Tập 1', slug: 'tap-1-b', filename: 'series-b-episode-1', link_m3u8: fixtureUrl }, { name: 'Special', slug: 'special-b', filename: 'series-b-special', link_embed: fixtureEmbed }] },
  ],
};

const provider = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  response.setHeader('content-type', 'application/json');
  if (url.pathname.startsWith('/phim/')) {
    const slug = decodeURIComponent(url.pathname.slice('/phim/'.length));
    const record = slug === filmSlug ? film : [seriesSlug, seriesRenamedSlug].includes(slug) ? series : null;
    if (!record) { response.statusCode = 404; response.end(JSON.stringify({ status: false })); return; }
    response.end(JSON.stringify(record));
    return;
  }
  if (url.pathname.includes('/tim-kiem')) {
    response.end(JSON.stringify({ status: 'success', data: { items: [{ _id: fixtureMovieId, slug: filmSlug, name: film.movie.name }], params: { pagination: { currentPage: 1, totalItems: 1, totalItemsPerPage: 20, pageRanges: 1 } } } }));
    return;
  }
  if (url.pathname.includes('/danh-sach/')) {
    response.end(JSON.stringify({ status: true, items: [{ _id: fixtureMovieId, slug: filmSlug, name: film.movie.name }], pagination: { currentPage: 1, totalItems: 1, totalItemsPerPage: 1, totalPages: 1 } }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ status: false }));
});

const tempDir = await mkdtemp(resolve(tmpdir(), 'movieapp-g3-'));
const keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const privateKeyPath = resolve(tempDir, 'auth-private.pem');
const publicKeyPath = resolve(tempDir, 'auth-public.pem');
await writeFile(privateKeyPath, keys.privateKey, { mode: 0o600 });
await writeFile(publicKeyPath, keys.publicKey);

const authPort = await unusedPort();
const gatewayPort = await unusedPort();
const profilePort = await unusedPort();
const catalogPort = await unusedPort();
const providerPort = await unusedPort();
await new Promise((resolveListen, reject) => { provider.once('error', reject); provider.listen(providerPort, '127.0.0.1', resolveListen); });
const authUrl = `http://127.0.0.1:${authPort}`;
const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
const profileUrl = `http://127.0.0.1:${profilePort}`;
const catalogUrl = `http://127.0.0.1:${catalogPort}`;
const providerUrl = `http://127.0.0.1:${providerPort}`;
const internalTokens = { 'api-gateway': gatewayToken, 'streaming-service': streamingToken, 'catalog-service': catalogServiceToken, 'payment-service': paymentToken };
const commonEnv = {
  AUTH_DATABASE_URL: authDatabaseUrl, PROFILE_DATABASE_URL: profileDatabaseUrl, CATALOG_DATABASE_URL: catalogDatabaseUrl,
  AUTH_JWT_ISSUER: process.env.AUTH_JWT_ISSUER ?? 'https://auth.movieapp.local', AUTH_JWT_AUDIENCE: process.env.AUTH_JWT_AUDIENCE ?? 'movieapp-api', AUTH_JWT_KID: `g3-${randomUUID()}`,
  AUTH_PRIVATE_KEY_PATH: privateKeyPath, AUTH_PUBLIC_KEY_PATH: publicKeyPath,
  AUTH_INTERNAL_TOKENS_JSON: JSON.stringify({ 'api-gateway': gatewayToken }), GATEWAY_SERVICE_TOKEN: gatewayToken,
  CATALOG_INTERNAL_TOKENS_JSON: JSON.stringify({ 'api-gateway': gatewayToken }), PROFILE_INTERNAL_TOKENS_JSON: JSON.stringify(internalTokens),
  PROFILE_SERVICE_URL: profileUrl, CATALOG_SERVICE_URL: catalogUrl, AUTH_SERVICE_URL: authUrl,
  AUTH_PORT: String(authPort), GATEWAY_PORT: String(gatewayPort), PROFILE_PORT: String(profilePort), CATALOG_PORT: String(catalogPort),
  KKPHIM_API_BASE_URL: providerUrl, KKPHIM_TIMEOUT_MS: '1500', CATALOG_SYNC_POLL_MS: '250', PROFILE_OUTBOX_POLL_MS: '250',
  PROFILE_KAFKA_BROKERS: process.env.KAFKA_BROKERS ?? '127.0.0.1:19092', KAFKA_BROKERS: process.env.KAFKA_BROKERS ?? '127.0.0.1:19092',
  SEED_ADMIN_EMAIL: adminEmail, SEED_ADMIN_PASSWORD: adminPassword, SEED_ADMIN_FULL_NAME: 'G3 E2E Admin',
};

const pool = new Pool({ connectionString: catalogDatabaseUrl });
let authProcess; let gatewayProcess; let profileProcess; let catalogProcess;
let testMovieIds = [];
try {
  for (const script of ['migration:run', 'migration:profile:run', 'migration:catalog:run']) execFileSync('npm', ['run', script], { cwd: root, stdio: 'inherit', env: process.env });
  authProcess = start('Auth', 'apps/auth-service/main.js', { ...commonEnv, NODE_ENV: 'test' });
  profileProcess = start('Profile', 'apps/profile-service/main.js', { ...commonEnv, NODE_ENV: 'test' });
  catalogProcess = start('Catalog', 'apps/catalog-service/main.js', { ...commonEnv, NODE_ENV: 'test' });
  gatewayProcess = start('Gateway', 'apps/api-gateway/main.js', { ...commonEnv, NODE_ENV: 'test' });
  await Promise.all([ready(authProcess, authUrl), ready(profileProcess, profileUrl), ready(catalogProcess, catalogUrl), ready(gatewayProcess, gatewayUrl)]);
  console.log('PASS G3 startup: Auth, Gateway, Profile and Catalog are ready on PostgreSQL Compose');

  const admin = await login(gatewayUrl, adminEmail, adminPassword, `g3-admin-${randomUUID()}`);
  assert.equal(admin.user.role, 'admin');
  const user = await request(gatewayUrl, '/auth/register', { method: 'POST', body: { email: `g3-user-${randomUUID()}@example.test`, password, fullName: 'G3 Kids Profile User' } });
  assert.equal(user.status, 201, JSON.stringify(user.body));
  const userLogin = await login(gatewayUrl, user.body.data.email, password, `g3-user-${randomUUID()}`);
  const kidsProfile = await request(gatewayUrl, '/profiles', { method: 'POST', token: userLogin.accessToken, body: { name: 'Kids', isKids: true } });
  assert.equal(kidsProfile.status, 201, JSON.stringify(kidsProfile.body));
  const guestAdmin = await request(gatewayUrl, '/admin/providers/kkphim/search?keyword=phim', {});
  assert.equal(guestAdmin.status, 401);
  const userAdmin = await request(gatewayUrl, '/admin/providers/kkphim/search?keyword=phim', { token: userLogin.accessToken });
  assert.equal(userAdmin.status, 403);
  const providerSearch = await request(gatewayUrl, '/admin/providers/kkphim/search?keyword=phim', { token: admin.accessToken });
  assert.equal(providerSearch.status, 200, JSON.stringify(providerSearch.body));
  assert.equal(providerSearch.body.data.items[0].slug, filmSlug);
  console.log('PASS G3 gateway: public/admin auth boundary, Admin role, provider search fixture');

  const manual = await request(gatewayUrl, '/admin/movies', { method: 'POST', token: admin.accessToken, body: { title: 'Owned series', type: 'series', contentKind: 'animation', isKidsSafe: true, averageRating: 10 } });
  assert.equal(manual.status, 201, JSON.stringify(manual.body));
  const ownedMovieId = manual.body.data.movieId;
  testMovieIds.push(ownedMovieId);
  const season = await request(gatewayUrl, `/admin/movies/${ownedMovieId}/seasons`, { method: 'POST', token: admin.accessToken, body: { seasonNumber: 1, isSynthetic: true } });
  assert.equal(season.status, 201, JSON.stringify(season.body));
  const ownedPlayable = await request(gatewayUrl, `/admin/movies/${ownedMovieId}/playable-items`, { method: 'POST', token: admin.accessToken, body: { kind: 'episode', seasonId: season.body.data.id, episodeNumber: 1, label: 'Tập 1', sortOrder: 100 } });
  assert.equal(ownedPlayable.status, 201, JSON.stringify(ownedPlayable.body));
  const ownedSource = await request(gatewayUrl, `/admin/movies/${ownedMovieId}/content-sources`, { method: 'POST', token: admin.accessToken, body: { sourceType: 'owned' } });
  assert.equal(ownedSource.status, 201, JSON.stringify(ownedSource.body));
  const ownedItem = await request(gatewayUrl, `/admin/content-sources/${ownedSource.body.data.id}/items`, { method: 'POST', token: admin.accessToken, body: { playableId: ownedPlayable.body.data.id, serverKey: 'owned', serverLabel: 'Bản tự phân phối', playbackMode: 'owned_hls', sourceStatus: 'available' } });
  assert.equal(ownedItem.status, 201, JSON.stringify(ownedItem.body));
  const ownedState = await pool.query('SELECT si.source_status FROM source_items si WHERE si.id=$1', [ownedItem.body.data.id]);
  assert.equal(ownedState.rows[0].source_status, 'unknown', 'Catalog cannot mark an owned upload ready before Streaming G6');

  const importSeries = await request(gatewayUrl, '/admin/providers/kkphim/import', { method: 'POST', token: admin.accessToken, body: { slug: seriesSlug, movieId: ownedMovieId } });
  assert.equal(importSeries.status, 202, JSON.stringify(importSeries.body));
  const seriesRun = await pollRun(gatewayUrl, importSeries.body.data.syncRunId, admin.accessToken);
  assert.equal(seriesRun.status, 'completed', JSON.stringify(seriesRun));
  const seriesMovie = await pool.query(`SELECT m.id,m.status,m.title,m.average_rating,m.version,cs.id AS source_id,cs.external_slug,cs.metadata_locked FROM movies m JOIN content_sources cs ON cs.movie_id=m.id WHERE cs.provider='kkphim' AND cs.external_id=$1`, [fixtureSeriesId]);
  assert.equal(seriesMovie.rowCount, 1);
  assert.equal(seriesMovie.rows[0].id, ownedMovieId, 'movieId attaches the provider to the existing MovieApp identity');
  assert.equal(seriesMovie.rows[0].status, 'published');
  assert.equal(Number(seriesMovie.rows[0].average_rating), 10);
  const seriesItems = await pool.query(`SELECT si.id,si.playable_id,si.server_key,si.external_episode_key,si.playback_mode,si.source_status,pi.label,pi.episode_number FROM source_items si JOIN playable_items pi ON pi.id=si.playable_id WHERE si.source_id=$1 ORDER BY si.server_key,pi.sort_order`, [seriesMovie.rows[0].source_id]);
  assert.equal(seriesItems.rowCount, 4, 'two episodes/specials × two servers create distinct sourceItemIds');
  const episodeRows = seriesItems.rows.filter((row) => row.episode_number === 1);
  assert.equal(episodeRows.length, 2);
  assert.equal(episodeRows[0].playable_id, ownedPlayable.body.data.id);
  assert.equal(episodeRows[1].playable_id, ownedPlayable.body.data.id, 'same episode across servers shares one playableId');
  assert.notEqual(episodeRows[0].id, episodeRows[1].id);
  assert.equal(seriesItems.rows.filter((row) => row.label === 'Special' && row.episode_number === null).length, 2, 'special labels remain non-numeric');
  const ownedThirdPartySources = await pool.query(`SELECT source_type FROM content_sources WHERE movie_id=$1 ORDER BY source_type`, [ownedMovieId]);
  assert.deepEqual(ownedThirdPartySources.rows.map((row) => row.source_type), ['owned', 'third_party']);
  console.log('PASS G3 import: owned + KKPhim attached, series/special mapping, stable playable IDs, no fake owned-ready asset');

  const importFilm = await request(gatewayUrl, '/admin/providers/kkphim/import', { method: 'POST', token: admin.accessToken, body: { slug: filmSlug } });
  assert.equal(importFilm.status, 202, JSON.stringify(importFilm.body));
  const filmRun = await pollRun(gatewayUrl, importFilm.body.data.syncRunId, admin.accessToken);
  assert.equal(filmRun.status, 'completed', JSON.stringify(filmRun));
  const importedFilm = await pool.query(`SELECT m.id,m.type,m.content_kind,m.average_rating,cs.id AS source_id FROM movies m JOIN content_sources cs ON cs.movie_id=m.id WHERE cs.provider='kkphim' AND cs.external_id=$1`, [fixtureMovieId]);
  testMovieIds.push(importedFilm.rows[0].id);
  assert.equal(importedFilm.rows[0].type, 'movie');
  assert.equal(importedFilm.rows[0].content_kind, 'animation', 'animation is not automatically forced to series');
  assert.equal(Number(importedFilm.rows[0].average_rating), 10);
  const filmItems = await pool.query(`SELECT si.id,si.playable_id,si.server_key,si.external_episode_key,pi.label,pi.kind FROM source_items si JOIN playable_items pi ON pi.id=si.playable_id WHERE si.source_id=$1`, [importedFilm.rows[0].source_id]);
  assert.equal(filmItems.rowCount, 2);
  assert.equal(new Set(filmItems.rows.map((row) => row.playable_id)).size, 1, 'both provider servers for a film share one playableId');
  assert.equal(new Set(filmItems.rows.map((row) => row.id)).size, 2);
  assert.ok(filmItems.rows.every((row) => row.label === 'Full' && row.kind === 'movie'));

  const publicList = await request(gatewayUrl, '/catalog/movies?page=1&pageSize=50');
  assert.equal(publicList.status, 200, JSON.stringify(publicList.body));
  assert.ok(publicList.body.data.items.some((item) => item.id === ownedMovieId));
  assert.ok(publicList.body.data.items.some((item) => item.id === importedFilm.rows[0].id));
  assert.equal(publicList.headers.get('cache-control'), 'public, max-age=300');
  const profileRequired = await request(gatewayUrl, `/catalog/movies?profileId=${kidsProfile.body.data.id}`);
  assert.equal(profileRequired.status, 401, 'profileId forces Gateway JWT validation');
  const kidsList = await request(gatewayUrl, `/catalog/movies?profileId=${kidsProfile.body.data.id}`, { token: userLogin.accessToken });
  assert.equal(kidsList.status, 200, JSON.stringify(kidsList.body));
  assert.ok(kidsList.body.data.items.some((item) => item.id === ownedMovieId));
  assert.ok(!kidsList.body.data.items.some((item) => item.id === importedFilm.rows[0].id), 'kids profile excludes unclassified film');
  assert.equal(kidsList.headers.get('cache-control'), 'no-store', 'personalized response cannot use public cache');
  const otherUser = await request(gatewayUrl, '/auth/register', { method: 'POST', body: { email: `g3-other-${randomUUID()}@example.test`, password, fullName: 'Other owner' } });
  assert.equal(otherUser.status, 201);
  const otherLogin = await login(gatewayUrl, otherUser.body.data.email, password, `g3-other-${randomUUID()}`);
  const wrongOwner = await request(gatewayUrl, `/catalog/movies?profileId=${kidsProfile.body.data.id}`, { token: otherLogin.accessToken });
  assert.equal(wrongOwner.status, 404, 'profile ownership is checked by Profile service');
  const detail = await request(gatewayUrl, `/catalog/movies/${ownedMovieId}`);
  assert.equal(detail.status, 200);
  assert.equal(JSON.stringify(detail.body).includes('fixture.invalid/hls'), false);
  assert.equal(JSON.stringify(detail.body).includes('externalEpisodeKey'), false);
  console.log('PASS G3 public API: internal catalog pagination, profile ownership/kids filtering, non-mixed cache, no selector/stream URL leakage');

  const sourceItemId = seriesItems.rows.find((row) => row.episode_number === 1 && row.server_key === 'server-a').id;
  const originalPlayable = seriesItems.rows.find((row) => row.id === sourceItemId).playable_id;
  const mappingEdit = await request(gatewayUrl, `/admin/source-items/${sourceItemId}`, { method: 'PATCH', token: admin.accessToken, body: { externalEpisodeSlug: 'tap-1-a-corrected' } });
  assert.equal(mappingEdit.status, 200, JSON.stringify(mappingEdit.body));
  assert.equal(mappingEdit.body.data.playableId, originalPlayable);
  const audit = await pool.query(`SELECT count(*)::int AS total FROM catalog_audit_logs WHERE source_item_id=$1`, [sourceItemId]);
  assert.equal(Number(audit.rows[0].total), 1, 'mapping changes are auditable');
  const crossMovie = await request(gatewayUrl, `/admin/content-sources/${seriesMovie.rows[0].source_id}/items`, { method: 'POST', token: admin.accessToken, body: { playableId: filmItems.rows[0].playable_id, serverKey: 'wrong-movie', serverLabel: 'Invalid', externalEpisodeKey: 'bad', playbackMode: 'external_hls' } });
  assert.equal(crossMovie.status, 409, 'service validates both sides belong to the same movie');
  console.log('PASS G3 constraints/audit: composite same-movie mapping, stable playable ID, mapping audit record');

  const sourceId = String(seriesMovie.rows[0].source_id);
  const editorialEdit = await request(gatewayUrl, `/admin/movies/${ownedMovieId}`, { method: 'PATCH', token: admin.accessToken, body: { title: 'Editorial override' } });
  assert.equal(editorialEdit.status, 200, JSON.stringify(editorialEdit.body));
  const lock = await request(gatewayUrl, `/admin/content-sources/${sourceId}/metadata-lock`, { method: 'PATCH', token: admin.accessToken, body: { locked: true } });
  assert.equal(lock.status, 200);
  const stableId = seriesMovie.rows[0].id;
  const stablePlayableId = originalPlayable;
  series = { ...series, movie: { ...series.movie, slug: seriesRenamedSlug, name: 'Title changed at provider', content: '<p>Changed text</p>' }, episodes: series.episodes.map((server) => ({ ...server, server_data: server.server_data.map((episode) => ({ ...episode, link_m3u8: episode.name === 'Tập 1' ? undefined : episode.link_m3u8 })) })) };
  const refresh = await request(gatewayUrl, '/admin/providers/kkphim/sync', { method: 'POST', token: admin.accessToken, body: { mode: 'refresh' } });
  assert.equal(refresh.status, 202);
  const refreshRun = await pollRun(gatewayUrl, refresh.body.data.syncRunId, admin.accessToken);
  assert.equal(refreshRun.status, 'completed', JSON.stringify(refreshRun));
  const refreshed = await pool.query(`SELECT m.id,m.title,m.status,cs.external_slug FROM movies m JOIN content_sources cs ON cs.movie_id=m.id WHERE cs.provider='kkphim' AND cs.external_id=$1`, [fixtureSeriesId]);
  assert.equal(refreshed.rows[0].id, stableId, 'provider slug rename preserves the MovieApp UUID');
  assert.equal(refreshed.rows[0].title, 'Editorial override', 'metadata lock preserves editorial title');
  assert.equal(refreshed.rows[0].external_slug, seriesRenamedSlug);
  assert.equal(refreshed.rows[0].status, 'published');
  const refreshedEp = await pool.query(`SELECT si.playable_id,si.source_status FROM source_items si WHERE si.id=$1`, [sourceItemId]);
  assert.equal(refreshedEp.rows[0].playable_id, stablePlayableId);
  assert.equal(refreshedEp.rows[0].source_status, 'unknown', 'metadata lock still refreshes availability');
  const publishedEvents = await pool.query(`SELECT count(*)::int AS total FROM outbox_events WHERE aggregate_id=$1 AND event_type='movie.published'`, [stableId]);
  assert.equal(Number(publishedEvents.rows[0].total), 1, 'repeated import does not re-emit movie.published');
  await waitForPublishedEvent(pool, stableId, 'movie.published');
  const archive = await request(gatewayUrl, `/admin/movies/${stableId}/archive`, { method: 'POST', token: admin.accessToken });
  assert.equal(archive.status, 200);
  const refreshAgain = await request(gatewayUrl, '/admin/providers/kkphim/sync', { method: 'POST', token: admin.accessToken, body: { mode: 'refresh' } });
  assert.equal(refreshAgain.status, 202);
  const afterArchiveRun = await pollRun(gatewayUrl, refreshAgain.body.data.syncRunId, admin.accessToken);
  assert.equal(afterArchiveRun.status, 'completed');
  const archivedState = await pool.query(`SELECT status FROM movies WHERE id=$1`, [stableId]);
  assert.equal(archivedState.rows[0].status, 'archived', 'refresh cannot unarchive a manually archived movie');
  console.log('PASS G3 sync: lease/checkpoint job, metadata lock, source availability refresh, slug stability, no publish spam, archive persistence');

  const beforeReclaim = await pool.query(`SELECT attempts FROM sync_runs WHERE id=$1`, [seriesRun.id]);
  await pool.query(`UPDATE sync_runs SET status='running',lease_until=now()-interval '1 second',finished_at=NULL WHERE id=$1`, [seriesRun.id]);
  let reclaimed = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = await pool.query(`SELECT status,attempts,lease_until FROM sync_runs WHERE id=$1`, [seriesRun.id]);
    reclaimed = result.rows[0];
    if (reclaimed.status === 'completed' && Number(reclaimed.attempts) > Number(beforeReclaim.rows[0].attempts)) break;
    await delay(100);
  }
  assert.equal(reclaimed.status, 'completed', 'worker recovers a run with an expired lease');
  assert.equal(Number(reclaimed.attempts), Number(beforeReclaim.rows[0].attempts) + 1, 'expired lease recovery increments the attempt counter');
  console.log('PASS G3 recovery: expired running lease is reclaimed and the durable job completes again');

  const secrets = await pool.query(`
    SELECT m.description AS value FROM movies m WHERE m.id=ANY($1::uuid[])
    UNION ALL SELECT cs.external_slug FROM content_sources cs WHERE cs.movie_id=ANY($1::uuid[])
    UNION ALL SELECT si.external_episode_key FROM source_items si WHERE si.movie_id=ANY($1::uuid[])
    UNION ALL SELECT envelope::text FROM outbox_events WHERE aggregate_id=ANY($1::uuid[])
    UNION ALL SELECT checkpoint::text FROM sync_runs
  `, [testMovieIds]);
  const serializedStored = JSON.stringify(secrets.rows);
  assert.equal(serializedStored.includes('media.fixture.invalid'), false);
  assert.equal(serializedStored.includes('player.fixture.invalid'), false);
  const completedJob = await pool.query(`SELECT status,lease_until,checkpoint,attempts FROM sync_runs WHERE id=$1`, [seriesRun.id]);
  assert.equal(completedJob.rows[0].status, 'completed');
  assert.equal(completedJob.rows[0].lease_until, null);
  assert.equal(completedJob.rows[0].checkpoint.completed, true);
  assert.ok(reclaimed.lease_until === null || reclaimed.lease_until === undefined);
  const acknowledged = await pool.query(`SELECT count(*)::int AS total FROM outbox_events WHERE aggregate_id=$1 AND event_type='movie.published' AND published_at IS NOT NULL`, [stableId]);
  assert.equal(Number(acknowledged.rows[0].total), 1, 'Catalog outbox is marked published after a real Kafka producer ACK');
  console.log('PASS G3 persistence: no playback URLs in Catalog storage, checkpoint durable, and outbox acknowledged by Kafka');
} catch (error) {
  console.error(error);
  for (const child of [catalogProcess, gatewayProcess, profileProcess, authProcess]) if (child && child.exitCode === null) console.error(`${child.serviceName} output:\n${child.output()}`);
  process.exitCode = 1;
} finally {
  if (testMovieIds.length) {
    await pool.query(`DELETE FROM outbox_events WHERE aggregate_id=ANY($1::uuid[])`, [testMovieIds]).catch(() => undefined);
    await pool.query(`DELETE FROM movies WHERE id=ANY($1::uuid[])`, [testMovieIds]).catch(() => undefined);
    await pool.query(`DELETE FROM genres WHERE NOT EXISTS(SELECT 1 FROM movie_genres WHERE movie_genres.genre_id=genres.id)`).catch(() => undefined);
    await pool.query(`DELETE FROM countries WHERE NOT EXISTS(SELECT 1 FROM movie_countries WHERE movie_countries.country_id=countries.id)`).catch(() => undefined);
  }
  await pool.end();
  for (const child of [catalogProcess, gatewayProcess, profileProcess, authProcess]) await stop(child).catch((error) => { console.error(error); process.exitCode = 1; });
  await new Promise((resolveClose) => provider.close(resolveClose));
  await rm(tempDir, { recursive: true, force: true });
}

if (process.exitCode) process.exit(process.exitCode);
console.log('G3 Catalog E2E passed: Gateway/Auth/Profile/PostgreSQL/KKPhim fixture and async import/sync behavior.');
