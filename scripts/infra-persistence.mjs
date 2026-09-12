import 'dotenv/config';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const mode = process.argv[2];
if (mode !== 'mark' && mode !== 'verify') throw new Error('Usage: node scripts/infra-persistence.mjs <mark|verify>');

function resolveCompose() {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    return ['docker', 'compose'];
  } catch {
    execFileSync('docker-compose', ['version'], { stdio: 'ignore' });
    return ['docker-compose'];
  }
}

const compose = resolveCompose();
function composeExec(service, args) {
  return execFileSync(compose[0], [
    ...compose.slice(1), '--profile', 'core', 'exec', '-T', service, ...args,
  ], { encoding: 'utf8' }).trim();
}

const { Client } = pg;
const client = new Client({ connectionString: process.env.AUTH_DATABASE_URL });
await client.connect();
try {
  await client.query('CREATE TABLE IF NOT EXISTS g0_persistence_check (id TEXT PRIMARY KEY, marker TEXT NOT NULL)');
  if (mode === 'mark') {
    await client.query(
      `INSERT INTO g0_persistence_check (id, marker) VALUES ('restart', 'g0-persistence-ok')
       ON CONFLICT (id) DO UPDATE SET marker = EXCLUDED.marker`,
    );
  } else {
    const result = await client.query("SELECT marker FROM g0_persistence_check WHERE id = 'restart'");
    assert.equal(result.rows[0]?.marker, 'g0-persistence-ok', 'PostgreSQL marker must survive container restart');
  }
} finally {
  await client.end();
}

const redisCommand = mode === 'mark'
  ? 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli SET g0:persistence g0-persistence-ok'
  : 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli GET g0:persistence';
const redisResult = composeExec('redis', ['sh', '-ec', redisCommand]);
assert.equal(redisResult, mode === 'mark' ? 'OK' : 'g0-persistence-ok', 'Redis AOF marker must survive container restart');

const expectedTopics = [
  'movie.published', 'movie.updated', 'movie.archived', 'movie.source.updated',
  'video.uploaded', 'video.processing', 'video.transcoded', 'video.transcode_failed', 'video.ready',
  'payment.success', 'subscription.expiring', 'profile.deleted', 'playback.qualified',
];
const topics = composeExec('kafka', [
  '/opt/kafka/bin/kafka-topics.sh', '--bootstrap-server', 'kafka:9092', '--list',
]).split(/\r?\n/);
for (const topic of expectedTopics) assert.ok(topics.includes(topic), `Kafka topic ${topic} must persist across restart`);

console.log(`PASS infrastructure ${mode}: PostgreSQL data, Redis AOF and ${expectedTopics.length} Kafka topics`);
