import { spawnSync } from 'node:child_process';

const commands = [
  'migration:run',
  'migration:profile:run',
  'migration:catalog:run',
  'migration:payment:run',
  'migration:streaming:run',
  'migration:worker:run',
  'migration:notification:run',
  'migration:recommendation:run',
];

for (const command of commands) {
  process.stdout.write(`Running ${command}\n`);
  const result = spawnSync('npm', ['run', command], { stdio: 'inherit', env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

process.stdout.write(`Applied migration commands: ${commands.length}\n`);
