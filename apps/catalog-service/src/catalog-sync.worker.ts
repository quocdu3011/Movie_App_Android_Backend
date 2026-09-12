import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Inject } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { CATALOG_CONFIG, CatalogConfig } from './catalog.config';

@Injectable()
export class CatalogSyncWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CatalogSyncWorker.name);
  private timer?: NodeJS.Timeout;
  private polling = false;
  private stopping = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly catalog: CatalogService,
    @Inject(CATALOG_CONFIG) private readonly config: CatalogConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.poll(), this.config.syncPollMs);
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
      const run = await this.catalog.claimSyncRun();
      if (run) await this.catalog.runSyncJob(run);
    } catch {
      this.logger.warn('Catalog sync job poll failed; queued jobs remain available for retry');
    } finally {
      this.polling = false;
    }
  }
}
