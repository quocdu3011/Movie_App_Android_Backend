import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RequestIdMiddleware } from '@movie/shared-dto';
import { PROFILE_CONFIG, loadProfileConfig } from './profile.config';
import { OutboxEvent } from './profiles/outbox-event.entity';
import { ProfileQuota } from './profiles/profile-quota.entity';
import { Profile } from './profiles/profile.entity';
import { AdminProfileController, InternalProfileController, ProfileController, ProfileHealthController } from './profiles/profile.controller';
import { ProfileAdminGuard, ProfileGatewayGuard, ProfileInternalGuard } from './profiles/profile-auth.guard';
import { ProfileService } from './profiles/profile.service';
import { OutboxPublisherService } from './profiles/outbox-publisher.service';

const config = loadProfileConfig();

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: config.databaseUrl,
      entities: [Profile, ProfileQuota, OutboxEvent],
      synchronize: false,
      retryAttempts: 2,
      retryDelay: 1_000,
    }),
    TypeOrmModule.forFeature([Profile, ProfileQuota, OutboxEvent]),
  ],
  controllers: [ProfileController, InternalProfileController, AdminProfileController, ProfileHealthController],
  providers: [
    { provide: PROFILE_CONFIG, useValue: config },
    ProfileService,
    ProfileGatewayGuard,
    ProfileInternalGuard,
    ProfileAdminGuard,
    OutboxPublisherService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}
