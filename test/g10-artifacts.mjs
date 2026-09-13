import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [dockerfile, entrypoint, compose, workflow] = await Promise.all([
  readFile('docker/backend/Dockerfile', 'utf8'),
  readFile('docker/backend/entrypoint.sh', 'utf8'),
  readFile('docker-compose.staging.yml', 'utf8'),
  readFile('.github/workflows/ci.yml', 'utf8'),
]);

assert.match(dockerfile, /FROM dependencies AS builder/);
assert.match(dockerfile, /FROM app-runtime AS worker-runtime/);
assert.match(dockerfile, /apt-get install --yes --no-install-recommends ffmpeg/);
assert.match(dockerfile, /USER node/);
assert.match(entrypoint, /MOVIEAPP_SERVICE must name one supported MovieApp service/);
assert.match(compose, /migrations:[\s\S]*profiles: \[migration\]/);
assert.match(compose, /PAYMENT_MOCK_ENABLED: "false"/);
assert.match(compose, /^\x20{2}auth_private_key:/m);
function serviceBlock(name) {
  const match = compose.match(new RegExp(`^\\x20{2}${name}:\\n([\\s\\S]*?)(?=^\\x20{2}[a-z][a-z-]+:|^networks:|^secrets:|(?![\\s\\S]))`, 'm'));
  assert.ok(match, `${name} must exist in staging compose`);
  return match[0];
}
const authBlock = serviceBlock('auth-service');
assert.match(authBlock, /auth_private_key/);
for (const name of ['streaming-service', 'transcode-worker', 'api-gateway', 'profile-service']) {
  assert.doesNotMatch(serviceBlock(name), /auth_private_key/);
}
assert.match(workflow, /Determine affected workspaces/);
assert.match(workflow, /publish-images/);
assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
process.stdout.write('G10 artifact assertions passed: runtime images, secret isolation, migration gate and trusted CI publish policy.\n');
