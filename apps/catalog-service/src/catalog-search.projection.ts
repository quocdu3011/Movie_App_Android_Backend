import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Consumer, Kafka } from 'kafkajs';
import { DataSource } from 'typeorm';
import { EventEnvelope } from '@movie/shared-kafka';
import { CATALOG_CONFIG, CatalogConfig } from './catalog.config';
import { CatalogSearchService } from './catalog-search.service';

type MovieProjectionEvent = EventEnvelope<{ movieId?: string }>;
const TOPICS = ['movie.published', 'movie.updated', 'movie.archived', 'movie.source.updated'] as const;

@Injectable()
export class CatalogSearchProjection implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CatalogSearchProjection.name);
  private readonly consumer: Consumer;
  private stopping = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CATALOG_CONFIG) config: CatalogConfig,
    private readonly search: CatalogSearchService,
  ) {
    this.consumer = new Kafka({ clientId: 'catalog-search-projection', brokers: config.kafkaBrokers, connectionTimeout: 1_500, requestTimeout: 3_000, retry: { retries: 0 } }).consumer({ groupId: 'catalog-search-v1', allowAutoTopicCreation: false });
  }

  onApplicationBootstrap(): void { void this.start(); }

  async onApplicationShutdown(): Promise<void> { this.stopping = true; await this.consumer.disconnect().catch(() => undefined); }

  private async start(): Promise<void> {
    try {
      await this.search.ensureIndex();
      await this.search.reindexPublished();
      await this.consumer.connect();
      await this.consumer.subscribe({ topics: [...TOPICS], fromBeginning: true });
      await this.consumer.run({ eachMessage: async ({ message }) => {
        if (!message.value) return;
        let event: MovieProjectionEvent;
        try { event = JSON.parse(message.value.toString('utf8')) as MovieProjectionEvent; } catch { return; }
        if (!TOPICS.includes(event.eventType as typeof TOPICS[number]) || !event.eventId || !event.aggregateId) return;
        await this.project(event);
      } });
    } catch (error) {
      if (!this.stopping) this.logger.warn(`Search projection deferred: ${error instanceof Error ? error.message : 'dependency unavailable'}`);
    }
  }

  private async project(event: MovieProjectionEvent): Promise<void> {
    const movieId = event.payload?.movieId ?? event.aggregateId;
    const version = Number(event.aggregateVersion);
    if (!Number.isSafeInteger(version) || version < 1) return;
    const already = await this.dataSource.query(`SELECT 1 FROM search_inbox_events WHERE event_id=$1`, [event.eventId]) as unknown[];
    if (already.length) return;
    await this.search.indexCurrentMovie(movieId);
    await this.dataSource.transaction(async (manager) => {
      await manager.query(`INSERT INTO search_inbox_events(event_id,event_type,movie_id,aggregate_version) VALUES($1,$2,$3,$4) ON CONFLICT(event_id) DO NOTHING`, [event.eventId, event.eventType, movieId, version]);
      await manager.query(`INSERT INTO search_projection_versions(movie_id,version,indexed_at) VALUES($1,$2,now()) ON CONFLICT(movie_id) DO UPDATE SET version=GREATEST(search_projection_versions.version,EXCLUDED.version),indexed_at=now()`, [movieId, version]);
    });
  }
}
