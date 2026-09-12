import { createHash, createHmac } from 'node:crypto';

export interface ObjectStorageConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  region: string;
}

export interface StoredObject {
  body: Buffer;
  contentType: string | null;
  contentLength: number;
  metadata: Record<string, string>;
}

function encodePath(key: string): string {
  if (!key || key.startsWith('/') || key.includes('..')) throw new Error('Object key is invalid');
  return `/${key.split('/').map((part) => encodeURIComponent(part)).join('/')}`;
}

function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function hmac(key: Buffer | string, value: string): Buffer { return createHmac('sha256', key).update(value).digest(); }
function utcStamp(date: Date): { date: string; timestamp: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { date: iso.slice(0, 8), timestamp: iso.slice(0, 15) + 'Z' };
}
function canonicalQuery(entries: Array<[string, string]>): string {
  return entries.sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
}

/** Small AWS Signature V4 client used with the private MinIO buckets in development. */
export class S3ObjectStorage {
  private readonly endpoint: URL;

  constructor(private readonly config: ObjectStorageConfig) {
    this.endpoint = new URL(config.endpoint);
    if (!['http:', 'https:'].includes(this.endpoint.protocol) || this.endpoint.username || this.endpoint.password || this.endpoint.pathname !== '/') {
      throw new Error('Object storage endpoint must be an HTTP(S) origin without credentials or path');
    }
    if (config.accessKey.length < 3 || config.secretKey.length < 8) throw new Error('Object storage credentials are invalid');
  }

  async presignPut(bucket: string, key: string, expiresSeconds: number, metadata: Record<string, string>): Promise<{ url: string; requiredHeaders: Record<string, string> }> {
    if (!Number.isSafeInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > 900) throw new Error('Presigned upload expiry must be 1..900 seconds');
    const date = new Date();
    const { date: dateScope, timestamp } = utcStamp(date);
    const host = this.endpoint.host;
    const headers = Object.fromEntries(Object.entries(metadata).map(([name, value]) => [`x-amz-meta-${name.toLowerCase()}`, value]));
    const signedHeaderNames = ['host', ...Object.keys(headers).sort()].join(';');
    const credentialScope = `${dateScope}/${this.config.region}/s3/aws4_request`;
    const query = canonicalQuery([
      ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'], ['X-Amz-Credential', `${this.config.accessKey}/${credentialScope}`],
      ['X-Amz-Date', timestamp], ['X-Amz-Expires', String(expiresSeconds)], ['X-Amz-SignedHeaders', signedHeaderNames],
    ]);
    const canonicalHeaders = `host:${host}\n${Object.keys(headers).sort().map((name) => `${name}:${headers[name]}\n`).join('')}`;
    const canonicalRequest = `PUT\n/${encodeURIComponent(bucket)}${encodePath(key)}\n${query}\n${canonicalHeaders}\n${signedHeaderNames}\nUNSIGNED-PAYLOAD`;
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.config.secretKey}`, dateScope), this.config.region), 's3'), 'aws4_request');
    const signature = hmac(signingKey, `AWS4-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${sha256(canonicalRequest)}`).toString('hex');
    const url = new URL(`/${encodeURIComponent(bucket)}${encodePath(key)}?${query}&X-Amz-Signature=${signature}`, this.endpoint);
    return { url: url.toString(), requiredHeaders: headers };
  }

  async head(bucket: string, key: string): Promise<{ contentLength: number; contentType: string | null; metadata: Record<string, string> } | null> {
    const response = await this.request('HEAD', bucket, key);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Object storage HEAD failed: ${response.status}`);
    return { contentLength: Number(response.headers.get('content-length') ?? 0), contentType: response.headers.get('content-type'), metadata: this.metadata(response.headers) };
  }

  async get(bucket: string, key: string): Promise<StoredObject | null> {
    const response = await this.request('GET', bucket, key);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Object storage GET failed: ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    return { body, contentType: response.headers.get('content-type'), contentLength: body.length, metadata: this.metadata(response.headers) };
  }

  async put(bucket: string, key: string, body: Buffer, contentType: string): Promise<void> {
    const response = await this.request('PUT', bucket, key, body, { 'content-type': contentType });
    if (!response.ok) throw new Error(`Object storage PUT failed: ${response.status}`);
  }

  async ensureBucket(bucket: string): Promise<void> {
    if (!/^[a-z0-9][a-z0-9.-]{2,62}$/.test(bucket)) throw new Error('Bucket name is invalid');
    const response = await this.requestBucket('PUT', bucket);
    if (!response.ok && response.status !== 409) throw new Error(`Object storage bucket setup failed: ${response.status}`);
  }

  private metadata(headers: Headers): Record<string, string> {
    const result: Record<string, string> = {};
    headers.forEach((value, name) => { if (name.startsWith('x-amz-meta-')) result[name.slice('x-amz-meta-'.length)] = value; });
    return result;
  }

  private async request(method: 'GET' | 'HEAD' | 'PUT', bucket: string, key: string, body?: Buffer, additionalHeaders: Record<string, string> = {}): Promise<Response> {
    const now = new Date();
    const { date, timestamp } = utcStamp(now);
    const payloadHash = sha256(body ?? '');
    const canonicalUri = `/${encodeURIComponent(bucket)}${encodePath(key)}`;
    const headers: Record<string, string> = { host: this.endpoint.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': timestamp, ...additionalHeaders };
    const ordered = Object.keys(headers).sort();
    const canonicalHeaders = ordered.map((name) => `${name}:${headers[name].trim()}\n`).join('');
    const signedHeaders = ordered.join(';');
    const scope = `${date}/${this.config.region}/s3/aws4_request`;
    const canonicalRequest = `${method}\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.config.secretKey}`, date), this.config.region), 's3'), 'aws4_request');
    const signature = hmac(signingKey, `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonicalRequest)}`).toString('hex');
    const url = new URL(canonicalUri, this.endpoint);
    return fetch(url, { method, headers: { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${this.config.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` }, ...(body ? { body } : {}) });
  }

  private async requestBucket(method: 'PUT', bucket: string): Promise<Response> {
    const now = new Date(); const { date, timestamp } = utcStamp(now); const payloadHash = sha256('');
    const canonicalUri = `/${encodeURIComponent(bucket)}`; const headers = { host: this.endpoint.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': timestamp };
    const ordered = Object.keys(headers).sort(); const canonicalHeaders = ordered.map((name) => `${name}:${headers[name as keyof typeof headers]}\n`).join(''); const signedHeaders = ordered.join(';');
    const scope = `${date}/${this.config.region}/s3/aws4_request`; const canonicalRequest = `${method}\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.config.secretKey}`, date), this.config.region), 's3'), 'aws4_request'); const signature = hmac(signingKey, `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonicalRequest)}`).toString('hex');
    return fetch(new URL(canonicalUri, this.endpoint), { method, headers: { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${this.config.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` } });
  }
}
