import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RequestIdMiddleware } from '@movie/shared-dto';
import { PAYMENT_CONFIG, loadPaymentConfig } from './payment.config';
import { PaymentGatewayGuard, PaymentInternalGuard } from './payment-auth.guard';
import { PaymentHealthController, PaymentInternalController, PaymentWebhookController, SubscriptionController } from './payment.controller';
import { PaymentJobsService } from './payment-jobs.service';
import { PaymentOutboxPublisher } from './payment-outbox.publisher';
import { PaymentService } from './payment.service';

const config = loadPaymentConfig();

@Module({
  imports: [TypeOrmModule.forRoot({ type: 'postgres', url: config.databaseUrl, entities: [], synchronize: false, retryAttempts: 2, retryDelay: 1000 })],
  controllers: [SubscriptionController, PaymentWebhookController, PaymentInternalController, PaymentHealthController],
  providers: [
    { provide: PAYMENT_CONFIG, useValue: config }, PaymentService, PaymentGatewayGuard, PaymentInternalGuard,
    PaymentJobsService, PaymentOutboxPublisher,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}
