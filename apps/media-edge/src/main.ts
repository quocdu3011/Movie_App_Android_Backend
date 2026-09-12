import 'dotenv/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, IncomingMessage } from 'node:http';
import { S3ObjectStorage } from '@movie/object-storage';
import { loadHttpServiceConfig } from '@movie/shared-config';

function required(value: string | undefined, key: string): string { if (!value?.trim()) throw new Error(`${key} is required`); return value.trim(); }
function cookies(request: IncomingMessage): Record<string, string> {
  return Object.fromEntries((request.headers.cookie ?? '').split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf('='); return index < 0 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}
function validCredential(value: string | undefined, secret: string, key: string): boolean {
  if (!value) return false;
  const [payload, signature] = value.split('.'); if (!payload || !signature || value.split('.').length !== 2) return false;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { aid?: string; gen?: number; exp?: number };
    return typeof decoded.aid === 'string' && Number.isSafeInteger(decoded.gen) && Number.isSafeInteger(decoded.exp) && (decoded.exp ?? 0) > Math.floor(Date.now() / 1000) && key.startsWith(`assets/${decoded.aid}/g${decoded.gen}/`);
  } catch { return false; }
}

const http = loadHttpServiceConfig('media-edge', 'MEDIA_EDGE_PORT', 8081);
const secret = required(process.env.MEDIA_AUTH_SECRET, 'MEDIA_AUTH_SECRET');
if (secret.length < 32) throw new Error('MEDIA_AUTH_SECRET must be at least 32 characters');
const storage = new S3ObjectStorage({ endpoint: required(process.env.MINIO_ENDPOINT, 'MINIO_ENDPOINT'), accessKey: required(process.env.MINIO_ROOT_USER, 'MINIO_ROOT_USER'), secretKey: required(process.env.MINIO_ROOT_PASSWORD, 'MINIO_ROOT_PASSWORD'), region: 'us-east-1' });
const bucket = process.env.MINIO_BUCKET_MEDIA?.trim() || 'movieapp-media';

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://media-edge.invalid').pathname;
  if (path === '/health') { response.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n'); return; }
  if (request.method !== 'GET' || !path.startsWith('/media/')) { response.writeHead(404).end(); return; }
  let key: string;
  try { key = decodeURIComponent(path.slice('/media/'.length)); } catch { response.writeHead(400).end(); return; }
  if (!/^(?:assets\/[0-9a-f-]{36}\/g\d+\/a\d+\/)(?:[A-Za-z0-9._-]+\.(?:m3u8|ts))$/i.test(key) || !validCredential(cookies(request).movie_media_auth, secret, key)) { response.writeHead(403, { 'cache-control': 'no-store' }).end(); return; }
  try {
    const object = await storage.get(bucket, key);
    if (!object) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': object.contentType ?? (key.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t'), 'content-length': String(object.body.length), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
    response.end(object.body);
  } catch { response.writeHead(502).end(); }
});
server.listen(http.port, '0.0.0.0');
function shutdown(): void { server.close(() => process.exit(0)); }
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
