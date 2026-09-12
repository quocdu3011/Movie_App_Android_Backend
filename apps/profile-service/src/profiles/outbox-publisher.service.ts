import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Kafka, Producer } from 'kafkajs';
import { EventEnvelope } from '@movie/shared-kafka';
import { PROFILE_CONFIG, ProfileConfig } from '../profile.config';
import { Inject } from '@nestjs/common';

interface PendingProfileEvent {
  event_id: string;
  aggregate_id: string;
  attempts: number | string;
  envelope: EventEnvelope<{ profileId: string; userId: string }>;
}

function resultRows<T>(result: unknown): T[] {
  if (!Array.isArray(result)) return [];
  // TypeORM/pg returns UPDATE ... RETURNING as [rows, affectedCount].
  if (result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') {
    return result[0] as T[];
  }
  return result as T[];
}

@Injectable()
export class OutboxPublisherService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private readonly kafka: Kafka;
  private producer?: Producer;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private stopping = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(PROFILE_CONFIG) private readonly config: ProfileConfig,
  ) {
    this.kafka = new Kafka({
      clientId: 'profile-service',
      brokers: config.kafkaBrokers,
      connectionTimeout: 1_500,
      requestTimeout: 3_000,
      retry: { retries: 0 },
    });
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.poll(), this.config.outboxPollMs);
    this.timer.unref();
    void this.poll();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.producer) {
      await this.producer.disconnect().catch(() => undefined);
      this.producer = undefined;
    }
  }

  private async getProducer(): Promise<Producer> {
    if (!this.producer) {
      this.producer = this.kafka.producer({ allowAutoTopicCreation: false });
      await this.producer.connect();
    }
    return this.producer;
  }

  private async claimBatch(): Promise<PendingProfileEvent[]> {
    const result: unknown = await this.dataSource.query(`
      WITH candidates AS (
        SELECT event_id
        FROM outbox_events
        WHERE published_at IS NULL
          AND available_at <= now()
          AND (locked_until IS NULL OR locked_until < now())
        ORDER BY occurred_at, event_id
        LIMIT 25
        FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox_events AS events
      SET locked_until = now() + interval '2 minutes', attempts = events.attempts + 1
      FROM candidates
      WHERE events.event_id = candidates.event_id
      RETURNING events.event_id, events.aggregate_id, events.attempts, events.envelope
    `);
    return resultRows<PendingProfileEvent>(result);
  }

  private async markPublished(eventId: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE outbox_events SET published_at = now(), locked_until = NULL, last_error = NULL WHERE event_id = $1`,
      [eventId],
    );
  }

  private async reschedule(events: PendingProfileEvent[], error: unknown): Promise<void> {
    const detail = (error instanceof Error ? error.message : 'Kafka publish failed').slice(0, 1000);
    for (const event of events) {
      const attemptCount = Number(event.attempts);
      const exponent = Number.isSafeInteger(attemptCount) && attemptCount > 0
        ? Math.min(attemptCount, 6)
        : 1;
      const delayMs = Math.min(60_000, 1_000 * 2 ** exponent);
      const availableAt = new Date(Date.now() + delayMs);
      const updateResult: unknown = await this.dataSource.query(
        `UPDATE outbox_events
         SET available_at = $2, locked_until = NULL, last_error = $3
         WHERE event_id = $1 AND published_at IS NULL
         RETURNING event_id, last_error`,
        [event.event_id, availableAt, detail],
      );
      const updated = resultRows<{ event_id: string; last_error: string }>(updateResult);
      if (updated.length > 0 && updated[0].last_error !== detail) {
        this.logger.error('Outbox retry state did not persist the delivery error');
      } else if (updated.length === 0) {
        this.logger.error('Outbox retry state did not match an unpublished event');
      }
    }
    this.logger.warn(`Outbox publish deferred for ${events.length} event(s); retry is scheduled`);
  }

  private async poll(): Promise<void> {
    if (this.polling || this.stopping || !this.dataSource.isInitialized) return;
    this.polling = true;
    try {
      const events = await this.claimBatch();
      if (events.length === 0) return;
      let producer: Producer;
      try {
        producer = await this.getProducer();
      } catch (error) {
        this.producer = undefined;
        await this.reschedule(events, error);
        return;
      }
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        try {
          await producer.send({
            topic: event.envelope.eventType,
            messages: [{ key: event.aggregate_id, value: JSON.stringify(event.envelope) }],
          });
          await this.markPublished(event.event_id);
        } catch (error) {
          await producer.disconnect().catch(() => undefined);
          this.producer = undefined;
          await this.reschedule(events.slice(index), error);
          break;
        }
      }
    } catch (error) {
      this.logger.error(`Outbox polling failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    } finally {
      this.polling = false;
    }
  }
}
