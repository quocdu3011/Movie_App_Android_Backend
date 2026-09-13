import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'dotenv';
import pg from 'pg';

const revision = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).trim();
const tag = process.env.IMAGE_TAG?.trim() || `sha-${revision.slice(0, 12)}`;
const example = parse(readFileSync('.env.example'));
let local = {};
try { local = parse(readFileSync('.env')); } catch { /* example is enough for a new local stack */ }
const merged = { ...example, ...local };
const adminUrl = merged.POSTGRES_ADMIN_URL;
if (!adminUrl) throw new Error('POSTGRES_ADMIN_URL is required for migration image smoke');
const variables = ['AUTH_DATABASE_URL', 'PROFILE_DATABASE_URL', 'CATALOG_DATABASE_URL', 'PAYMENT_DATABASE_URL', 'STREAMING_DATABASE_URL', 'WORKER_DATABASE_URL', 'NOTIFICATION_DATABASE_URL', 'RECOMMENDATION_DATABASE_URL'];
const suffix = randomUUID().replaceAll('-', '');
const names = variables.map((_, index) => `g10m${suffix.slice(0, 16)}${index}`);
const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
try {
  for (const name of names) await client.query(`CREATE DATABASE ${name}`);
  for (const [index, variable] of variables.entries()) {
    const url = new URL(adminUrl); url.pathname = `/${names[index]}`; merged[variable] = url.toString();
  }
  const envFile = join(tmpdir(), `movieapp-g10-migrations-${process.pid}.env`);
  writeFileSync(envFile, `${Object.entries(merged).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, { mode: 0o600 });
  try {
    execFileSync('docker', ['run', '--rm', '--network', 'host', '--env-file', envFile, `movieapp/migrations:${tag}`], { stdio: 'inherit' });
  } finally {
    rmSync(envFile, { force: true });
  }
} finally {
  for (const name of names) await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await client.end();
}
process.stdout.write('G10 migration image smoke passed: all eight migrations applied to temporary empty databases and the databases were removed.\n');
