import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { EventEnvelope } from '@movie/shared-kafka';

@Entity({ name: 'outbox_events' })
@Index('idx_outbox_events_pending', ['availableAt', 'occurredAt'], { where: 'published_at IS NULL' })
export class OutboxEvent {
  @PrimaryColumn({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  @Column({ name: 'event_type', type: 'text' })
  eventType!: 'profile.deleted';

  @Column({ name: 'aggregate_id', type: 'uuid' })
  aggregateId!: string;

  @Column({ name: 'aggregate_version', type: 'bigint' })
  aggregateVersion!: string;

  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;

  @Column({ name: 'available_at', type: 'timestamptz', default: () => 'now()' })
  availableAt!: Date;

  @Column({ name: 'locked_until', type: 'timestamptz', nullable: true })
  lockedUntil!: Date | null;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  @Column({ type: 'jsonb' })
  envelope!: EventEnvelope<{ profileId: string; userId: string }>;
}
