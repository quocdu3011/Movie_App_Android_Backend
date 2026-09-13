import 'dotenv/config';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';

const revision = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).trim();
const tag = process.env.IMAGE_TAG?.trim() || `sha-${revision.slice(0, 12)}`;
const images = ['api-gateway', 'auth-service', 'profile-service', 'catalog-service', 'payment-service', 'streaming-service', 'transcode-worker', 'notification-service', 'recommendation-service', 'media-edge'];
for (const service of images) {
  const image = `movieapp/${service}:${tag}`;
  const config = JSON.parse(execFileSync('docker', ['image', 'inspect', image, '--format', '{{json .Config}}'], { encoding: 'utf8' }));
  assert.equal(config.User, 'node', `${service} image must use the node user`);
  assert.deepEqual(config.Entrypoint, ['/usr/local/bin/movieapp-entrypoint'], `${service} image must use the service entrypoint`);
}
execFileSync('docker', ['run', '--rm', '--entrypoint', 'ffmpeg', `movieapp/transcode-worker:${tag}`, '-version'], { stdio: 'ignore' });

const secretDir = resolve('..', '.secrets');
const privateKey = resolve(secretDir, 'auth-private.pem');
const publicKey = resolve(secretDir, 'auth-public.pem');
assert.ok(existsSync(privateKey) && existsSync(publicKey), 'local Auth key pair is required for the image smoke');
const names = [`movieapp-g10-auth-${process.pid}`, `movieapp-g10-edge-${process.pid}`];
function runDetached(name, image, args) {
  execFileSync('docker', ['run', '--detach', '--rm', '--name', name, '--network', 'host', '--env-file', '.env', ...args, image], { stdio: 'ignore' });
}
async function waitHealth(url, name) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch { /* wait for process */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8' }).stdout.slice(-2000);
  throw new Error(`${name} did not become healthy: ${logs}`);
}
try {
  runDetached(names[0], `movieapp/auth-service:${tag}`, [
    '--env', 'AUTH_PORT=13001', '--env', 'AUTH_PRIVATE_KEY_PATH=/run/secrets/auth-private.pem', '--env', 'AUTH_PUBLIC_KEY_PATH=/run/secrets/auth-public.pem',
    '--volume', `${secretDir}:/run/secrets:ro`,
  ]);
  await waitHealth('http://127.0.0.1:13001/health', names[0]);
  runDetached(names[1], `movieapp/media-edge:${tag}`, [
    '--env', 'MEDIA_EDGE_PORT=18081',
    '--env', `MINIO_ENDPOINT=${process.env.MINIO_ENDPOINT ?? 'http://127.0.0.1:9000'}`,
    '--env', `MINIO_ROOT_USER=${process.env.MINIO_ROOT_USER ?? 'movieapp_minio'}`,
    '--env', `MINIO_ROOT_PASSWORD=${process.env.MINIO_ROOT_PASSWORD ?? 'movieapp_minio_dev_only'}`,
    '--env', `MEDIA_AUTH_SECRET=${process.env.MEDIA_AUTH_SECRET ?? 'local-g10-media-edge-secret-with-32-characters'}`,
  ]);
  await waitHealth('http://127.0.0.1:18081/health', names[1]);
} finally {
  for (const name of names) spawnSync('docker', ['rm', '--force', name], { stdio: 'ignore' });
}
writeSync(1, `G10 image smoke passed for ${images.length} non-root images; Auth and media-edge ran their real health endpoints.\n`);
process.exit(0);
