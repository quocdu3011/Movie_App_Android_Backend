import 'dotenv/config';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { S3ObjectStorage } from '@movie/object-storage';

const adminUrl = new URL(process.env.POSTGRES_ADMIN_URL ?? '');
if (!adminUrl.username || !adminUrl.password) throw new Error('POSTGRES_ADMIN_URL must include the local admin credentials');
const database = 'auth_db';
const restored = `g10_restore_${randomUUID().replaceAll('-', '')}`;
const compose = ['compose', '--env-file', '.env'];
function docker(args, options = {}) {
  return execFileSync('docker', [...compose, ...args], { maxBuffer: 64 * 1024 * 1024, ...options });
}
function psql(db, statement) {
  return docker(['exec', '-T', '-e', `PGPASSWORD=${decodeURIComponent(adminUrl.password)}`, 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', decodeURIComponent(adminUrl.username), '-d', db, '-Atc', statement], { encoding: 'utf8' }).trim();
}
let dump;
try {
  dump = docker(['exec', '-T', '-e', `PGPASSWORD=${decodeURIComponent(adminUrl.password)}`, 'postgres', 'pg_dump', '-Fc', '-U', decodeURIComponent(adminUrl.username), '-d', database]);
  psql('postgres', `CREATE DATABASE ${restored}`);
  const restore = spawnSync('docker', [...compose, 'exec', '-T', '-e', `PGPASSWORD=${decodeURIComponent(adminUrl.password)}`, 'postgres', 'pg_restore', '-U', decodeURIComponent(adminUrl.username), '-d', restored, '--no-owner', '--no-privileges'], { input: dump, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(restore.status, 0, 'pg_restore must succeed');
  assert.ok(Number(psql(restored, "SELECT count(*) FROM typeorm_migrations")) >= 1, 'restored Auth database must contain applied migrations');
} finally {
  try { psql('postgres', `DROP DATABASE IF EXISTS ${restored} WITH (FORCE)`); } catch { /* preserve primary failure */ }
}

const storage = new S3ObjectStorage({
  endpoint: process.env.MINIO_ENDPOINT ?? 'http://127.0.0.1:9000',
  accessKey: process.env.MINIO_ROOT_USER ?? 'movieapp_minio',
  secretKey: process.env.MINIO_ROOT_PASSWORD ?? 'movieapp_minio_dev_only',
  region: 'us-east-1',
});
const bucket = process.env.MINIO_BUCKET_UPLOADS ?? 'movieapp-uploads';
const key = `g10/rehearsal/${randomUUID()}.bin`;
const original = Buffer.from(`restore-rehearsal:${randomUUID()}`);
await storage.ensureBucket(bucket);
try {
  await storage.put(bucket, key, original, 'application/octet-stream');
  const backup = await storage.get(bucket, key);
  assert.deepEqual(backup?.body, original, 'object backup must equal uploaded object');
  await storage.remove(bucket, key);
  assert.equal(await storage.head(bucket, key), null, 'object must be absent before restore');
  await storage.put(bucket, key, backup.body, backup.contentType ?? 'application/octet-stream');
  assert.deepEqual((await storage.get(bucket, key))?.body, original, 'restored object must equal backup');
} finally {
  await storage.remove(bucket, key);
}
process.stdout.write('G10 restore rehearsal passed: custom PostgreSQL Auth backup restored and MinIO probe object restored byte-for-byte.\n');
