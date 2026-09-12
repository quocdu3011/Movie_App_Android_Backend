import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessAuthGuard } from './auth/access-auth.guard';
import { AdminSessionController, AuthProxyController, GatewayHealthController, SessionController } from './auth/auth-proxy.controller';
import { AuthRateLimitGuard } from './auth/auth-rate-limit.guard';
import { JwksClient } from './auth/jwks.client';
import { RoleGuard } from './auth/role.guard';
import { GATEWAY_CONFIG, loadGatewayConfig } from './gateway.config';
import { RequestIdMiddleware } from '@movie/shared-dto';

const config = loadGatewayConfig();

@Module({
  controllers: [AuthProxyController, SessionController, AdminSessionController, GatewayHealthController],
  providers: [
    { provide: GATEWAY_CONFIG, useValue: config },
    JwksClient,
    AuthRateLimitGuard,
    { provide: APP_GUARD, useClass: AccessAuthGuard },
    { provide: APP_GUARD, useClass: RoleGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}
