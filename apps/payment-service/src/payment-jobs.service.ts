import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PAYMENT_CONFIG, PaymentConfig } from './payment.config';
import { PaymentService } from './payment.service';

@Injectable()
export class PaymentJobsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PaymentJobsService.name);
  private timer?: NodeJS.Timeout;
  private polling = false;
  private stopping = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(PAYMENT_CONFIG) private readonly config: PaymentConfig,
    private readonly payment: PaymentService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.poll(), this.config.maintenancePollMs);
    this.timer.unref();
    void this.poll();
  }

  onApplicationShutdown(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
  }

  private async poll(): Promise<void> {
    if (this.polling || this.stopping || !this.dataSource.isInitialized) return;
    this.polling = true;
    try {
      await this.payment.reconcileExpiredPending();
      await this.payment.expireSubscriptionsAndRemind();
    } catch {
      this.logger.warn('Payment maintenance deferred; pending state will be retried');
    } finally {
      this.polling = false;
    }
  }
}
