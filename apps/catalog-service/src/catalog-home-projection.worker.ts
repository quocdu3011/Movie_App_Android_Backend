import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { CatalogService } from './catalog.service';

@Injectable()
export class CatalogHomeProjectionWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CatalogHomeProjectionWorker.name);
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private refreshing = false;

  constructor(private readonly catalog: CatalogService) {}

  onApplicationBootstrap(): void {
    void this.refresh();
    this.scheduleMidnightRefresh();
  }

  onApplicationShutdown(): void {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private scheduleMidnightRefresh(): void {
    if (this.stopping) return;
    const now = Date.now();
    const next = new Date(now);
    next.setDate(next.getDate() + 1);
    next.setHours(0, 0, 0, 0);
    const delay = Math.max(1_000, next.getTime() - now);
    this.timer = setTimeout(async () => {
      await this.refresh();
      this.scheduleMidnightRefresh();
    }, delay);
    this.timer.unref();
  }

  private async refresh(): Promise<void> {
    if (this.refreshing || this.stopping) return;
    this.refreshing = true;
    try {
      await this.catalog.refreshHomeCollections('all');
    } catch {
      this.logger.error('Catalog home projection refresh failed');
    } finally {
      this.refreshing = false;
    }
  }
}
