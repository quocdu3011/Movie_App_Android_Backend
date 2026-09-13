import { execFileSync } from 'node:child_process';

const revision = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).trim();
const tag = process.env.IMAGE_TAG?.trim() || `sha-${revision.slice(0, 12)}`;
if (!/^sha-[0-9a-f]{7,64}$/.test(tag)) throw new Error('IMAGE_TAG must be a sha-<git-sha> tag');

const services = ['api-gateway', 'auth-service', 'profile-service', 'catalog-service', 'payment-service', 'streaming-service', 'notification-service', 'recommendation-service', 'media-edge'];
function build(name, target, service = name) {
  const image = `movieapp/${name}:${tag}`;
  execFileSync('docker', [
    'build', '--target', target,
    '--build-arg', `MOVIEAPP_SERVICE=${service}`,
    '--build-arg', `VCS_REF=${revision}`,
    '--tag', image,
    '--file', 'docker/backend/Dockerfile', '.',
  ], { stdio: 'inherit' });
  process.stdout.write(`Built ${image}\n`);
}

for (const service of services) build(service, 'app-runtime');
build('transcode-worker', 'worker-runtime');
build('migrations', 'migrations', 'migrations');
