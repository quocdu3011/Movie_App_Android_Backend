import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const services = [
  { name: 'api-gateway', output: 'apps/api-gateway/main.js', portVariable: 'GATEWAY_PORT' },
  { name: 'notification-service', output: 'apps/notification-service/main.js', portVariable: 'NOTIFICATION_PORT' },
  { name: 'recommendation-service', output: 'apps/recommendation-service/main.js', portVariable: 'RECOMMENDATION_PORT' },
];

async function unusedPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const { port } = server.address();
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function waitForExit(child, timeout = 3000) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    delay(timeout).then(() => { throw new Error('Service process did not stop after SIGTERM'); }),
  ]);
}

for (const service of services) {
  const port = await unusedPort();
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    [service.portVariable]: String(port),
  };
  if (service.name === 'api-gateway') {
    Object.assign(env, {
      AUTH_SERVICE_URL: 'http://127.0.0.1:1',
      GATEWAY_SERVICE_TOKEN: 'g0-smoke-only-token-value-that-is-long-enough',
      AUTH_JWT_ISSUER: 'https://auth.example.test',
      AUTH_JWT_AUDIENCE: 'movieapp-api',
    });
  }
  const child = spawn(process.execPath, [resolve(root, 'dist', service.output)], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });

  try {
    let response;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`${service.name} exited during startup: ${output}`);
      try {
        response = await fetch(`http://127.0.0.1:${port}/health`, {
          headers: { 'x-request-id': `g0-${service.name}` },
          signal: AbortSignal.timeout(300),
        });
        break;
      } catch {
        await delay(100);
      }
    }
    assert.ok(response, `${service.name} did not start: ${output}`);
    assert.equal(response.status, 200, `${service.name} /health must return HTTP 200`);
    assert.equal(response.headers.get('x-request-id'), `g0-${service.name}`);
    const health = await response.json();
    assert.deepEqual(health, {
      success: true,
      data: { status: 'ok', service: service.name },
      error: null,
      requestId: `g0-${service.name}`,
    });

    const readyResponse = await fetch(`http://127.0.0.1:${port}/ready`, {
      headers: { 'x-request-id': `ready-${service.name}` },
      signal: AbortSignal.timeout(2000),
    });
    if (service.name === 'api-gateway') {
      assert.equal(readyResponse.status, 503, 'Gateway readiness must fail when Auth is unavailable');
      const body = await readyResponse.json();
      assert.equal(body.success, false);
      assert.equal(body.error.code, 'INTERNAL_ERROR');
      assert.equal(body.requestId, `ready-${service.name}`);
    } else {
      assert.equal(readyResponse.status, 200);
      const body = await readyResponse.json();
      assert.equal(body.data.status, 'ready');
      assert.equal(body.data.businessImplemented, false);
    }

    const unknownResponse = await fetch(`http://127.0.0.1:${port}/not-implemented`, {
      headers: { 'x-request-id': `404-${service.name}` },
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(unknownResponse.status, 404);
    const unknownBody = await unknownResponse.json();
    assert.equal(unknownBody.success, false);
    assert.equal(unknownBody.data, null);
    assert.equal(unknownBody.error.code, 'HTTP_404');
    assert.equal(unknownBody.requestId, `404-${service.name}`);
    console.log(`PASS ${service.name}: startup, health, readiness and error envelope`);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await waitForExit(child);
    }
  }
}

const configFailure = spawn(process.execPath, [resolve(root, 'dist/apps/profile-service/main.js')], {
  cwd: root,
  env: { ...process.env, NODE_ENV: '', PROFILE_PORT: '3002' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let failureOutput = '';
configFailure.stdout.setEncoding('utf8').on('data', (chunk) => { failureOutput += chunk; });
configFailure.stderr.setEncoding('utf8').on('data', (chunk) => { failureOutput += chunk; });
const failureCode = await new Promise((resolveExit) => configFailure.once('exit', resolveExit));
assert.notEqual(failureCode, 0, 'service must refuse startup when NODE_ENV is missing');
assert.match(failureOutput, /NODE_ENV must be explicitly set/);
console.log('PASS profile-service: startup fails on missing required environment');
