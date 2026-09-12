import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Kafka, Producer } from 'kafkajs';
import { EventEnvelope } from '@movie/shared-kafka';
import { PAYMENT_CONFIG, PaymentConfig } from './payment.config';

interface PendingPaymentEvent { event_id: string; aggregate_id: string; attempts: number | string; envelope: EventEnvelope }

function asRows<T>(result: unknown): T[] {
  if (!Array.isArray(result)) return [];
  if (result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') return result[0] as T[];
  return result as T[];
}

@Injectable()
export class PaymentOutboxPublisher implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PaymentOutboxPublisher.name);
  private readonly kafka: Kafka;
  private producer?: Producer;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private stopping = false;

  constructor(@InjectDataSource() private readonly dataSource: DataSource, @Inject(PAYMENT_CONFIG) config: PaymentConfig) {
    this.kafka = new Kafka({ clientId: 'payment-service', brokers: config.kafkaBrokers, connectionTimeout: 1500, requestTimeout: 3000, retry: { retries: 0 } });
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.poll(), 1000);
    this.timer.unref();
    void this.poll();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.producer?.disconnect().catch(() => undefined);
    this.producer = undefined;
  }

  private async poll(): Promise<void> {
    if (this.polling || this.stopping || !this.dataSource.isInitialized) return;
    this.polling = true;
    try {
      const events = asRows<PendingPaymentEvent>(await this.dataSource.query(`
        WITH candidates AS (
          SELECT event_id FROM outbox_events WHERE published_at IS NULL AND available_at<=now()
            AND (locked_until IS NULL OR locked_until<now())
          ORDER BY occurred_at,event_id LIMIT 20 FOR UPDATE SKIP LOCKED
        )
        UPDATE outbox_events e SET locked_until=now()+interval '2 minutes',attempts=e.attempts+1
        FROM candidates c WHERE e.event_id=c.event_id RETURNING e.event_id,e.aggregate_id,e.attempts,e.envelope
      `));
      if (!events.length) return;
      if (!this.producer) {
        this.producer = this.kafka.producer({ allowAutoTopicCreation: false });
        try { await this.producer.connect(); } catch { this.producer = undefined; throw new Error('broker_unavailable'); }
      }
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        try {
          await this.producer.send({ topic: event.envelope.eventType, messages: [{ key: event.aggregate_id, value: JSON.stringify(event.envelope) }] });
          await this.dataSource.query(`UPDATE outbox_events SET published_at=now(),locked_until=NULL,last_error=NULL WHERE event_id=$1`, [event.event_id]);
        } catch {
          await this.producer.disconnect().catch(() => undefined);
          this.producer = undefined;
          for (const pending of events.slice(index)) {
            const delaySeconds = Math.min(60, 2 ** Math.min(Number(pending.attempts) || 1, 6));
            await this.dataSource.query(`UPDATE outbox_events SET available_at=now()+($2 || ' seconds')::interval,locked_until=NULL,last_error='broker_unavailable' WHERE event_id=$1 AND published_at IS NULL`, [pending.event_id, delaySeconds]);
          }
          break;
        }
      }
    } catch {
      this.logger.warn('Payment outbox delivery deferred; unpublished events remain durable');
      if (this.producer) await this.producer.disconnect().catch(() => undefined);
      this.producer = undefined;
      await this.dataSource.query(`UPDATE outbox_events SET available_at=now()+interval '2 seconds',locked_until=NULL,last_error='broker_unavailable' WHERE published_at IS NULL AND locked_until>now()`).catch(() => undefined);
    } finally {
      this.polling = false;
    }
  }
}
