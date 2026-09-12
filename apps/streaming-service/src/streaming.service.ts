import {
  HttpException, Injectable, Logger, NotFoundException, UnauthorizedException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { ProviderResponseError, KkphimAdapter } from '@movie/content-provider';
import { EventEnvelope } from '@movie/shared-kafka';
import { PlaybackEventDto, PlaybackProgressDto, CreatePlaybackSessionDto } from './streaming.dto';
import { PlaybackLeaseStore } from './playback-lease.store';
import { SourceCircuit } from './source-circuit';
import { STREAMING_CONFIG, StreamingConfig } from './streaming.config';
import { Inject } from '@nestjs/common';
import { S3ObjectStorage } from '@movie/object-storage';

interface CatalogSelection {
  movieId: string; movieStatus: string; accessTier: 'free' | 'subscription'; isKidsSafe: boolean;
  playableId: string; playableKind: 'movie' | 'episode'; playableLabel: string; durationSeconds: number | null;
  sourceId: string; sourceType: 'owned' | 'third_party'; provider: string | null; externalSlug: string | null;
  sourceItemId: string; serverKey: string; serverLabel: string; externalEpisodeKey: string | null;
  externalEpisodeSlug: string | null; playbackMode: 'owned_hls' | 'external_hls' | 'external_embed' | 'metadata_only';
  sourceStatus: 'unknown' | 'available' | 'unavailable' | 'error'; retryAfter: Date | string | null;
}

interface Entitlement {
  hasSubscription: boolean;
  limits: { maxConcurrentStreams: number; maxResolution: string };
}

interface ProfileValidation { active: boolean; userId: string; profileId: string; isKids: boolean }
interface AuthValidation { active: boolean; userId: string; sessionId: string }
interface PlaybackSessionRow {
  id: string; ordinal: string; user_id: string; auth_session_id: string; profile_id: string; movie_id: string;
  playable_id: string; source_item_id: string; source_type: 'owned' | 'third_party'; state: string;
  last_seq: string; created_at: Date; expires_at: Date; last_seen_at: Date; started_at: Date | null;
  qualified_at: Date | null; closed_at: Date | null;
}
interface VideoAssetRow {
  id: string; source_item_id: string; playable_id: string; movie_id: string; raw_object_key: string | null;
  master_manifest_key: string | null; available_resolutions: string[]; duration_seconds: number | null;
  processing_status: 'upload_pending' | 'queued' | 'processing' | 'ready' | 'failed' | 'expired'; generation: number;
  upload_expires_at: Date | null; expected_size_bytes: string | number | null; expected_checksum: string | null;
  upload_idempotency_key: string | null; processed_attempt: number | null;
}
interface OwnedSourceItem { sourceItemId: string; movieId: string; playableId: string; sourceType: 'owned'; playbackMode: 'owned_hls' }
export interface ProgressRow {
  profileId: string; playableId: string; movieId: string; sourceItemId: string;
  sessionOrdinal: string; seq: string; positionSeconds: number; durationSeconds: number | null; updatedAt: Date;
}

function rows<T>(value: unknown): T[] {
  if (Array.isArray(value) && value.length === 2 && Array.isArray(value[0]) && typeof value[1] === 'number') return value[0] as T[];
  if (Array.isArray(value)) return value as T[];
  return [];
}

function jsonHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function withProviderBudget<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ProviderResponseError('PROVIDER_BUDGET_EXCEEDED')), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

