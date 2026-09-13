import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

function git(args) { return execFileSync('git', args, { encoding: 'utf8' }).trim(); }
const base = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'HEAD^';
let files;
try { files = git(['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean); } catch { files = git(['show', '--pretty=', '--name-only', 'HEAD']).split('\n').filter(Boolean); }
const rootInputs = ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', '.nvmrc', 'docker/backend/Dockerfile', 'docker-compose.yml', 'docker-compose.staging.yml'];
const apps = [...new Set(files.filter((file) => file.startsWith('apps/')).map((file) => file.split('/')[1]))];
const libs = [...new Set(files.filter((file) => file.startsWith('libs/')).map((file) => file.split('/')[1]))];
const all = files.some((file) => rootInputs.includes(file) || file.startsWith('.github/') || file.startsWith('scripts/')) || libs.length > 0;
const scope = all ? 'workspace' : apps.length ? `apps:${apps.join(',')}` : 'docs-only';
const output = process.env.GITHUB_OUTPUT;
if (output) appendFileSync(output, `scope=${scope}\nrun_backend=${all || apps.length > 0}\n`);
process.stdout.write(`CI affected scope: ${scope}; changed files: ${files.length}\n`);
