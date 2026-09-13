import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Consumer, Kafka } from 'kafkajs';
import { EventEnvelope } from '@movie/shared-kafka';
import { RECOMMENDATION_CONFIG, RecommendationConfig } from './recommendation.config';
import { RecommendationService } from './recommendation.service';

@Injectable()
export class RecommendationConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RecommendationConsumer.name);
  private readonly kafka: Kafka;
  private consumer?: Consumer;
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private connecting = false;

  constructor(@Inject(RECOMMENDATION_CONFIG) config: RecommendationConfig, private readonly recommendation: RecommendationService) {
    this.kafka = new Kafka({ clientId: 'recommendation-service', brokers: config.kafkaBrokers, connectionTimeout: 1_500, requestTimeout: 3_000, retry: { retries: 0 } });
  }
  onApplicationBootstrap(): void { this.timer = setInterval(() => void this.connect(), 5_000); this.timer.unref(); void this.connect(); }
  async onApplicationShutdown(): Promise<void> { this.stopping = true; if (this.timer) clearInterval(this.timer); await this.consumer?.disconnect().catch(() => undefined); }
  private async connect(): Promise<void> {
    if (this.stopping || this.connecting || this.consumer) return;
    this.connecting = true;
    const consumer = this.kafka.consumer({ groupId: 'recommendation-v1', allowAutoTopicCreation: false });
    try {
      await consumer.connect(); await consumer.subscribe({ topics: ['playback.qualified', 'profile.deleted'], fromBeginning: false }); this.consumer = consumer;
      void consumer.run({ autoCommitInterval: 100, autoCommitThreshold: 1, eachMessage: async ({ message }) => {
        if (!message.value) return;
        const event = JSON.parse(message.value.toString('utf8')) as EventEnvelope<Record<string, unknown>>;
        if (event.eventType === 'playback.qualified' && typeof event.payload.sessionId === 'string' && typeof event.payload.userId === 'string' && typeof event.payload.profileId === 'string' && typeof event.payload.movieId === 'string') {
          await this.recommendation.processQualified({ eventId: event.eventId, sessionId: event.payload.sessionId, userId: event.payload.userId, profileId: event.payload.profileId, movieId: event.payload.movieId, occurredAt: event.occurredAt });
        } else if (event.eventType === 'profile.deleted' && typeof event.payload.profileId === 'string') await this.recommendation.processProfileDeleted(event.eventId, event.payload.profileId);
      } }).catch((error: unknown) => { this.logger.warn(`Recommendation consumer stopped: ${error instanceof Error ? error.message : 'unknown error'}`); if (this.consumer === consumer) this.consumer = undefined; void consumer.disconnect().catch(() => undefined); });
    } catch (error) { await consumer.disconnect().catch(() => undefined); this.logger.warn(`Recommendation consumer unavailable: ${error instanceof Error ? error.message : 'unknown error'}`); }
    finally { this.connecting = false; }
  }
}
