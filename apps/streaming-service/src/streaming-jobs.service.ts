import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { STREAMING_CONFIG, StreamingConfig } from './streaming.config';
import { StreamingService } from './streaming.service';

@Injectable()
export class StreamingJobsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(StreamingJobsService.name);
  private timer?: NodeJS.Timeout;
  private polling = false;
  private stopping = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(STREAMING_CONFIG) private readonly config: StreamingConfig,
    private readonly streaming: StreamingService,
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
      await this.streaming.reapExpiredSessions();
    } catch {
      this.logger.warn('Expired playback cleanup deferred; database expiry remains authoritative');
    } finally {
      this.polling = false;
    }
  }
}
