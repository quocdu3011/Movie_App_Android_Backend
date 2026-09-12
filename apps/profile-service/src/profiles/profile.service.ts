import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { EventEnvelope } from '@movie/shared-kafka';
import { CreateProfileDto, UpdateProfileDto } from './profile.dto';
import { OutboxEvent } from './outbox-event.entity';
import { Profile } from './profile.entity';

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
  constructor(private readonly dataSource: DataSource) {}

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
}
