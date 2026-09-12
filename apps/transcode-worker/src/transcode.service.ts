import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { Consumer, Kafka } from 'kafkajs';
import { EventEnvelope } from '@movie/shared-kafka';
import { S3ObjectStorage } from '@movie/object-storage';
import { WORKER_CONFIG, WorkerConfig } from './worker.config';

interface Job { asset_id: string; generation: number; source_item_id: string; raw_object_key: string; expected_checksum: string; state: string; attempt: number; attempt_token: string; }
function rows<T>(value: unknown): T[] { return Array.isArray(value) && value.length === 2 && Array.isArray(value[0]) ? value[0] as T[] : Array.isArray(value) ? value as T[] : []; }
function hash(buffer: Buffer): string { return createHash('sha256').update(buffer).digest('hex'); }

@Injectable()
export class TranscodeService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TranscodeService.name);
  private readonly storage: S3ObjectStorage;
  private readonly consumer: Consumer;
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopping = false;

  constructor(@InjectDataSource() private readonly database: DataSource, @Inject(WORKER_CONFIG) private readonly config: WorkerConfig) {
    this.storage = new S3ObjectStorage({ endpoint: config.objectStorageEndpoint, accessKey: config.objectStorageAccessKey, secretKey: config.objectStorageSecretKey, region: 'us-east-1' });
    this.consumer = new Kafka({ clientId: 'transcode-worker', brokers: config.kafkaBrokers, connectionTimeout: 1_500, requestTimeout: 3_000, retry: { retries: 0 } }).consumer({ groupId: 'transcode-worker-v1', allowAutoTopicCreation: false });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: 'video.uploaded', fromBeginning: false });
    await this.consumer.run({ eachMessage: async ({ message }) => this.persistUploaded(message.value?.toString() ?? '') });
    this.timer = setInterval(() => void this.poll(), this.config.pollMs); this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true; if (this.timer) clearInterval(this.timer); await this.consumer.disconnect().catch(() => undefined);
  }

  async pingDatabase(): Promise<void> { await this.database.query('SELECT 1'); }

  private async persistUploaded(raw: string): Promise<void> {
    let envelope: EventEnvelope<{ assetId: string; generation: number; sourceItemId: string; rawObjectKey: string; checksum: string }>;
    try { envelope = JSON.parse(raw) as typeof envelope; } catch { this.logger.warn('Ignoring malformed video.uploaded event'); return; }
    const payload = envelope.payload;
    if (envelope.eventType !== 'video.uploaded' || !payload || !/^[0-9a-f-]{36}$/i.test(payload.assetId) || !Number.isSafeInteger(payload.generation) || !payload.rawObjectKey || !/^[a-f0-9]{64}$/.test(payload.checksum)) {
      this.logger.warn('Ignoring invalid video.uploaded event'); return;
    }
    await this.database.transaction(async (manager) => {
      const inserted = await manager.query(`INSERT INTO worker_inbox(consumer_name,event_id) VALUES('video.uploaded',$1) ON CONFLICT DO NOTHING RETURNING event_id`, [envelope.eventId]);
      if (!rows(inserted).length) return;
      await manager.query(`INSERT INTO transcode_jobs(asset_id,generation,source_item_id,raw_object_key,expected_checksum,state) VALUES($1,$2,$3,$4,$5,'queued') ON CONFLICT(asset_id,generation) DO NOTHING`, [payload.assetId, payload.generation, payload.sourceItemId, payload.rawObjectKey, payload.checksum]);
    });
  }

  private async poll(): Promise<void> {
    if (this.running || this.stopping || !this.database.isInitialized) return;
    this.running = true;
    try {
      const job = await this.claim();
      if (job) await this.runJob(job);
    } catch (error) { this.logger.error(`Transcode worker poll failed: ${error instanceof Error ? error.message : 'unknown error'}`); }
    finally { this.running = false; }
  }

  private async claim(): Promise<Job | null> {
    return this.database.transaction(async (manager) => {
      const candidates = rows<Job>(await manager.query(`SELECT * FROM transcode_jobs WHERE (state IN ('queued','retry_wait') AND available_at<=now()) OR (state='processing' AND lease_until<now()) ORDER BY available_at,created_at LIMIT 1 FOR UPDATE SKIP LOCKED`));
      const job = candidates[0]; if (!job) return null;
      const attempt = Number(job.attempt) + 1; const token = randomUUID();
      const claimed = rows<Job>(await manager.query(`UPDATE transcode_jobs SET state='processing',attempt=$3,attempt_token=$4,lease_until=now()+($5 || ' seconds')::interval,output_prefix=$6,updated_at=now() WHERE asset_id=$1 AND generation=$2 RETURNING *`, [job.asset_id, job.generation, attempt, token, String(this.config.leaseSeconds), `assets/${job.asset_id}/g${job.generation}/a${attempt}`]));
      return claimed[0] ?? null;
    });
  }

  private async runJob(job: Job): Promise<void> {
    await this.callStreaming(`/internal/streaming/assets/${job.asset_id}/processing`, { generation: job.generation, attempt: job.attempt, attemptToken: job.attempt_token });
    let directory: string | undefined;
    try {
      const raw = await this.storage.get(this.config.uploadsBucket, job.raw_object_key);
      if (!raw || hash(raw.body) !== job.expected_checksum) throw new Error('RAW_CHECKSUM_MISMATCH');
      directory = await mkdtemp(join(tmpdir(), `movieapp-transcode-${job.asset_id}-`));
      const inputPath = join(directory, 'input.mp4'); await writeFile(inputPath, raw.body);
      const probe = JSON.parse(await this.command('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', inputPath])) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number }> };
      const video = probe.streams?.find((stream) => stream.codec_type === 'video');
      const duration = Math.max(1, Math.round(Number(probe.format?.duration ?? 0)));
      if (!video?.height || !Number.isFinite(duration)) throw new Error('INVALID_MEDIA_INPUT');
      const heights = [480, 720, 1080].filter((height) => video.height! >= height);
      const targets = heights.length ? heights : [Math.max(2, video.height - (video.height % 2))];
      const variants: Array<{ height: number; width: number; filename: string }> = [];
      for (const height of targets) {
        const filename = `v${height}.m3u8`; const segmentPattern = join(directory, `v${height}_%03d.ts`);
        await this.command('ffmpeg', ['-y', '-i', inputPath, '-map', '0:v:0', '-map', '0:a?', '-vf', `scale=-2:${height}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-keyint_min', '48', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '96k', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', segmentPattern, join(directory, filename)]);
        variants.push({ height, width: Math.max(2, Math.round((video.width ?? height) * height / video.height!) & ~1), filename });
      }
      const master = ['#EXTM3U', '#EXT-X-VERSION:3', ...variants.flatMap((variant) => [`#EXT-X-STREAM-INF:BANDWIDTH=${variant.height * 1800},RESOLUTION=${variant.width}x${variant.height}`, variant.filename]), ''].join('\n');
      await writeFile(join(directory, 'master.m3u8'), master);
      const files = await readdir(directory); const prefix = `assets/${job.asset_id}/g${job.generation}/a${job.attempt}`;
      for (const file of files.filter((name) => name !== 'input.mp4' && name !== 'master.m3u8')) {
        await this.storage.put(this.config.mediaBucket, `${prefix}/${file}`, await readFile(join(directory, file)), file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
      }
      await this.storage.put(this.config.mediaBucket, `${prefix}/master.m3u8`, await readFile(join(directory, 'master.m3u8')), 'application/vnd.apple.mpegurl');
      await this.callStreaming(`/internal/streaming/assets/${job.asset_id}/transcoded`, { generation: job.generation, attempt: job.attempt, attemptToken: job.attempt_token, manifestKey: `${prefix}/master.m3u8`, durationSeconds: duration, resolutions: variants.map((variant) => `${variant.height}p`) });
      await this.database.query(`UPDATE transcode_jobs SET state='succeeded',lease_until=NULL,updated_at=now() WHERE asset_id=$1 AND generation=$2 AND attempt_token=$3`, [job.asset_id, job.generation, job.attempt_token]);
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'TRANSCODE_FAILED';
      const attempt = Number(job.attempt);
      if (attempt < 4) {
        const backoff = Math.min(120_000, this.config.retryBaseMs * 2 ** Math.max(0, attempt - 1));
        await this.database.query(`UPDATE transcode_jobs SET state='retry_wait',lease_until=NULL,available_at=$4,last_error=$5,updated_at=now() WHERE asset_id=$1 AND generation=$2 AND attempt_token=$3`, [job.asset_id, job.generation, job.attempt_token, new Date(Date.now() + backoff), code]);
      } else {
        await this.callStreaming(`/internal/streaming/assets/${job.asset_id}/transcode-failed`, { generation: job.generation, attempt: job.attempt, attemptToken: job.attempt_token, errorCode: code }).catch(() => undefined);
        await this.database.query(`UPDATE transcode_jobs SET state='failed',lease_until=NULL,last_error=$4,updated_at=now() WHERE asset_id=$1 AND generation=$2 AND attempt_token=$3`, [job.asset_id, job.generation, job.attempt_token, code]);
      }
      this.logger.warn(`Transcode ${job.asset_id}/g${job.generation} attempt ${job.attempt} failed: ${code}`);
    } finally { if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined); }
  }

  private async callStreaming(path: string, body: Record<string, unknown>): Promise<void> {
    const response = await fetch(`${this.config.streamingUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${this.config.streamingToken}`, 'x-caller-service': 'transcode-worker', 'content-type': 'application/json', 'x-request-id': randomUUID() }, body: JSON.stringify(body), signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`STREAMING_CALLBACK_${response.status}`);
  }

  private command(binary: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; }); child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${binary.toUpperCase()}_TIMEOUT`)); }, this.config.ffmpegTimeoutMs); timer.unref();
      child.once('error', reject); child.once('exit', (code) => { clearTimeout(timer); if (code === 0) resolve(stdout); else reject(new Error(`${binary.toUpperCase()}_EXIT_${code}:${stderr.slice(-500)}`)); });
    });
  }
}
