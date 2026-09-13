import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { EventEnvelope } from '@movie/shared-kafka';
import { CreateProfileDto, UpdateProfileDto } from './profile.dto';
import { OutboxEvent } from './outbox-event.entity';
import { Profile } from './profile.entity';
import { Inject } from '@nestjs/common';
import { PROFILE_CONFIG, ProfileConfig } from '../profile.config';

export interface ProfileView {
  id: string;
  name: string;
  avatarId: number | null;
  isKids: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ValidatedProfile {
  active: true;
  userId: string;
  profileId: string;
  isKids: boolean;
}

const ACTIVE_PROFILE_LIMIT = 5;

@Injectable()
export class ProfileService {
  constructor(private readonly dataSource: DataSource, @Inject(PROFILE_CONFIG) private readonly config: ProfileConfig) {}

  private toView(profile: Profile): ProfileView {
    return {
      id: profile.id,
      name: profile.name,
      avatarId: profile.avatarId,
      isKids: profile.isKids,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  }

  async pingDatabase(): Promise<void> {
    await this.dataSource.query('SELECT 1');
  }

  async list(userId: string): Promise<ProfileView[]> {
    const profiles = await this.dataSource.getRepository(Profile).find({
      where: { userId, deletedAt: IsNull() },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    return profiles.map((profile) => this.toView(profile));
  }

  async create(userId: string, input: CreateProfileDto): Promise<ProfileView> {
    const name = input.name.trim();
    if (name.length === 0) throw new BadRequestException('Profile name must not be empty');
    return this.dataSource.transaction(async (manager) => {
      await manager.query(
        'INSERT INTO profile_quotas (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
        [userId],
      );
      await manager.query('SELECT user_id FROM profile_quotas WHERE user_id = $1 FOR UPDATE', [userId]);
      const profileRepository = manager.getRepository(Profile);
      const activeCount = await profileRepository.countBy({ userId, deletedAt: IsNull() });
      if (activeCount >= ACTIVE_PROFILE_LIMIT) {
        throw new ConflictException(`A user can have at most ${ACTIVE_PROFILE_LIMIT} active profiles`);
      }
      const profile = profileRepository.create({
        id: randomUUID(),
        userId,
        name,
        avatarId: input.avatarId ?? null,
        isKids: input.isKids ?? false,
        deletedAt: null,
      });
      return this.toView(await profileRepository.save(profile));
    });
  }

  async update(userId: string, profileId: string, input: UpdateProfileDto): Promise<ProfileView> {
    const hasChanges = input.name !== undefined || input.avatarId !== undefined || input.isKids !== undefined;
    if (!hasChanges) throw new BadRequestException('At least one profile field must be provided');
    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(Profile);
      const profile = await repository.findOne({
        where: { id: profileId, userId, deletedAt: IsNull() },
        lock: { mode: 'pessimistic_write' },
      });
      if (!profile) throw new NotFoundException('Profile not found');
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (name.length === 0) throw new BadRequestException('Profile name must not be empty');
        profile.name = name;
      }
      if (input.avatarId !== undefined) profile.avatarId = input.avatarId;
      if (input.isKids !== undefined) profile.isKids = input.isKids;
      return this.toView(await repository.save(profile));
    });
  }

  async delete(userId: string, profileId: string, requestId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(Profile);
      const profile = await repository.findOne({
        where: { id: profileId, userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!profile) throw new NotFoundException('Profile not found');
      if (profile.deletedAt) return;

      const occurredAt = new Date();
      profile.deletedAt = occurredAt;
      await repository.save(profile);

      const eventId = randomUUID();
      const envelope: EventEnvelope<{ profileId: string; userId: string }> = {
        eventId,
        eventType: 'profile.deleted',
        schemaVersion: 1,
        aggregateId: profile.id,
        aggregateVersion: '1',
        occurredAt: occurredAt.toISOString(),
        producer: 'profile-service',
        correlationId: requestId,
        payload: { profileId: profile.id, userId: profile.userId },
      };
      await manager.getRepository(OutboxEvent).insert({
        eventId,
        eventType: 'profile.deleted',
        aggregateId: profile.id,
        aggregateVersion: envelope.aggregateVersion,
        occurredAt,
        availableAt: occurredAt,
        lockedUntil: null,
        publishedAt: null,
        attempts: 0,
        lastError: null,
        envelope,
      });
    });
  }

