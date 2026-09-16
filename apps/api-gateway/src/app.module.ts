import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessAuthGuard } from './auth/access-auth.guard';
import { AdminSessionController, AuthProxyController, GatewayHealthController, SessionController } from './auth/auth-proxy.controller';
import { AuthRateLimitGuard } from './auth/auth-rate-limit.guard';
import { JwksClient } from './auth/jwks.client';
import { RoleGuard } from './auth/role.guard';
import { GATEWAY_CONFIG, loadGatewayConfig } from './gateway.config';
import { RequestIdMiddleware } from '@movie/shared-dto';
import { ProfileProxyController } from './profiles/profile-proxy.controller';
import { CatalogAdminProxyController, CatalogPublicProxyController } from './catalog/catalog-proxy.controller';
import { PaymentWebhookProxyController, SubscriptionProxyController } from './payments/payment-proxy.controller';
import { StreamingAdminProxyController, StreamingProxyController } from './streaming/streaming-proxy.controller';
import { HomeController } from './home/home.controller';
import { AdminOperationsController } from './admin/admin-operations.controller';
import { AdminUserSearchRateLimitGuard } from './admin/admin-user-search-rate-limit.guard';

const config = loadGatewayConfig();

@Module({
  controllers: [AuthProxyController, SessionController, AdminSessionController, GatewayHealthController, ProfileProxyController, CatalogPublicProxyController, CatalogAdminProxyController, SubscriptionProxyController, PaymentWebhookProxyController, StreamingProxyController, StreamingAdminProxyController, HomeController, AdminOperationsController],
  providers: [
    { provide: GATEWAY_CONFIG, useValue: config },
    JwksClient,
    AuthRateLimitGuard,
    AdminUserSearchRateLimitGuard,
    { provide: APP_GUARD, useClass: AccessAuthGuard },
    { provide: APP_GUARD, useClass: RoleGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}
