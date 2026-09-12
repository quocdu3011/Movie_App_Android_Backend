import { MiddlewareConsumer, Module, NestModule, OnApplicationShutdown, RequestMethod } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RequestIdMiddleware, ServiceHealthModule } from '@movie/shared-dto';
import { loadWorkerConfig, WORKER_CONFIG } from './worker.config';
import { CreateTranscodeJobSchema1700000000006 } from './database/migrations/1700000000006-CreateTranscodeJobSchema';
import { TranscodeService } from './transcode.service';

const config = loadWorkerConfig();

@Module({ imports: [ServiceHealthModule.register('transcode-worker'), TypeOrmModule.forRoot({ type: 'postgres', url: config.databaseUrl, entities: [], migrations: [CreateTranscodeJobSchema1700000000006], synchronize: false })], providers: [{ provide: WORKER_CONFIG, useValue: config }, TranscodeService] })
export class AppModule implements NestModule, OnApplicationShutdown {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
  onApplicationShutdown(): void { /* TranscodeService owns its Kafka connection. */ }
}
