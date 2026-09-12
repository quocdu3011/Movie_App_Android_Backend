import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Kafka, Producer } from 'kafkajs';
import { EventEnvelope } from '@movie/shared-kafka';
import { STREAMING_CONFIG, StreamingConfig } from './streaming.config';

interface PendingEvent { event_id: string; aggregate_id: string; attempts: number | string; envelope: EventEnvelope }

function resultRows<T>(result: unknown): T[] {
  if (!Array.isArray(result)) return [];
  if (result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') return result[0] as T[];
  return result as T[];
}

@Injectable()
export class StreamingOutboxPublisher implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(StreamingOutboxPublisher.name);
  private readonly kafka: Kafka;
  private producer?: Producer;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private stopping = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(STREAMING_CONFIG) private readonly config: StreamingConfig,
  ) {
    this.kafka = new Kafka({ clientId: 'streaming-service', brokers: config.kafkaBrokers, connectionTimeout: 1_500, requestTimeout: 3_000, retry: { retries: 0 } });
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.poll(), this.config.outboxPollMs);
    this.timer.unref();
    void this.poll();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.producer?.disconnect().catch(() => undefined);
  }

  private async claim(): Promise<PendingEvent[]> {
    const result: unknown = await this.dataSource.query(`
      WITH candidates AS (
        SELECT event_id FROM outbox_events WHERE published_at IS NULL AND available_at<=now()
          AND (locked_until IS NULL OR locked_until<now()) ORDER BY occurred_at,event_id LIMIT 25 FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox_events e SET locked_until=now()+interval '2 minutes',attempts=e.attempts+1
      FROM candidates c WHERE e.event_id=c.event_id
      RETURNING e.event_id,e.aggregate_id,e.attempts,e.envelope
    `);
    return resultRows<PendingEvent>(result);
  }

  private async producerClient(): Promise<Producer> {
    if (!this.producer) {
      this.producer = this.kafka.producer({ allowAutoTopicCreation: false });
      await this.producer.connect();
    }
    return this.producer;
  }

  private async defer(events: PendingEvent[], error: unknown): Promise<void> {
    const detail = (error instanceof Error ? error.message : 'Kafka publish failed').slice(0, 1000);
    for (const event of events) {
      const exponent = Math.min(Math.max(1, Number(event.attempts) || 1), 6);
      const availableAt = new Date(Date.now() + Math.min(60_000, 1_000 * 2 ** exponent));
      await this.dataSource.query(`UPDATE outbox_events SET available_at=$2,locked_until=NULL,last_error=$3 WHERE event_id=$1 AND published_at IS NULL`, [event.event_id, availableAt, detail]);
    }
    this.logger.warn(`Playback outbox publish deferred for ${events.length} event(s)`);
  }

  private async poll(): Promise<void> {
    if (this.polling || this.stopping || !this.dataSource.isInitialized) return;
    this.polling = true;
    try {
      const events = await this.claim();
      if (!events.length) return;
      let producer: Producer;
      try { producer = await this.producerClient(); }
      catch (error) { this.producer = undefined; await this.defer(events, error); return; }
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        try {
          await producer.send({ topic: event.envelope.eventType, messages: [{ key: event.aggregate_id, value: JSON.stringify(event.envelope) }] });
          await this.dataSource.query(`UPDATE outbox_events SET published_at=now(),locked_until=NULL,last_error=NULL WHERE event_id=$1`, [event.event_id]);
        } catch (error) {
          await producer.disconnect().catch(() => undefined);
          this.producer = undefined;
          await this.defer(events.slice(index), error);
          break;
        }
      }
    } catch {
      this.logger.warn('Playback outbox polling failed; pending event will be retried');
    } finally { this.polling = false; }
  }
}
