import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Consumer, Kafka } from 'kafkajs';
import { EventEnvelope } from '@movie/shared-kafka';
import { STREAMING_CONFIG, StreamingConfig } from './streaming.config';
import { StreamingService } from './streaming.service';

interface ProfileDeletedPayload { profileId: string; userId: string }

@Injectable()
export class ProfileDeletedConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ProfileDeletedConsumer.name);
  private readonly kafka: Kafka;
  private consumer?: Consumer;
  private timer?: NodeJS.Timeout;
  private connecting = false;
  private stopping = false;

  constructor(@Inject(STREAMING_CONFIG) private readonly config: StreamingConfig, private readonly streaming: StreamingService) {
    this.kafka = new Kafka({ clientId: 'streaming-service-profile-deleted', brokers: config.kafkaBrokers, connectionTimeout: 1_500, requestTimeout: 3_000, retry: { retries: 0 } });
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.connect(), 5_000);
    this.timer.unref();
    void this.connect();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.consumer?.disconnect().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    if (this.connecting || this.stopping || this.consumer) return;
    this.connecting = true;
    const consumer = this.kafka.consumer({ groupId: 'streaming-service-profile-deleted', allowAutoTopicCreation: false });
    try {
      await consumer.connect();
      await consumer.subscribe({ topic: 'profile.deleted', fromBeginning: false });
      this.consumer = consumer;
      void consumer.run({
        eachMessage: async ({ message }) => {
          if (!message.value) return;
          const event = JSON.parse(message.value.toString()) as EventEnvelope<ProfileDeletedPayload>;
          if (event.eventType !== 'profile.deleted' || !event.eventId || !event.payload?.profileId || !event.payload?.userId) {
            throw new Error('Malformed profile.deleted event');
          }
          await this.streaming.processProfileDeleted(event.eventId, event.payload.profileId, event.payload.userId);
        },
      }).catch((error: unknown) => {
        this.logger.warn(`Profile deletion consumer stopped: ${error instanceof Error ? error.message : 'unknown error'}`);
        if (this.consumer === consumer) this.consumer = undefined;
        void consumer.disconnect().catch(() => undefined);
      });
    } catch (error) {
      await consumer.disconnect().catch(() => undefined);
      this.logger.warn(`Profile deletion consumer unavailable: ${error instanceof Error ? error.message : 'unknown error'}`);
    } finally { this.connecting = false; }
  }
}
