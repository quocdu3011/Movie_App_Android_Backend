import { Module } from '@nestjs/common';
import { RequestIdMiddleware } from '@movie/shared-dto';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AUTH_CONFIG, loadAuthConfig } from './auth.config';
import { AuthController, AuthHealthController, InternalAuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ServiceTokenGuard } from './service-token.guard';
import { AuthSession } from '../sessions/auth-session.entity';
import { RefreshToken } from '../sessions/refresh-token.entity';
import { User } from '../users/user.entity';
import { CreateAuthSchema1700000000000 } from '../database/migrations/1700000000000-CreateAuthSchema';
import { MiddlewareConsumer, NestModule, RequestMethod } from '@nestjs/common';

const authConfig = loadAuthConfig();

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: authConfig.databaseUrl,
      entities: [User, AuthSession, RefreshToken],
      migrations: [CreateAuthSchema1700000000000],
      migrationsTableName: 'typeorm_migrations',
      synchronize: false,
      migrationsRun: false,
      retryAttempts: 5,
      retryDelay: 1000,
      // TypeORM query errors can include bound values such as password hashes.
      // Keep database query logging disabled in every environment.
      logging: false,
    }),
    TypeOrmModule.forFeature([User, AuthSession, RefreshToken]),
  ],
  controllers: [AuthController, InternalAuthController, AuthHealthController],
  providers: [
    AuthService,
    ServiceTokenGuard,
    { provide: AUTH_CONFIG, useValue: authConfig },
  ],
  exports: [AuthService],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}
