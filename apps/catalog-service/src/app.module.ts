import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RequestIdMiddleware } from '@movie/shared-dto';
import { CatalogConfig, CATALOG_CONFIG, loadCatalogConfig } from './catalog.config';
import { CatalogService } from './catalog.service';
import { CatalogGatewayGuard } from './catalog-auth.guard';
import { CatalogAdminController, CatalogHealthController, CatalogPublicController } from './catalog.controller';
import { CatalogSyncWorker } from './catalog-sync.worker';
import { CatalogOutboxPublisher } from './catalog-outbox.publisher';
import { KkphimAdapter } from '@movie/content-provider';

const config = loadCatalogConfig();

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres', url: config.databaseUrl, entities: [], synchronize: false,
      retryAttempts: 2, retryDelay: 1_000, logging: false,
    }),
  ],
  controllers: [CatalogPublicController, CatalogAdminController, CatalogHealthController],
  providers: [
    { provide: CATALOG_CONFIG, useValue: config satisfies CatalogConfig },
    { provide: KkphimAdapter, useFactory: () => new KkphimAdapter(config.providerBaseUrl, config.providerTimeoutMs) },
    CatalogService,
    CatalogGatewayGuard,
    CatalogSyncWorker,
    CatalogOutboxPublisher,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}
