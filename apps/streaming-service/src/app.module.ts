import { Inject, MiddlewareConsumer, Module, NestModule, OnApplicationShutdown, RequestMethod } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { RequestIdMiddleware } from '@movie/shared-dto';
import { KkphimAdapter } from '@movie/content-provider';
import { STREAMING_CONFIG, loadStreamingConfig } from './streaming.config';
import { CreateStreamingPlaybackSchema1700000000005 } from './database/migrations/1700000000005-CreateStreamingPlaybackSchema';
import { StreamingAdminGuard, StreamingGatewayGuard, StreamingInternalGuard, StreamingWorkerGuard } from './streaming-auth.guard';
import { StreamingAdminController, StreamingController, StreamingHealthController, StreamingProfileController, StreamingWorkerController } from './streaming.controller';
import { CreateOwnedMediaSchema1700000000006 } from './database/migrations/1700000000006-CreateOwnedMediaSchema';
import { PlaybackLeaseStore } from './playback-lease.store';
import { SourceCircuit } from './source-circuit';
import { StreamingService } from './streaming.service';
import { StreamingJobsService } from './streaming-jobs.service';
import { StreamingOutboxPublisher } from './streaming-outbox.publisher';
import { ProfileDeletedConsumer } from './profile-deleted.consumer';

const config = loadStreamingConfig();

@Module({
  imports: [TypeOrmModule.forRoot({
    type: 'postgres', url: config.databaseUrl, entities: [],
    migrations: [CreateStreamingPlaybackSchema1700000000005, CreateOwnedMediaSchema1700000000006], migrationsRun: false,
    synchronize: false, retryAttempts: 2, retryDelay: 1_000,
  })],
  controllers: [StreamingController, StreamingProfileController, StreamingHealthController, StreamingAdminController, StreamingWorkerController],
  providers: [
    { provide: STREAMING_CONFIG, useValue: config },
    {
      provide: 'STREAMING_REDIS',
      useFactory: () => new Redis(config.redisUrl, { lazyConnect: true, connectTimeout: 1_500, maxRetriesPerRequest: 1, retryStrategy: () => null }),
    },
    { provide: KkphimAdapter, useFactory: () => new KkphimAdapter(config.providerBaseUrl, config.providerTimeoutMs) },
    PlaybackLeaseStore, SourceCircuit, StreamingService, StreamingGatewayGuard, StreamingInternalGuard, StreamingAdminGuard, StreamingWorkerGuard,
    StreamingJobsService, StreamingOutboxPublisher, ProfileDeletedConsumer,
  ],
})
export class AppModule implements NestModule, OnApplicationShutdown {
  constructor(@Inject('STREAMING_REDIS') private readonly redis: Redis) {}

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes({ path: '*path', method: RequestMethod.ALL });
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status !== 'end') await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
