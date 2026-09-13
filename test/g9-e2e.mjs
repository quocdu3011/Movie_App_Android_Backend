import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kafka } from 'kafkajs';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const timeoutMs = 180_000;
const scenarios = [
  ['contract', 'test/g9-contract.mjs', {}],
  ['profile-quota-and-ownership', 'test/profile-e2e.mjs', {}],
  ['kkphim-import-series-and-metadata-lock', 'test/catalog-e2e.mjs', {}],
  ['payment-webhook-and-entitlement', 'test/payment-e2e.mjs', {}],
  ['third-party-hls-progress-and-recovery', 'test/streaming-e2e.mjs', { G9_LOAD: 'true' }],
  ['owned-upload-transcode-and-hls', 'test/owned-media-e2e.mjs', {}],
  ['search-home-history-and-catalog-load', 'test/g7-e2e.mjs', { G9_LOAD: 'true' }],
  ['notification-recommendation-and-telemetry', 'test/g8-e2e.mjs', {}],
];

function run(name, path, extraEnv) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [resolve(root, path)], { cwd: root, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let timedOut = false;
    const started = performance.now();
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5_000).unref(); }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; process.stdout.write(chunk); });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; process.stderr.write(chunk); });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      const durationMs = performance.now() - started;
      if (code === 0 && !timedOut) { console.log(`G9_SCENARIO name=${name} status=passed duration_ms=${durationMs.toFixed(0)}`); resolveRun({ name, durationMs, output }); return; }
      rejectRun(new Error(`G9 scenario ${name} failed (code=${code}, signal=${signal}, timedOut=${timedOut})\n${output.slice(-8_000)}`));
    });
  });
}

async function outboxLag() {
  const urls = ['PROFILE_DATABASE_URL', 'CATALOG_DATABASE_URL', 'PAYMENT_DATABASE_URL', 'STREAMING_DATABASE_URL'].map((key) => process.env[key]).filter(Boolean);
  const pools = urls.map((connectionString) => new pg.Pool({ connectionString }));
  try {
    return await Promise.all(pools.map(async (pool) => Number((await pool.query(`SELECT count(*)::int AS count FROM outbox_events WHERE published_at IS NULL`)).rows[0].count)));
  } finally { await Promise.all(pools.map((pool) => pool.end())); }
}

async function kafkaLag() {
  const brokers = process.env.KAFKA_BROKERS?.split(',').filter(Boolean) ?? [];
  if (!brokers.length) return [];
  const admin = new Kafka({ clientId: 'g9-lag-report', brokers, connectionTimeout: 3_000, requestTimeout: 5_000, retry: { retries: 3, initialRetryTime: 300 } }).admin();
  const groups = [
    ['catalog-search-v1', ['movie.published', 'movie.updated', 'movie.archived', 'movie.source.updated']],
    ['recommendation-v1', ['playback.qualified', 'profile.deleted']],
    ['notification-v1', ['movie.published', 'payment.success', 'subscription.expiring', 'video.transcode_failed']],
  ];
  try {
    await admin.connect();
    return await Promise.all(groups.map(async ([groupId, topics]) => {
      let offsets;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try { offsets = await admin.fetchOffsets({ groupId, topics }); break; }
        catch (error) { if (attempt === 4) throw error; await new Promise((resolveDelay) => setTimeout(resolveDelay, 500)); }
      }
      assert.ok(offsets, `Kafka offsets unavailable for ${groupId}`);
      let lag = 0;
      for (const topic of offsets) {
        const ends = await admin.fetchTopicOffsets(topic.topic);
        for (const partition of topic.partitions) {
          const end = Number(ends.find((item) => item.partition === partition.partition)?.offset ?? 0);
          const offset = Number(partition.offset);
          // These consumers use fromBeginning:false. Kafka reports -1 for a
          // partition that has never received a record after its group joined;
          // that means "start at latest", not historical consumer backlog.
          if (Number.isFinite(offset) && offset >= 0) lag += Math.max(0, end - offset);
        }
      }
      return { groupId, lag };
    }));
  } finally { await admin.disconnect().catch(() => undefined); }
}

console.log(`G9_HOST node=${process.version} platform=${process.platform}/${process.arch} cpus=${os.cpus().length} memory_mib=${Math.round(os.totalmem() / 1024 / 1024)}`);
const results = [];
for (const [name, path, env] of scenarios) results.push(await run(name, path, env));
const pendingOutbox = await outboxLag();
assert.deepEqual(pendingOutbox, [0, 0, 0, 0], `outbox lag remains after G9 scenarios: ${pendingOutbox.join(',')}`);
const lag = await kafkaLag();
assert.equal(lag.every((item) => item.lag === 0), true, `Kafka consumer lag remains after G9 scenarios: ${JSON.stringify(lag)}`);
console.log(`G9_REPORT scenarios=${results.length} total_duration_ms=${results.reduce((sum, item) => sum + item.durationMs, 0).toFixed(0)} outbox_pending=${pendingOutbox.join(',')} kafka_lag=${lag.map((item) => `${item.groupId}:${item.lag}`).join(',')}`);
console.log('G9 system acceptance passed.');