  async validate(userId: string, profileId: string): Promise<ValidatedProfile> {
    const profile = await this.dataSource.getRepository(Profile).findOne({
      where: { id: profileId, userId, deletedAt: IsNull() },
    });
    if (!profile) throw new NotFoundException('Active profile not found');
    return { active: true, userId, profileId, isKids: profile.isKids };
  }

  async addFavorite(userId: string, profileId: string, movieId: string, requestId: string) {
    const profile = await this.validate(userId, profileId);
    const movies = await this.catalogMovies([movieId], profile.isKids, false, requestId);
    if (!movies.length) throw new NotFoundException('Movie not found');
    const result = await this.dataSource.query(`INSERT INTO favorite_movies(profile_id,movie_id) VALUES($1,$2) ON CONFLICT(profile_id,movie_id) DO NOTHING RETURNING movie_id`, [profileId, movieId]) as Array<{ movie_id: string }>;
    return { profileId, movieId, created: result.length > 0 };
  }

  async removeFavorite(userId: string, profileId: string, movieId: string): Promise<void> {
    await this.validate(userId, profileId);
    await this.dataSource.query(`DELETE FROM favorite_movies WHERE profile_id=$1 AND movie_id=$2`, [profileId, movieId]);
  }

  async favorites(userId: string, profileId: string, requestId: string) {
    const profile = await this.validate(userId, profileId);
    const rows = await this.dataSource.query(`SELECT movie_id FROM favorite_movies WHERE profile_id=$1 ORDER BY created_at DESC,movie_id`, [profileId]) as Array<{ movie_id: string }>;
    const hydrated = await this.catalogMovies(rows.map((row) => row.movie_id), profile.isKids, false, requestId);
    return { items: hydrated.map((entry) => entry.movie) };
  }

  async history(userId: string, profileId: string, requestId: string) {
    const profile = await this.validate(userId, profileId);
    const response = await this.call(this.config.streamingUrl, this.config.streamingToken, 'profile-service', `/internal/streaming/profiles/${encodeURIComponent(profileId)}/progress`, undefined, requestId);
    const progress = Array.isArray(response) ? response : [];
    const movieIds = progress.flatMap((item) => typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).movieId === 'string' ? [(item as Record<string, unknown>).movieId as string] : []);
    const hydrated = await this.catalogMovies(movieIds, profile.isKids, true, requestId);
    const byId = new Map(hydrated.map((entry) => [entry.movieId, entry]));
    return { items: progress.map((item) => {
      const record = item as Record<string, unknown>;
      const movie = typeof record.movieId === 'string' ? byId.get(record.movieId) : undefined;
      return { ...record, movie: movie?.movie ?? null, tombstone: movie?.tombstone === true };
    }) };
  }

  private async catalogMovies(movieIds: string[], isKids: boolean, includeTombstones: boolean, requestId: string): Promise<Array<{ movieId: string; movie: Record<string, unknown> | null; tombstone: boolean }>> {
    if (!movieIds.length) return [];
    const response = await this.call(this.config.catalogUrl, this.config.catalogToken, 'profile-service', '/internal/catalog/movies/batch', { movieIds, isKids, includeTombstones }, requestId, 'POST');
    return Array.isArray(response) ? response as Array<{ movieId: string; movie: Record<string, unknown> | null; tombstone: boolean }> : [];
  }

  private async call(baseUrl: string, token: string, caller: string, path: string, body: unknown, requestId: string, method = 'GET'): Promise<unknown> {
    if (!token) throw new ServiceUnavailableException('Dependent service integration is not configured');
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'x-caller-service': caller, 'x-request-id': requestId, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(3_000) });
    } catch { throw new ServiceUnavailableException('Dependent service unavailable'); }
    if (!response.ok) {
      if (response.status === 404) throw new NotFoundException('Movie not found');
      throw new ServiceUnavailableException('Dependent service unavailable');
    }
    try { return (await response.json() as { data?: unknown }).data; } catch { throw new ServiceUnavailableException('Dependent service returned invalid response'); }
  }
}
