import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Consumer, Kafka } from 'kafkajs';
import { EventEnvelope } from '@movie/shared-kafka';
import { NOTIFICATION_CONFIG, NotificationConfig } from './notification.config';
import { NotificationService } from './notification.service';

const TOPICS = ['movie.published', 'payment.success', 'subscription.expiring', 'video.transcode_failed'] as const;

@Injectable()
export class NotificationConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(NotificationConsumer.name);
  private readonly kafka: Kafka;
  private consumer?: Consumer;
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private connecting = false;
  constructor(@Inject(NOTIFICATION_CONFIG) config: NotificationConfig, private readonly notification: NotificationService) { this.kafka = new Kafka({ clientId: 'notification-service', brokers: config.kafkaBrokers, connectionTimeout: 1_500, requestTimeout: 3_000, retry: { retries: 0 } }); }
  onApplicationBootstrap(): void { this.notification.start(); this.timer = setInterval(() => void this.connect(), 5_000); this.timer.unref(); void this.connect(); }
  async onApplicationShutdown(): Promise<void> { this.stopping = true; this.notification.stop(); if (this.timer) clearInterval(this.timer); await this.consumer?.disconnect().catch(() => undefined); }
  private async connect(): Promise<void> {
    if (this.stopping || this.connecting || this.consumer) return;
    this.connecting = true;
    const consumer = this.kafka.consumer({ groupId: 'notification-v1', allowAutoTopicCreation: false });
    try {
      await consumer.connect(); await consumer.subscribe({ topics: [...TOPICS], fromBeginning: false }); this.consumer = consumer;
      void consumer.run({ autoCommitInterval: 100, autoCommitThreshold: 1, eachMessage: async ({ message }) => {
        if (!message.value) return;
        const event = JSON.parse(message.value.toString('utf8')) as EventEnvelope<Record<string, unknown>>;
        if (TOPICS.includes(event.eventType as typeof TOPICS[number]) && event.eventId) await this.notification.receive({ eventId: event.eventId, eventType: event.eventType, payload: event.payload });
      } }).catch((error: unknown) => { this.logger.warn(`Notification consumer stopped: ${error instanceof Error ? error.message : 'unknown error'}`); if (this.consumer === consumer) this.consumer = undefined; void consumer.disconnect().catch(() => undefined); });
    } catch (error) { await consumer.disconnect().catch(() => undefined); this.logger.warn(`Notification consumer unavailable: ${error instanceof Error ? error.message : 'unknown error'}`); }
    finally { this.connecting = false; }
  }
}
