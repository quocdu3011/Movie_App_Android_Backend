import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RequestIdMiddleware } from '@movie/shared-dto';
import { NotificationConsumer } from './notification.consumer';
import { NotificationController, NotificationHealthController } from './notification.controller';
import { NOTIFICATION_CONFIG, loadNotificationConfig } from './notification.config';
import { NotificationService } from './notification.service';

const config = loadNotificationConfig();

@Module({
  imports: [TypeOrmModule.forRoot({ type: 'postgres', url: config.databaseUrl, entities: [], synchronize: false, retryAttempts: 2, retryDelay: 1_000 })],
  controllers: [NotificationController, NotificationHealthController],
  providers: [{ provide: NOTIFICATION_CONFIG, useValue: config }, NotificationService, NotificationConsumer],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}