@Injectable()
export class StreamingService {
  private readonly logger = new Logger(StreamingService.name);
  private activeProviderResolves = 0;
  private readonly storage: S3ObjectStorage;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(STREAMING_CONFIG) private readonly config: StreamingConfig,
    private readonly leases: PlaybackLeaseStore,
    private readonly provider: KkphimAdapter,
    private readonly sourceCircuit: SourceCircuit,
  ) {
    this.storage = new S3ObjectStorage({ endpoint: config.objectStorageEndpoint, accessKey: config.objectStorageAccessKey, secretKey: config.objectStorageSecretKey, region: 'us-east-1' });
  }

  async pingDatabase(): Promise<void> { await this.dataSource.query('SELECT 1'); }
  async pingRedis(): Promise<void> { await this.leases.ping(); }

  async createPlaybackSession(
    userId: string,
    authSessionId: string,
    idempotencyKey: string,
    input: CreatePlaybackSessionDto,
    requestId: string,
  ) {
    if (!userId || !authSessionId) throw new UnauthorizedException('Authenticated user session is required');
    if (!/^[A-Za-z0-9._:-]{8,120}$/.test(idempotencyKey)) throw this.domain(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8 to 120 safe characters');
    const inputHash = jsonHash({ movieId: input.movieId, playableId: input.playableId, sourceItemId: input.sourceItemId, profileId: input.profileId });
    const actor = await this.validateActor(userId, authSessionId, input.profileId, requestId);
    const selection = await this.fetchCatalogSelection(input.playableId, input.sourceItemId, requestId);
    this.validateSelection(selection, input, actor.profile);
    const entitlement = await this.fetchEntitlement(userId, requestId);
    this.requireEntitlement(selection, entitlement);
    const progress = await this.readProgressFromDatabase(input.profileId, input.playableId);

    let allocatedSessionId: string | undefined;
    let session: PlaybackSessionRow;
    let idempotentReplay: boolean;
    try {
      const allocation = await this.dataSource.transaction(async (manager) => {
        await manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`${userId}:${idempotencyKey}`]);
        await manager.query(`DELETE FROM playback_requests WHERE user_id=$1 AND idempotency_key=$2 AND expires_at<=now()`, [userId, idempotencyKey]);
        const existing = rows<PlaybackSessionRow & { request_hash: string }>(await manager.query(`
          SELECT r.request_hash,s.* FROM playback_requests r JOIN playback_sessions s ON s.id=r.session_id
          WHERE r.user_id=$1 AND r.idempotency_key=$2
        `, [userId, idempotencyKey]))[0];
        if (existing) {
          if (existing.request_hash !== inputHash) throw this.domain(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used for a different playback request');
          if (existing.state === 'reserved' && new Date(existing.expires_at).getTime() > Date.now()) {
            throw this.domain(409, 'PLAYBACK_SESSION_RESOLVING', 'The idempotent playback request is still resolving; retry with the same key');
          }
          if (!['ready', 'playing'].includes(existing.state) || new Date(existing.expires_at).getTime() <= Date.now()) {
            throw this.domain(409, 'PLAYBACK_SESSION_TERMINAL', 'This idempotency key refers to a closed or expired playback session; use a new key');
          }
          const newExpiry = new Date(Date.now() + this.config.sessionTtlSeconds * 1000);
          const reserved = await this.reserveLease(userId, existing.id, entitlement.limits.maxConcurrentStreams, newExpiry.getTime());
          if (!reserved) throw this.domain(409, 'CONCURRENT_STREAM_LIMIT', 'No playback slots are available');
          const refreshed = rows<PlaybackSessionRow>(await manager.query(`
            UPDATE playback_sessions SET expires_at=$2,last_seen_at=now()
            WHERE id=$1 AND state IN ('ready','playing') AND expires_at>now() RETURNING *
          `, [existing.id, newExpiry]))[0];
          if (!refreshed) {
            await this.leases.release(userId, existing.id).catch(() => undefined);
            throw this.domain(409, 'PLAYBACK_SESSION_TERMINAL', 'Playback session expired; use a new idempotency key');
          }
          return { session: refreshed, replay: true, newSession: false };
        }

        const sessionId = randomUUID();
        const expiresAt = new Date(Date.now() + this.config.sessionTtlSeconds * 1000);
        const reserved = await this.reserveLease(userId, sessionId, entitlement.limits.maxConcurrentStreams, expiresAt.getTime());
        if (!reserved) throw this.domain(409, 'CONCURRENT_STREAM_LIMIT', 'No playback slots are available');
        allocatedSessionId = sessionId;
        const created = rows<PlaybackSessionRow>(await manager.query(`
          INSERT INTO playback_sessions(id,user_id,auth_session_id,profile_id,movie_id,playable_id,source_item_id,source_type,state,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'reserved',$9) RETURNING *
        `, [sessionId, userId, authSessionId, input.profileId, selection.movieId, selection.playableId, selection.sourceItemId, selection.sourceType, expiresAt]))[0];
        if (!created) throw new Error('Playback session insert did not return a row');
        await manager.query(`INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '24 hours')`, [userId, idempotencyKey, inputHash, sessionId]);
        return { session: created, replay: false, newSession: true };
      });
      session = allocation.session;
      idempotentReplay = allocation.replay;
      if (!allocation.newSession) allocatedSessionId = undefined;
    } catch (error) {
      if (allocatedSessionId) await this.leases.release(userId, allocatedSessionId).catch(() => undefined);
      if (error instanceof HttpException) throw error;
      if (this.isRedisError(error)) throw this.domain(503, 'PLAYBACK_LEASE_UNAVAILABLE', 'Playback session storage is unavailable');
      this.logger.error('Unexpected playback allocation failure', error instanceof Error ? error.stack : undefined);
      throw error;
    }

    try {
      const resolved = await this.resolveSelection(selection, session, requestId);
      const updated = rows<PlaybackSessionRow>(await this.dataSource.query(`
        UPDATE playback_sessions SET state=CASE WHEN state='reserved' THEN 'ready' ELSE state END,last_seen_at=now()
        WHERE id=$1 AND state IN ('reserved','ready','playing') AND expires_at>now() RETURNING *
      `, [session.id]))[0];
      if (!updated) throw this.domain(409, 'PLAYBACK_SESSION_EXPIRED', 'Playback session expired while resolving the source');
      session = updated;
      const resumePosition = progress?.positionSeconds ?? 0;
      const duration = selection.durationSeconds ?? null;
      const boundedPosition = duration === null ? resumePosition : Math.min(resumePosition, duration);
      const sourceChanged = Boolean(progress && progress.sourceItemId !== selection.sourceItemId);
      const durationDifference = progress?.durationSeconds !== null && progress?.durationSeconds !== undefined && duration !== null
        ? Math.abs(progress.durationSeconds - duration) : 0;
      const resumeNeedsConfirmation = sourceChanged && durationDifference > Math.max(60, Math.round((progress?.durationSeconds ?? 0) * 0.05));
      return {
        sessionId: session.id,
        playableId: selection.playableId,
        sourceItemId: selection.sourceItemId,
        sourceType: selection.sourceType,
        protocol: 'hls',
        playbackUrl: resolved.playbackUrl,
        mediaAuth: resolved.mediaAuth,
        drm: null,
        urlExpiresAt: null,
        leaseExpiresAt: new Date(session.expires_at).toISOString(),
        resumePositionSeconds: boundedPosition,
        resumeNeedsConfirmation,
        subtitles: resolved.subtitles,
        offlineSupported: false,
        idempotentReplay,
      };
    } catch (error) {
      await this.failSession(session.id, userId);
      if (error instanceof HttpException) throw error;
      this.logger.error(`Unexpected playback resolution persistence failure: ${error instanceof Error ? error.message : 'unknown error'}`);
      if (error instanceof Error && error.stack) this.logger.debug(error.stack);
      throw error;
    }
  }

  async heartbeat(sessionId: string, userId: string, authSessionId: string, requestId: string) {
    const session = await this.loadOwnedActiveSession(sessionId, userId, authSessionId);
    await this.validateActor(userId, authSessionId, session.profile_id, requestId);
    const selection = await this.fetchCatalogSelection(session.playable_id, session.source_item_id, requestId);
    const entitlement = await this.fetchEntitlement(userId, requestId);
    this.requireEntitlement(selection, entitlement);
    const expiresAt = new Date(Date.now() + this.config.sessionTtlSeconds * 1000);
    try {
      const renewed = await this.dataSource.transaction(async (manager) => {
        const locked = rows<PlaybackSessionRow>(await manager.query(`SELECT * FROM playback_sessions WHERE id=$1 FOR UPDATE`, [sessionId]))[0];
        if (!locked || !['ready', 'playing'].includes(locked.state) || new Date(locked.expires_at).getTime() <= Date.now()) return false;
        if (!await this.leases.renew(userId, sessionId, expiresAt.getTime())) return false;
        await manager.query(`UPDATE playback_sessions SET expires_at=$2,last_seen_at=now() WHERE id=$1`, [sessionId, expiresAt]);
        return true;
      });
      if (!renewed) throw this.domain(409, 'PLAYBACK_SESSION_EXPIRED', 'Playback lease expired; open a new session');
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (this.isRedisError(error)) throw this.domain(503, 'PLAYBACK_LEASE_UNAVAILABLE', 'Playback heartbeat could not verify its Redis lease');
      throw error;
    }
    return { sessionId, leaseExpiresAt: expiresAt.toISOString() };
  }

  async saveProgress(sessionId: string, userId: string, authSessionId: string, input: PlaybackProgressDto, requestId: string) {
    const session = await this.loadOwnedActiveSession(sessionId, userId, authSessionId);
    await this.validateActor(userId, authSessionId, session.profile_id, requestId);
    const seq = BigInt(input.seq);
    if (seq > 9_223_372_036_854_775_807n) throw this.domain(400, 'INVALID_PROGRESS', 'seq exceeds the PostgreSQL BIGINT range');
    if (input.durationSeconds !== undefined && input.durationSeconds !== null && input.positionSeconds > input.durationSeconds) {
      throw this.domain(400, 'INVALID_PROGRESS', 'positionSeconds cannot exceed durationSeconds');
    }
    const result = await this.dataSource.transaction(async (manager) => {
      const locked = rows<PlaybackSessionRow>(await manager.query(`SELECT * FROM playback_sessions WHERE id=$1 FOR UPDATE`, [sessionId]))[0];
      this.assertActive(locked);
      if (seq <= BigInt(locked.last_seq)) return { applied: false, current: await this.readProgressFromManager(manager, locked.profile_id, locked.playable_id) };
      await manager.query(`UPDATE playback_sessions SET last_seq=$2 WHERE id=$1`, [sessionId, input.seq]);
      const written = rows<ProgressRow>(await manager.query(`
        INSERT INTO watch_progress(profile_id,playable_id,movie_id,source_item_id,session_ordinal,last_seq,position_seconds,duration_seconds,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())
        ON CONFLICT(profile_id,playable_id) DO UPDATE SET
          movie_id=EXCLUDED.movie_id,source_item_id=EXCLUDED.source_item_id,session_ordinal=EXCLUDED.session_ordinal,
          last_seq=EXCLUDED.last_seq,position_seconds=EXCLUDED.position_seconds,duration_seconds=EXCLUDED.duration_seconds,updated_at=now()
        WHERE (watch_progress.session_ordinal,watch_progress.last_seq)<(EXCLUDED.session_ordinal,EXCLUDED.last_seq)
        RETURNING profile_id AS "profileId",playable_id AS "playableId",movie_id AS "movieId",source_item_id AS "sourceItemId",
          session_ordinal::text AS "sessionOrdinal",last_seq::text AS seq,position_seconds AS "positionSeconds",duration_seconds AS "durationSeconds",updated_at AS "updatedAt"
      `, [locked.profile_id, locked.playable_id, locked.movie_id, locked.source_item_id, locked.ordinal, input.seq, input.positionSeconds, input.durationSeconds ?? null]))[0];
      return { applied: Boolean(written), current: written ?? await this.readProgressFromManager(manager, locked.profile_id, locked.playable_id) };
    });
    if (result.applied && result.current) {
      await this.leases.cacheProgress(session.profile_id, session.playable_id, result.current.sessionOrdinal, result.current.seq, JSON.stringify(result.current)).catch(() => {
        this.logger.warn('Progress cache update deferred; PostgreSQL remains authoritative');
      });
    }
    return { sessionId, accepted: true, applied: result.applied, progress: result.current };
  }

  async recordEvent(sessionId: string, userId: string, authSessionId: string, input: PlaybackEventDto, requestId: string) {
    const session = rows<PlaybackSessionRow>(await this.dataSource.query(`SELECT * FROM playback_sessions WHERE id=$1 AND user_id=$2`, [sessionId, userId]))[0];
    if (!session || session.auth_session_id !== authSessionId) throw new NotFoundException('Playback session not found');
    await this.validateActor(userId, authSessionId, session.profile_id, requestId);
    if (input.type === 'qualified' && (input.playedSeconds ?? 0) < 30) throw this.domain(400, 'PLAYBACK_NOT_QUALIFIED', 'A qualified view requires at least 30 reported seconds');
    const payload = { type: input.type, playedSeconds: input.playedSeconds ?? null, reasonCode: input.reasonCode ?? null };
    const payloadHash = jsonHash(payload);
    const result = await this.dataSource.transaction(async (manager) => {
      const current = rows<PlaybackSessionRow>(await manager.query(`SELECT * FROM playback_sessions WHERE id=$1 FOR UPDATE`, [sessionId]))[0];
      const prior = rows<{ payload_hash: string }>(await manager.query(`SELECT payload_hash FROM playback_events WHERE session_id=$1 AND event_id=$2`, [sessionId, input.eventId]))[0];
      if (prior) {
        if (prior.payload_hash !== payloadHash) throw this.domain(409, 'PLAYBACK_EVENT_ID_REUSED', 'eventId was already used with a different event payload');
        return { duplicate: true, state: current?.state ?? 'stopped', qualified: Boolean(current?.qualified_at), release: false };
      }
      this.assertActive(current);
      if (current.state === 'reserved') throw this.domain(409, 'PLAYBACK_SESSION_NOT_READY', 'Playback source has not been resolved yet');
      let nextState = current.state;
      let qualified = Boolean(current.qualified_at);
      let release = false;
      if (input.type === 'started') {
        if (current.state === 'ready') {
          await manager.query(`UPDATE playback_sessions SET state='playing',started_at=COALESCE(started_at,now()) WHERE id=$1`, [sessionId]);
          nextState = 'playing';
        }
      } else if (input.type === 'qualified') {
        if (current.state !== 'playing') throw this.domain(409, 'PLAYBACK_SESSION_NOT_PLAYING', 'A session must be playing before it can qualify');
        if (!qualified) {
          const eventId = randomUUID();
          const occurredAt = new Date();
          const envelope: EventEnvelope<{ sessionId: string; userId: string; profileId: string; movieId: string; playedSeconds: number }> = {
            eventId, eventType: 'playback.qualified', schemaVersion: 1, aggregateId: sessionId,
            aggregateVersion: current.ordinal, occurredAt: occurredAt.toISOString(), producer: 'streaming-service',
            correlationId: requestId,
            payload: { sessionId, userId, profileId: current.profile_id, movieId: current.movie_id, playedSeconds: input.playedSeconds ?? 0 },
          };
          await manager.query(`UPDATE playback_sessions SET qualified_at=now() WHERE id=$1 AND qualified_at IS NULL`, [sessionId]);
          await manager.query(`INSERT INTO outbox_events(event_id,event_type,aggregate_id,aggregate_version,occurred_at,envelope) VALUES($1,'playback.qualified',$2,$3,$4,$5::jsonb)`, [eventId, sessionId, current.ordinal, occurredAt, JSON.stringify(envelope)]);
          qualified = true;
        }
      } else {
        if (!['ready', 'playing'].includes(current.state)) throw this.domain(409, 'PLAYBACK_SESSION_NOT_ACTIVE', 'Playback session is not active');
        nextState = input.type === 'stopped' ? 'stopped' : 'failed';
        await manager.query(`UPDATE playback_sessions SET state=$2,closed_at=now(),last_seen_at=now() WHERE id=$1`, [sessionId, nextState]);
        release = true;
      }
      await manager.query(`INSERT INTO playback_events(session_id,event_id,event_type,payload_hash,payload) VALUES($1,$2,$3,$4,$5::jsonb)`, [sessionId, input.eventId, input.type, payloadHash, JSON.stringify(payload)]);
      return { duplicate: false, state: nextState, qualified, release };
    });
    if (result.release) await this.leases.release(userId, sessionId).catch(() => {
      this.logger.warn('Closed playback lease will expire through Redis TTL');
    });
    return { sessionId, eventId: input.eventId, duplicate: result.duplicate, state: result.state, qualified: result.qualified };
  }

  async mediaAuth(sessionId: string, userId: string, authSessionId: string, requestId: string) {
    const session = await this.loadOwnedActiveSession(sessionId, userId, authSessionId);
    await this.validateActor(userId, authSessionId, session.profile_id, requestId);
    if (session.source_type !== 'owned') throw this.domain(422, 'MEDIA_AUTH_NOT_APPLICABLE', 'External media URLs do not use MovieApp media credentials');
    const asset = rows<VideoAssetRow>(await this.dataSource.query(`SELECT * FROM video_assets WHERE source_item_id=$1 AND processing_status='ready'`, [session.source_item_id]))[0];
    if (!asset) throw this.domain(409, 'VIDEO_NOT_READY', 'Owned media asset is not ready');
    return this.issueMediaAuth(session, asset);
  }

  async initiateUpload(input: { sourceItemId: string; sizeBytes: number; checksumSha256: string }, idempotencyKey: string, _actorId: string, requestId: string) {
    if (!/^[A-Za-z0-9._:-]{8,120}$/.test(idempotencyKey)) throw this.domain(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8 to 120 safe characters');
    const source = await this.fetchOwnedSourceItem(input.sourceItemId, requestId);
    const checksum = input.checksumSha256.toLowerCase();
    const result = await this.dataSource.transaction(async (manager) => {
      const current = rows<VideoAssetRow>(await manager.query(`SELECT * FROM video_assets WHERE source_item_id=$1 FOR UPDATE`, [source.sourceItemId]))[0];
      const expiresAt = new Date(Date.now() + this.config.uploadExpirySeconds * 1000);
      if (current && current.processing_status === 'upload_pending' && current.upload_expires_at && current.upload_expires_at > new Date()) {
        if (current.upload_idempotency_key !== idempotencyKey) throw this.domain(409, 'UPLOAD_ALREADY_ACTIVE', 'An upload is already active for this source item');
        if (Number(current.expected_size_bytes) !== input.sizeBytes || current.expected_checksum !== checksum) throw this.domain(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was used for a different upload');
        return current;
      }
      if (current && ['queued', 'processing'].includes(current.processing_status)) throw this.domain(409, 'VIDEO_PROCESSING_ACTIVE', 'A transcode job is already active for this source item');
      const id = current?.id ?? randomUUID();
      const generation = (current?.generation ?? 0) + 1;
      const rawKey = `assets/${id}/g${generation}/raw/${randomUUID()}.mp4`;
      const values = [id, source.sourceItemId, source.playableId, source.movieId, rawKey, input.sizeBytes, checksum, idempotencyKey, generation, expiresAt];
      const asset = rows<VideoAssetRow>(await manager.query(`
        INSERT INTO video_assets(id,source_item_id,playable_id,movie_id,raw_object_key,expected_size_bytes,expected_checksum,checksum_algorithm,upload_idempotency_key,generation,upload_expires_at,processing_status,failure_code,master_manifest_key,available_resolutions,duration_seconds,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'sha256',$8,$9,$10,'upload_pending',NULL,NULL,'{}',NULL,now())
        ON CONFLICT(source_item_id) DO UPDATE SET playable_id=EXCLUDED.playable_id,movie_id=EXCLUDED.movie_id,raw_object_key=EXCLUDED.raw_object_key,expected_size_bytes=EXCLUDED.expected_size_bytes,expected_checksum=EXCLUDED.expected_checksum,checksum_algorithm='sha256',upload_idempotency_key=EXCLUDED.upload_idempotency_key,generation=EXCLUDED.generation,upload_expires_at=EXCLUDED.upload_expires_at,processing_status='upload_pending',failure_code=NULL,master_manifest_key=NULL,available_resolutions='{}',duration_seconds=NULL,processed_attempt=NULL,updated_at=now()
        RETURNING *
      `, values))[0];
      if (!asset) throw new Error('Upload asset did not persist');
      return asset;
    });
    const upload = await this.storage.presignPut(this.config.uploadsBucket, result.raw_object_key!, this.config.uploadExpirySeconds, { sha256: checksum });
    return { assetId: result.id, generation: result.generation, uploadExpiresAt: result.upload_expires_at?.toISOString(), uploadUrl: upload.url, requiredHeaders: upload.requiredHeaders, checksumAlgorithm: 'sha256' };
  }

  async completeUpload(assetId: string, _actorId: string, requestId: string) {
    const asset = rows<VideoAssetRow>(await this.dataSource.query(`SELECT * FROM video_assets WHERE id=$1`, [assetId]))[0];
    if (!asset) throw new NotFoundException('Video asset not found');
    if (asset.processing_status !== 'upload_pending') return { assetId, generation: asset.generation, status: asset.processing_status, duplicate: true };
    if (!asset.upload_expires_at || asset.upload_expires_at.getTime() <= Date.now()) throw this.domain(409, 'UPLOAD_EXPIRED', 'Upload URL has expired; initiate another upload');
    const object = await this.storage.head(this.config.uploadsBucket, asset.raw_object_key!);
    if (!object) throw this.domain(422, 'UPLOAD_OBJECT_MISSING', 'The expected uploaded file was not found');
    if (object.contentLength !== Number(asset.expected_size_bytes)) throw this.domain(422, 'UPLOAD_SIZE_MISMATCH', 'Uploaded file size does not match the initiated upload');
    if (object.metadata.sha256 !== asset.expected_checksum) throw this.domain(422, 'UPLOAD_CHECKSUM_MISMATCH', 'Uploaded file checksum metadata does not match the initiated upload');
    return this.dataSource.transaction(async (manager) => {
      const locked = rows<VideoAssetRow>(await manager.query(`SELECT * FROM video_assets WHERE id=$1 FOR UPDATE`, [assetId]))[0];
      if (!locked) throw new NotFoundException('Video asset not found');
      if (locked.processing_status !== 'upload_pending') return { assetId, generation: locked.generation, status: locked.processing_status, duplicate: true };
      const checked = await this.storage.head(this.config.uploadsBucket, locked.raw_object_key!);
      if (!checked || checked.contentLength !== Number(locked.expected_size_bytes) || checked.metadata.sha256 !== locked.expected_checksum) throw this.domain(422, 'UPLOAD_VERIFICATION_FAILED', 'Uploaded file no longer matches the expected object');
      await manager.query(`UPDATE video_assets SET processing_status='queued',upload_expires_at=NULL,updated_at=now() WHERE id=$1 AND processing_status='upload_pending'`, [assetId]);
      await manager.query(`INSERT INTO upload_completions(asset_id,generation) VALUES($1,$2) ON CONFLICT DO NOTHING`, [assetId, locked.generation]);
      await this.writeMediaOutbox(manager, 'video.uploaded', locked.id, locked.generation, requestId, { assetId: locked.id, generation: locked.generation, sourceItemId: locked.source_item_id, rawObjectKey: locked.raw_object_key, checksum: locked.expected_checksum });
      return { assetId, generation: locked.generation, status: 'queued', duplicate: false };
    });
  }

  async applyProcessing(assetId: string, input: { generation: number; attempt: number; attemptToken: string }, _requestId: string) {
    const update = await this.dataSource.query(`UPDATE video_assets SET processing_status='processing',processed_attempt=$3,updated_at=now()
      WHERE id=$1 AND generation=$2 AND processing_status IN ('queued','processing') AND (processed_attempt IS NULL OR processed_attempt<=$3) RETURNING id`, [assetId, input.generation, input.attempt]);
    return { assetId, applied: rows(update).length > 0 };
  }

  async applyTranscoded(assetId: string, input: { generation: number; attempt: number; attemptToken: string; manifestKey: string; durationSeconds: number; resolutions: string[] }, requestId: string) {
    const asset = rows<VideoAssetRow>(await this.dataSource.query(`UPDATE video_assets SET processing_status='ready',master_manifest_key=$4,duration_seconds=$5,available_resolutions=$6,processed_attempt=$3,failure_code=NULL,updated_at=now()
      WHERE id=$1 AND generation=$2 AND processing_status IN ('queued','processing') AND (processed_attempt IS NULL OR processed_attempt<=$3) RETURNING *`, [assetId, input.generation, input.attempt, input.manifestKey, input.durationSeconds, input.resolutions]))[0];
    if (!asset) return { assetId, applied: false };
    await this.reportOwnedReady(asset.source_item_id, requestId);
    await this.dataSource.transaction((manager) => this.writeMediaOutbox(manager, 'video.ready', asset.id, asset.generation, requestId, { assetId: asset.id, sourceItemId: asset.source_item_id, generation: asset.generation }));
    return { assetId, applied: true };
  }

  async applyTranscodeFailed(assetId: string, input: { generation: number; attempt: number; attemptToken: string; errorCode: string }, requestId: string) {
    const asset = rows<VideoAssetRow>(await this.dataSource.query(`UPDATE video_assets SET processing_status='failed',failure_code=$4,processed_attempt=$3,updated_at=now()
      WHERE id=$1 AND generation=$2 AND processing_status IN ('queued','processing') AND (processed_attempt IS NULL OR processed_attempt<=$3) RETURNING *`, [assetId, input.generation, input.attempt, input.errorCode]))[0];
    if (!asset) return { assetId, applied: false };
    await this.dataSource.transaction((manager) => this.writeMediaOutbox(manager, 'video.transcode_failed', asset.id, asset.generation, requestId, { assetId: asset.id, sourceItemId: asset.source_item_id, generation: asset.generation, errorCode: input.errorCode }));
    return { assetId, applied: true };
  }

  async getProfileProgress(profileId: string, playableId?: string) {
    if (playableId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(playableId)) {
      throw this.domain(400, 'INVALID_PLAYABLE_ID', 'playableId must be a UUID');
    }
    if (playableId) {
      const cached = await this.leases.getProgressCache(profileId, playableId).catch(() => null);
      if (cached) {
        try {
          const item = JSON.parse(cached) as ProgressRow;
          if (item.profileId === profileId && item.playableId === playableId && typeof item.sessionOrdinal === 'string' && typeof item.seq === 'string') return item;
        } catch { /* Invalid cache data falls back to the durable row. */ }
      }
      return this.readProgressFromDatabase(profileId, playableId);
    }
    return this.dataSource.query(`
      SELECT profile_id AS "profileId",playable_id AS "playableId",movie_id AS "movieId",source_item_id AS "sourceItemId",
        session_ordinal::text AS "sessionOrdinal",last_seq::text AS seq,position_seconds AS "positionSeconds",
        duration_seconds AS "durationSeconds",updated_at AS "updatedAt"
      FROM watch_progress WHERE profile_id=$1 ORDER BY updated_at DESC,playable_id LIMIT 100
    `, [profileId]);
  }

  async reapExpiredSessions(): Promise<number> {
    const expired = rows<{ id: string; user_id: string }>(await this.dataSource.query(`
      WITH candidates AS (
        SELECT id FROM playback_sessions WHERE state IN ('reserved','ready','playing') AND expires_at<=now()
        ORDER BY expires_at,id LIMIT 100 FOR UPDATE SKIP LOCKED
      )
      UPDATE playback_sessions s SET state='expired',closed_at=now()
      FROM candidates c WHERE s.id=c.id RETURNING s.id,s.user_id
    `));
    for (const [userId, sessions] of this.groupSessionIds(expired)) {
      await this.leases.releaseMany(userId, sessions).catch(() => undefined);
    }
    await this.dataSource.query(`DELETE FROM playback_requests WHERE expires_at<=now()`);
    return expired.length;
  }

  async processProfileDeleted(eventId: string, profileId: string, userId: string): Promise<void> {
    const ended = await this.dataSource.transaction(async (manager) => {
      const inserted = rows<{ event_id: string }>(await manager.query(`
        INSERT INTO processed_events(consumer_name,event_id) VALUES('streaming-profile-deleted',$1)
        ON CONFLICT(consumer_name,event_id) DO NOTHING RETURNING event_id
      `, [eventId]));
      const sessions = rows<{ id: string; user_id: string }>(await manager.query(`
        UPDATE playback_sessions SET state='stopped',closed_at=COALESCE(closed_at,now())
        WHERE profile_id=$1 AND user_id=$2 AND state IN ('reserved','ready','playing') RETURNING id,user_id
      `, [profileId, userId]));
      if (inserted.length) await manager.query(`DELETE FROM watch_progress WHERE profile_id=$1`, [profileId]);
      return sessions;
    });
    for (const [sessionUserId, ids] of this.groupSessionIds(ended)) {
      await this.leases.releaseMany(sessionUserId, ids).catch(() => {
        this.logger.warn('Deleted-profile playback leases will expire through Redis TTL');
      });
    }
    if (!ended.length) {
      const stopped = rows<{ id: string; user_id: string }>(await this.dataSource.query(`SELECT id,user_id FROM playback_sessions WHERE profile_id=$1 AND user_id=$2 AND state='stopped' ORDER BY closed_at DESC LIMIT 100`, [profileId, userId]));
      for (const [sessionUserId, ids] of this.groupSessionIds(stopped)) await this.leases.releaseMany(sessionUserId, ids).catch(() => undefined);
    }
    await this.leases.deleteProfileProgressCache(profileId).catch(() => undefined);
  }

  async ready(): Promise<void> {
    await Promise.all([this.pingDatabase(), this.pingRedis()]);
  }

  private async validateActor(userId: string, authSessionId: string, profileId: string, requestId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(userId) || !/^[0-9a-f-]{36}$/i.test(authSessionId)) throw new UnauthorizedException('Authenticated session context is invalid');
    const auth = await this.callService<AuthValidation>('auth-service', 'POST', '/internal/auth/validate-session', { userId, sessionId: authSessionId }, requestId);
    if (!auth.active || auth.userId !== userId || auth.sessionId !== authSessionId) throw this.domain(401, 'AUTH_SESSION_REVOKED', 'Account session is no longer active');
    const profile = await this.callService<ProfileValidation>('profile-service', 'POST', '/internal/profiles/validate', { userId, profileId }, requestId);
    if (!profile.active || profile.userId !== userId || profile.profileId !== profileId) throw new NotFoundException('Active profile not found');
    return { profile };
  }

  private async fetchCatalogSelection(playableId: string, sourceItemId: string, requestId: string): Promise<CatalogSelection> {
    const query = `?sourceItemId=${encodeURIComponent(sourceItemId)}`;
    return this.callService<CatalogSelection>('catalog-service', 'GET', `/internal/catalog/playables/${encodeURIComponent(playableId)}${query}`, undefined, requestId);
  }

  private async fetchEntitlement(userId: string, requestId: string): Promise<Entitlement> {
    return this.callService<Entitlement>('payment-service', 'GET', `/internal/subscriptions/users/${encodeURIComponent(userId)}/entitlement`, undefined, requestId);
  }

  private requireEntitlement(selection: CatalogSelection, entitlement: Entitlement): void {
    if (selection.accessTier === 'subscription' && !entitlement.hasSubscription) throw this.domain(403, 'SUBSCRIPTION_REQUIRED', 'An active subscription is required for this content');
    if (!Number.isSafeInteger(entitlement.limits?.maxConcurrentStreams) || entitlement.limits.maxConcurrentStreams < 1) {
      throw this.domain(503, 'ENTITLEMENT_INVALID', 'Playback entitlement limits are unavailable');
    }
  }

  private validateSelection(selection: CatalogSelection, input: CreatePlaybackSessionDto, profile: ProfileValidation): void {
    if (selection.movieId !== input.movieId || selection.playableId !== input.playableId || selection.sourceItemId !== input.sourceItemId) {
      throw new NotFoundException('Movie, playable item and source item do not match');
    }
    if (selection.movieStatus !== 'published') throw new NotFoundException('Movie is not available');
    if (profile.isKids && !selection.isKidsSafe) throw new NotFoundException('Movie is not available to this profile');
    if (selection.sourceType === 'owned' && selection.playbackMode !== 'owned_hls') throw new NotFoundException('Owned source mapping is invalid');
    if (selection.sourceType === 'third_party' && selection.provider !== 'kkphim') throw this.domain(422, 'PLAYBACK_PROVIDER_UNSUPPORTED', 'This third-party provider is not supported');
  }

  private async resolveSelection(selection: CatalogSelection, ownedSession: PlaybackSessionRow, requestId: string): Promise<{ playbackUrl: string; subtitles: string[]; mediaAuth: ReturnType<StreamingService['issueMediaAuth']> | null }> {
    if (selection.sourceType === 'owned') {
      const asset = rows<VideoAssetRow>(await this.dataSource.query(`SELECT * FROM video_assets WHERE source_item_id=$1`, [selection.sourceItemId]))[0];
      if (!asset || asset.processing_status !== 'ready' || !asset.master_manifest_key) throw this.domain(409, 'VIDEO_NOT_READY', 'Owned video asset is not ready');
      const auth = this.issueMediaAuth(ownedSession, asset);
      return { playbackUrl: `${this.config.mediaEdgeUrl}/media/${asset.master_manifest_key}`, subtitles: [], mediaAuth: auth };
    }
    if (selection.playbackMode === 'external_embed' || selection.playbackMode === 'metadata_only') {
      throw this.domain(422, 'PLAYBACK_MODE_UNSUPPORTED', 'This source does not provide a supported HLS stream');
    }
    if (selection.playbackMode !== 'external_hls' || !selection.externalSlug || !selection.externalEpisodeKey || !selection.serverKey) {
      throw this.domain(422, 'PLAYBACK_SELECTOR_INVALID', 'External HLS selectors are incomplete');
    }
    this.sourceCircuit.beforeResolve(selection.sourceItemId, selection.retryAfter);
    if (this.activeProviderResolves >= this.config.maxConcurrentProviderResolves) throw this.domain(503, 'PROVIDER_CONCURRENCY_LIMIT', 'Provider playback resolver is busy');
    this.activeProviderResolves += 1;
    try {
      const result = await withProviderBudget(this.provider.resolvePlayback({
          externalSlug: selection.externalSlug,
          externalEpisodeKey: selection.externalEpisodeKey,
          serverKey: selection.serverKey,
        }), this.config.providerTimeoutMs * 3 + 1_000);
      if (result.mode !== 'external_hls' || !result.playbackUrl) {
        this.sourceCircuit.recordSuccess(selection.sourceItemId);
        if (result.mode === 'external_embed') throw this.domain(422, 'PLAYBACK_MODE_UNSUPPORTED', 'Embed-only playback is not supported');
        throw this.domain(503, 'EXTERNAL_SOURCE_UNAVAILABLE', 'Provider returned no HLS playlist');
      }
      const safeUrl = this.validatePlaybackUrl(result.playbackUrl);
      this.sourceCircuit.recordSuccess(selection.sourceItemId);
      await this.reportSourceStatus(selection.sourceItemId, 'available', null, requestId);
      const subtitles = (result.subtitleUrls ?? []).filter((url) => {
        try { this.validatePlaybackUrl(url); return true; } catch { return false; }
      });
      return { playbackUrl: safeUrl, subtitles, mediaAuth: null };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      const retryAfter = this.sourceCircuit.recordFailure(selection.sourceItemId);
      await this.reportSourceStatus(selection.sourceItemId, 'error', retryAfter.toISOString(), requestId);
      if (error instanceof ProviderResponseError) {
        const code = error.code === 'PROVIDER_MAPPING_CONFLICT' ? 'SOURCE_SELECTOR_NOT_FOUND' : 'EXTERNAL_SOURCE_UNAVAILABLE';
        throw this.domain(503, code, 'Provider could not resolve this source', { retryAfterSeconds: Math.max(1, Math.ceil((retryAfter.getTime() - Date.now()) / 1000)) });
      }
      throw this.domain(503, 'EXTERNAL_SOURCE_UNAVAILABLE', 'Provider could not resolve this source', { retryAfterSeconds: Math.max(1, Math.ceil((retryAfter.getTime() - Date.now()) / 1000)) });
    } finally {
      this.activeProviderResolves -= 1;
    }
  }

  private validatePlaybackUrl(value: string): string {
    let url: URL;
    try { url = new URL(value); } catch { throw new ProviderResponseError('PROVIDER_UNSAFE_PLAYBACK_URL'); }
    const host = url.hostname.toLowerCase();
    const allowed = this.config.mediaHostAllowlist.some((pattern) => {
      if (pattern.startsWith('*.')) return host.endsWith(`.${pattern.slice(2)}`) && host !== pattern.slice(2);
      return host === pattern;
    });
    const nonstandardPortAllowed = this.config.nodeEnv === 'test' && this.config.testMediaPort !== null && Number(url.port) === this.config.testMediaPort;
    if (url.protocol !== 'https:' || !allowed || url.username || url.password || (url.port && url.port !== '443' && !nonstandardPortAllowed) || url.hash || !/\.m3u8$/i.test(url.pathname)) {
      throw new ProviderResponseError('PROVIDER_UNSAFE_PLAYBACK_URL');
    }
    return url.toString();
  }

  private async reportSourceStatus(sourceItemId: string, status: 'available' | 'unavailable' | 'error', retryAfter: string | null, requestId: string): Promise<void> {
    await this.callService('catalog-service', 'POST', `/internal/catalog/source-items/${encodeURIComponent(sourceItemId)}/status`, { status, retryAfter }, requestId).catch(() => undefined);
  }

  private async fetchOwnedSourceItem(sourceItemId: string, requestId: string): Promise<OwnedSourceItem> {
    return this.callService<OwnedSourceItem>('catalog-service', 'GET', `/internal/catalog/owned-source-items/${encodeURIComponent(sourceItemId)}`, undefined, requestId);
  }

  private async reportOwnedReady(sourceItemId: string, requestId: string): Promise<void> {
    await this.callService('catalog-service', 'POST', `/internal/catalog/owned-source-items/${encodeURIComponent(sourceItemId)}/ready`, {}, requestId);
  }

  private issueMediaAuth(session: PlaybackSessionRow, asset: VideoAssetRow) {
    const expiresAt = new Date(Date.now() + this.config.mediaAuthTtlSeconds * 1000);
    const payload = Buffer.from(JSON.stringify({ sid: session.id, aid: asset.id, gen: asset.generation, exp: Math.floor(expiresAt.getTime() / 1000), nonce: randomUUID() })).toString('base64url');
    const signature = createHmac('sha256', this.config.mediaAuthSecret).update(payload).digest('base64url');
    return { cookieName: 'movie_media_auth', cookieValue: `${payload}.${signature}`, path: `/media/assets/${asset.id}/g${asset.generation}/`, expiresAt: expiresAt.toISOString() };
  }

  private async writeMediaOutbox(manager: EntityManager, eventType: 'video.uploaded' | 'video.ready' | 'video.transcode_failed', aggregateId: string, aggregateVersion: number, requestId: string, payload: Record<string, unknown>): Promise<void> {
    const eventId = randomUUID(); const occurredAt = new Date();
    const envelope: EventEnvelope = { eventId, eventType, schemaVersion: 1, aggregateId, aggregateVersion: String(aggregateVersion), occurredAt: occurredAt.toISOString(), producer: 'streaming-service', correlationId: requestId, payload };
    await manager.query(`INSERT INTO outbox_events(event_id,event_type,aggregate_id,aggregate_version,occurred_at,envelope) VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [eventId, eventType, aggregateId, aggregateVersion, occurredAt, JSON.stringify(envelope)]);
  }

  private async callService<T = Record<string, unknown>>(
    service: 'auth-service' | 'profile-service' | 'catalog-service' | 'payment-service',
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    requestId: string,
  ): Promise<T> {
    const baseUrl = service === 'auth-service' ? this.config.authUrl
      : service === 'profile-service' ? this.config.profileUrl
        : service === 'catalog-service' ? this.config.catalogUrl : this.config.paymentUrl;
    const token = this.config.downstreamTokens.get(service);
    if (!token) throw this.domain(503, 'DEPENDENCY_CONFIG_INVALID', `${service} credential is missing`);
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        redirect: 'manual',
        headers: {
          authorization: `Bearer ${token}`,
          'x-caller-service': 'streaming-service',
          'x-request-id': requestId,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(3_000),
      });
    } catch {
      throw this.domain(503, `${service.replaceAll('-', '_').toUpperCase()}_UNAVAILABLE`, `${service} is unavailable`);
    }
    let envelope: { data?: T; error?: { code?: string; message?: string } } | null;
    try { envelope = await response.json() as { data?: T; error?: { code?: string; message?: string } }; }
    catch { envelope = null; }
    if (!response.ok) {
      if (response.status === 404 && ['profile-service', 'catalog-service'].includes(service)) {
        throw this.domain(404, service === 'profile-service' ? 'PROFILE_NOT_FOUND' : 'PLAYABLE_SOURCE_NOT_FOUND', envelope?.error?.message ?? 'Requested resource was not found');
      }
      throw this.domain(503, `${service.replaceAll('-', '_').toUpperCase()}_UNAVAILABLE`, `${service} returned an unavailable response`);
    }
    if (!envelope || envelope.data === undefined) throw this.domain(503, `${service.replaceAll('-', '_').toUpperCase()}_INVALID_RESPONSE`, `${service} returned an invalid response`);
    return envelope.data;
  }

  private async loadOwnedActiveSession(sessionId: string, userId: string, authSessionId: string): Promise<PlaybackSessionRow> {
    const session = rows<PlaybackSessionRow>(await this.dataSource.query(`SELECT * FROM playback_sessions WHERE id=$1 AND user_id=$2`, [sessionId, userId]))[0];
    if (!session || session.auth_session_id !== authSessionId) throw new NotFoundException('Playback session not found');
    this.assertActive(session);
    return session;
  }

  private assertActive(session: PlaybackSessionRow | undefined): asserts session is PlaybackSessionRow {
    if (!session) throw new NotFoundException('Playback session not found');
    if (!['ready', 'playing'].includes(session.state)) throw this.domain(409, 'PLAYBACK_SESSION_TERMINAL', 'Playback session is not active');
    if (new Date(session.expires_at).getTime() <= Date.now()) throw this.domain(409, 'PLAYBACK_SESSION_EXPIRED', 'Playback lease expired; open a new session');
  }

  private async readProgressFromDatabase(profileId: string, playableId: string): Promise<ProgressRow | null> {
    const result = await this.readProgressFromManager(this.dataSource.manager, profileId, playableId);
    return result ?? null;
  }

  private async readProgressFromManager(manager: EntityManager, profileId: string, playableId: string): Promise<ProgressRow | null> {
    const item = rows<ProgressRow>(await manager.query(`
      SELECT profile_id AS "profileId",playable_id AS "playableId",movie_id AS "movieId",source_item_id AS "sourceItemId",
        session_ordinal::text AS "sessionOrdinal",last_seq::text AS seq,position_seconds AS "positionSeconds",
        duration_seconds AS "durationSeconds",updated_at AS "updatedAt"
      FROM watch_progress WHERE profile_id=$1 AND playable_id=$2
    `, [profileId, playableId]))[0];
    return item ?? null;
  }

  private async failSession(sessionId: string, userId: string): Promise<void> {
    await this.dataSource.query(`UPDATE playback_sessions SET state='failed',closed_at=COALESCE(closed_at,now()) WHERE id=$1 AND state IN ('reserved','ready','playing')`, [sessionId]).catch(() => undefined);
    await this.leases.release(userId, sessionId).catch(() => undefined);
  }

  private async reserveLease(userId: string, sessionId: string, limit: number, expiresAt: number): Promise<boolean> {
    try { return await this.leases.reserve(userId, sessionId, limit, expiresAt); }
    catch { throw this.domain(503, 'PLAYBACK_LEASE_UNAVAILABLE', 'Redis playback lease is unavailable; no new playback slot was granted'); }
  }

  private isRedisError(error: unknown): boolean {
    return error instanceof Error && (/redis|socket|connection/i.test(error.message) || error.name === 'MaxRetriesPerRequestError');
  }

  private groupSessionIds(items: Array<{ id: string; user_id: string }>): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const item of items) result.set(item.user_id, [...(result.get(item.user_id) ?? []), item.id]);
    return result;
  }

  private domain(status: number, code: string, message: string, details?: unknown): HttpException {
    return new HttpException({ code, message, ...(details === undefined ? {} : { details }) }, status);
  }
}
