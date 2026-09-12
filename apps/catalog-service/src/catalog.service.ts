import {
  BadRequestException, ConflictException, Inject, Injectable, NotFoundException,
  ServiceUnavailableException, UnauthorizedException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { EventEnvelope } from '@movie/shared-kafka';
import { ProviderMovieMetadata, ProviderResponseError, ProviderServer, ProviderSearchPage } from '@movie/content-provider';
import { CATALOG_CONFIG, CatalogConfig } from './catalog.config';
import { KkphimAdapter } from '@movie/content-provider';

type MovieKind = 'movie' | 'series';
type SourceState = 'unknown' | 'available' | 'unavailable' | 'error';
type MovieEvent = 'movie.published' | 'movie.updated' | 'movie.archived' | 'movie.source.updated';

interface MovieRow {
  id: string; title: string; origin_title: string | null; description: string | null; poster_url: string | null;
  backdrop_url: string | null; release_year: number | null; type: MovieKind; content_kind: 'film' | 'animation' | 'show';
  status: 'draft' | 'published' | 'archived'; access_tier: 'free' | 'subscription'; is_kids_safe: boolean;
  average_rating: string | number; published_at: Date | null; version: string; created_at: Date; updated_at: Date;
}

interface ProfileResult { active?: boolean; userId?: string; profileId?: string; isKids?: boolean }

function asRows<T>(result: unknown): T[] {
  if (!Array.isArray(result)) return [];
  if (result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') return result[0] as T[];
  return result as T[];
}

function text(value: unknown, max = 500): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function safeDescription(value: string | null): string | null {
  if (!value) return null;
  const withoutControls = [...value].filter((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 || code === 9 || code === 10 || code === 13;
  }).join('');
  return withoutControls.replace(/<[^>]*>/g, ' ').trim().slice(0, 20_000) || null;
}

function publicMovie(row: MovieRow): Record<string, unknown> {
  return {
    id: row.id, title: row.title, originTitle: row.origin_title, description: row.description,
    posterUrl: row.poster_url, backdropUrl: row.backdrop_url, releaseYear: row.release_year,
    type: row.type, contentKind: row.content_kind, status: row.status, accessTier: row.access_tier,
    isKidsSafe: row.is_kids_safe, averageRating: Number(row.average_rating), publishedAt: row.published_at,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function episodeIdentity(server: ProviderServer, episodeIndex: number, label: string, number: number | null): string {
  if (number !== null) return `number:${number}`;
  const normalized = label.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!normalized) throw new ConflictException({ code: 'CATALOG_MAPPING_CONFLICT', message: 'Episode label cannot be mapped safely' });
  return `label:${normalized}`;
}

@Injectable()
export class CatalogService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CATALOG_CONFIG) private readonly config: CatalogConfig,
    private readonly provider: KkphimAdapter,
  ) {}

  async pingDatabase(): Promise<void> { await this.dataSource.query('SELECT 1'); }

  async playbackSelection(playableId: string, sourceItemId: string) {
    const rows = await this.dataSource.query(`
      SELECT m.id AS "movieId",m.status AS "movieStatus",m.access_tier AS "accessTier",m.is_kids_safe AS "isKidsSafe",
        p.id AS "playableId",p.kind AS "playableKind",p.label AS "playableLabel",p.duration_seconds AS "durationSeconds",
        cs.id AS "sourceId",cs.source_type AS "sourceType",cs.provider,cs.external_slug AS "externalSlug",
        si.id AS "sourceItemId",si.server_key AS "serverKey",si.server_label AS "serverLabel",
        si.external_episode_key AS "externalEpisodeKey",si.external_episode_slug AS "externalEpisodeSlug",
        si.playback_mode AS "playbackMode",si.source_status AS "sourceStatus",si.retry_after AS "retryAfter"
      FROM playable_items p JOIN movies m ON m.id=p.movie_id
      JOIN source_items si ON si.playable_id=p.id AND si.movie_id=m.id
      JOIN content_sources cs ON cs.id=si.source_id AND cs.movie_id=m.id
      WHERE p.id=$1 AND si.id=$2 AND p.archived_at IS NULL
    `, [playableId, sourceItemId]) as Array<Record<string, unknown>>;
    if (!rows[0] || rows[0].movieStatus !== 'published') throw new NotFoundException('Playable source is not publicly available');
    return rows[0];
  }

  async ownedSourceItem(sourceItemId: string) {
    const rows = await this.dataSource.query(`
      SELECT si.id AS "sourceItemId",si.movie_id AS "movieId",si.playable_id AS "playableId",cs.source_type AS "sourceType",si.playback_mode AS "playbackMode"
      FROM source_items si JOIN content_sources cs ON cs.id=si.source_id AND cs.movie_id=si.movie_id
      JOIN playable_items p ON p.id=si.playable_id AND p.movie_id=si.movie_id AND p.archived_at IS NULL
      WHERE si.id=$1
    `, [sourceItemId]) as Array<{ sourceItemId: string; movieId: string; playableId: string; sourceType: string; playbackMode: string }>;
    const source = rows[0];
    if (!source || source.sourceType !== 'owned' || source.playbackMode !== 'owned_hls') throw new NotFoundException('Owned source item not found');
    return { ...source, sourceType: 'owned' as const, playbackMode: 'owned_hls' as const };
  }

  async markOwnedReady(sourceItemId: string, requestId: string) {
    return this.dataSource.transaction(async (manager) => {
      const selected = await manager.query(`
        SELECT si.movie_id,si.source_id,si.source_status,cs.source_type,m.version AS movie_version
        FROM source_items si JOIN content_sources cs ON cs.id=si.source_id JOIN movies m ON m.id=si.movie_id
        WHERE si.id=$1 FOR UPDATE OF si,cs
      `, [sourceItemId]) as Array<{ movie_id: string; source_id: string; source_status: SourceState; source_type: string; movie_version: string }>;
      const source = selected[0];
      if (!source || source.source_type !== 'owned') throw new NotFoundException('Owned source item not found');
      const changed = source.source_status !== 'available';
      await manager.query(`UPDATE source_items SET source_status='available',retry_after=NULL,last_resolved_at=now(),version=version+CASE WHEN $2 THEN 1 ELSE 0 END,updated_at=now() WHERE id=$1`, [sourceItemId, changed]);
      await manager.query(`UPDATE content_sources SET source_status='available',metadata_checked_at=now(),version=version+CASE WHEN source_status<>'available' THEN 1 ELSE 0 END,updated_at=now() WHERE id=$1`, [source.source_id]);
      if (changed) await this.writeEvent(manager, 'movie.source.updated', source.movie_id, source.movie_version, requestId, { movieId: source.movie_id, sourceId: source.source_id, sourceItemId, sourceStatus: 'available', retryAfter: null });
      return { sourceItemId, sourceStatus: 'available' };
    });
  }

  async reportSourceStatus(sourceItemId: string, status: 'available' | 'unavailable' | 'error', retryAfterValue: string | null, requestId: string) {
    let retryAfter: Date | null = null;
    if (retryAfterValue) {
      retryAfter = new Date(retryAfterValue);
      if (!Number.isFinite(retryAfter.getTime()) || retryAfter.getTime() <= Date.now() || retryAfter.getTime() > Date.now() + 24 * 60 * 60_000) {
        throw new BadRequestException('retryAfter must be a future timestamp within 24 hours');
      }
    }
    if (status === 'available' && retryAfter) throw new BadRequestException('An available source cannot have retryAfter');
    return this.dataSource.transaction(async (manager) => {
      const selected = await manager.query(`
        SELECT si.movie_id,si.source_id,si.source_status,si.retry_after,cs.source_type,m.version AS movie_version
        FROM source_items si JOIN content_sources cs ON cs.id=si.source_id JOIN movies m ON m.id=si.movie_id
        WHERE si.id=$1 FOR UPDATE OF si,cs
      `, [sourceItemId]) as Array<{ movie_id: string; source_id: string; source_status: SourceState; retry_after: Date | null; source_type: string; movie_version: string }>;
      const current = selected[0];
      if (!current || current.source_type !== 'third_party') throw new NotFoundException('Third-party source item not found');
      const changed = current.source_status !== status || (current.retry_after?.getTime() ?? null) !== (retryAfter?.getTime() ?? null);
      await manager.query(`UPDATE source_items SET source_status=$2,last_resolved_at=now(),retry_after=$3,version=version+CASE WHEN $4 THEN 1 ELSE 0 END,updated_at=now() WHERE id=$1`, [sourceItemId, status, retryAfter, changed]);
      const aggregateRows = await manager.query(`
        SELECT CASE WHEN bool_or(source_status='available') THEN 'available'
          WHEN bool_or(source_status='unknown') THEN 'unknown'
          WHEN bool_or(source_status='error') THEN 'error' ELSE 'unavailable' END AS status
        FROM source_items WHERE source_id=$1
      `, [current.source_id]) as Array<{ status: SourceState }>;
      const aggregateStatus = aggregateRows[0]?.status ?? status;
      await manager.query(`
        UPDATE content_sources SET source_status=$2,metadata_checked_at=now(),
          version=version+CASE WHEN source_status<>$2 THEN 1 ELSE 0 END,updated_at=now() WHERE id=$1
      `, [current.source_id, aggregateStatus]);
      if (changed) await this.writeEvent(manager, 'movie.source.updated', current.movie_id, current.movie_version, requestId, {
        movieId: current.movie_id, sourceId: current.source_id, sourceItemId, sourceStatus: status,
        retryAfter: retryAfter?.toISOString() ?? null,
      });
      return { sourceItemId, sourceStatus: status, retryAfter: retryAfter?.toISOString() ?? null };
    });
  }

  async profileFilter(profileId: string | undefined, userId: string | undefined, requestId: string): Promise<boolean> {
    if (!profileId) return false;
    if (!userId) throw new UnauthorizedException('JWT authentication is required when profileId is provided');
    let response: Response;
    try {
      response = await fetch(`${this.config.profileUrl}/internal/profiles/validate`, {
        method: 'POST', redirect: 'manual',
        headers: { authorization: `Bearer ${this.config.profileToken}`, 'content-type': 'application/json', 'x-request-id': requestId },
        body: JSON.stringify({ userId, profileId }), signal: AbortSignal.timeout(3_000),
      });
    } catch { throw new ServiceUnavailableException('Profile service unavailable'); }
    if (response.status === 404) throw new NotFoundException('Active profile not found');
    if (!response.ok) throw new ServiceUnavailableException('Profile service unavailable');
    let envelope: { data?: ProfileResult };
    try { envelope = await response.json() as { data?: ProfileResult }; } catch { throw new ServiceUnavailableException('Profile service returned an invalid response'); }
    if (!envelope.data?.active || envelope.data.userId !== userId || envelope.data.profileId !== profileId) throw new NotFoundException('Active profile not found');
    return envelope.data.isKids === true;
  }

  async listPublic(query: {
    page?: number; pageSize?: number; q?: string; genre?: string; country?: string; year?: number;
    type?: MovieKind; contentKind?: 'film' | 'animation' | 'show'; sourceType?: 'owned' | 'third_party';
    provider?: string; sort?: 'newest' | 'rating' | 'title'; profileId?: string;
  }, userId: string | undefined, requestId: string) {
    const isKids = await this.profileFilter(query.profileId, userId, requestId);
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const pageSize = Math.min(50, Math.max(1, Math.trunc(query.pageSize ?? 20)));
    const values: unknown[] = [];
    const predicates = [`m.status='published'`];
    const bind = (value: unknown): string => { values.push(value); return `$${values.length}`; };
    if (isKids) predicates.push(`m.is_kids_safe=true`);
    if (query.q?.trim()) { const parameter = bind(`%${query.q.trim().slice(0, 100)}%`); predicates.push(`(m.title ILIKE ${parameter} OR COALESCE(m.origin_title,'') ILIKE ${parameter})`); }
    if (query.genre) { const parameter = bind(query.genre); predicates.push(`EXISTS(SELECT 1 FROM movie_genres mg JOIN genres g ON g.id=mg.genre_id WHERE mg.movie_id=m.id AND g.slug=${parameter})`); }
    if (query.country) { const parameter = bind(query.country); predicates.push(`EXISTS(SELECT 1 FROM movie_countries mc JOIN countries c ON c.id=mc.country_id WHERE mc.movie_id=m.id AND c.slug=${parameter})`); }
    if (query.year !== undefined) predicates.push(`m.release_year=${bind(query.year)}`);
    if (query.type) predicates.push(`m.type=${bind(query.type)}`);
    if (query.contentKind) predicates.push(`m.content_kind=${bind(query.contentKind)}`);
    if (query.sourceType) predicates.push(`EXISTS(SELECT 1 FROM content_sources cs WHERE cs.movie_id=m.id AND cs.source_type=${bind(query.sourceType)})`);
    if (query.provider) predicates.push(`EXISTS(SELECT 1 FROM content_sources cs WHERE cs.movie_id=m.id AND cs.provider=${bind(query.provider)})`);
    const where = predicates.join(' AND ');
    const sort = query.sort === 'rating' ? 'm.average_rating DESC, m.id ASC'
      : query.sort === 'title' ? 'lower(m.title) ASC, m.id ASC' : 'm.published_at DESC NULLS LAST, m.id ASC';
    const countRows = await this.dataSource.query(`SELECT count(*)::int AS total FROM movies m WHERE ${where}`, values) as Array<{ total: number }>;
    const totalItems = Number(countRows[0]?.total ?? 0);
    const rows = await this.dataSource.query(
      `SELECT m.* FROM movies m WHERE ${where} ORDER BY ${sort} LIMIT ${bind(pageSize)} OFFSET ${bind((page - 1) * pageSize)}`,
      values,
    ) as MovieRow[];
    return { items: rows.map(publicMovie), page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) };
  }

  async home(pageSize = 20) {
    const limit = Math.min(50, Math.max(1, pageSize));
    const rows = await this.dataSource.query(
      `SELECT m.* FROM movies m WHERE status='published' ORDER BY published_at DESC NULLS LAST,id ASC LIMIT $1`, [limit],
    ) as MovieRow[];
    const topRated = await this.dataSource.query(
      `SELECT m.* FROM movies m WHERE status='published' ORDER BY average_rating DESC,id ASC LIMIT $1`, [limit],
    ) as MovieRow[];
    return {
      newReleases: { type: 'new_releases', items: rows.map(publicMovie) },
      topRated: { type: 'top_rated', items: topRated.map(publicMovie) },
      trending: { type: 'fallback_new_releases', items: rows.map(publicMovie) },
    };
  }

  async detail(movieId: string, profileId: string | undefined, userId: string | undefined, requestId: string) {
    const isKids = await this.profileFilter(profileId, userId, requestId);
    const rows = await this.dataSource.query(
      `SELECT * FROM movies WHERE id=$1 AND status='published' AND ($2::boolean=false OR is_kids_safe=true)`, [movieId, isKids],
    ) as MovieRow[];
    const movie = rows[0];
    if (!movie) throw new NotFoundException('Movie not found');
    const [genres, countries, playableItems, sources] = await Promise.all([
      this.dataSource.query(`SELECT g.slug,g.name FROM movie_genres mg JOIN genres g ON g.id=mg.genre_id WHERE mg.movie_id=$1 ORDER BY g.slug`, [movieId]),
      this.dataSource.query(`SELECT c.slug,c.name FROM movie_countries mc JOIN countries c ON c.id=mc.country_id WHERE mc.movie_id=$1 ORDER BY c.slug`, [movieId]),
      this.dataSource.query(`SELECT p.id,p.kind,p.season_id AS "seasonId",s.season_number AS "seasonNumber",p.episode_number AS "episodeNumber",p.label,p.sort_order AS "sortOrder",p.duration_seconds AS "durationSeconds",p.archived_at AS "archivedAt" FROM playable_items p LEFT JOIN seasons s ON s.id=p.season_id WHERE p.movie_id=$1 AND p.archived_at IS NULL ORDER BY p.sort_order,p.id`, [movieId]),
      this.dataSource.query(`SELECT cs.id,cs.source_type AS "sourceType",cs.provider,cs.source_status AS "sourceStatus",si.id AS "sourceItemId",si.playable_id AS "playableId",si.server_key AS "serverKey",si.server_label AS "serverLabel",si.playback_mode AS "playbackMode",si.source_status AS "sourceStatus" FROM content_sources cs LEFT JOIN source_items si ON si.source_id=cs.id AND si.source_status IN ('available','unknown') WHERE cs.movie_id=$1 ORDER BY cs.source_type,cs.provider,si.server_key,si.id`, [movieId]),
    ]);
    return { ...publicMovie(movie), genres, countries, playableItems, sources };
  }

  async createSyncRun(input: { mode: 'discovery' | 'refresh' | 'import'; maxPages?: number; slug?: string; movieId?: string }, requestedBy: string | undefined) {
    const id = randomUUID();
    const maxPages = Math.min(3, Math.max(1, input.maxPages ?? 1));
    const parameters = input.mode === 'import' ? { slug: input.slug, movieId: input.movieId ?? null }
      : input.mode === 'discovery' ? { maxPages } : { batchSize: 30 };
    if (input.mode === 'import' && !input.slug) throw new BadRequestException('slug is required for import');
    await this.dataSource.query(
      `INSERT INTO sync_runs(id,provider,mode,status,requested_by,parameters,checkpoint) VALUES($1,'kkphim',$2,'queued',$3,$4::jsonb,'{}'::jsonb)`,
      [id, input.mode, requestedBy ?? null, JSON.stringify(parameters)],
    );
    return { syncRunId: id, status: 'queued' };
  }

  async searchProvider(keyword: string, page: number): Promise<ProviderSearchPage> {
    return this.provider.search(keyword, page);
  }

  async syncRunList(page = 1, pageSize = 20) {
    const size = Math.min(50, Math.max(1, pageSize));
    const offset = (Math.max(1, page) - 1) * size;
    const rows = await this.dataSource.query(
      `SELECT id,provider,mode,status,parameters,checkpoint,created_count AS "createdCount",updated_count AS "updatedCount",error_count AS "errorCount",last_error_code AS "lastErrorCode",created_at AS "createdAt",started_at AS "startedAt",finished_at AS "finishedAt",attempts FROM sync_runs ORDER BY created_at DESC,id DESC LIMIT $1 OFFSET $2`, [size, offset],
    );
    const counts = await this.dataSource.query(`SELECT count(*)::int AS total FROM sync_runs`) as Array<{ total: number }>;
    return { items: rows, page: Math.max(1, page), pageSize: size, totalItems: Number(counts[0]?.total ?? 0), totalPages: Math.ceil(Number(counts[0]?.total ?? 0) / size) };
  }

  async claimSyncRun(): Promise<Record<string, unknown> | null> {
    const result: unknown = await this.dataSource.query(`
      WITH candidate AS (
        SELECT id FROM sync_runs
        WHERE status='queued' OR (status='running' AND lease_until < now())
        ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      UPDATE sync_runs r SET status='running',started_at=COALESCE(r.started_at,now()),lease_until=now()+interval '2 minutes',attempts=r.attempts+1
      FROM candidate c WHERE r.id=c.id
      RETURNING r.id,r.mode,r.parameters,r.checkpoint,r.created_count,r.updated_count,r.error_count,r.attempts
    `);
    return asRows<Record<string, unknown>>(result)[0] ?? null;
  }

  async runSyncJob(run: Record<string, unknown>): Promise<void> {
    const id = String(run.id);
    try {
      const mode = String(run.mode);
      const parameters = (run.parameters ?? {}) as Record<string, unknown>;
      const checkpoint = (run.checkpoint ?? {}) as Record<string, unknown>;
      let createdCount = Number(run.created_count ?? 0);
      let updatedCount = Number(run.updated_count ?? 0);
      let errorCount = Number(run.error_count ?? 0);
      let lastErrorCode: string | null = null;
      if (mode === 'import') {
        const metadata = await this.provider.fetchMetadata(String(parameters.slug), { fresh: true });
        const result = await this.importMetadata(metadata, text(parameters.movieId, 64), id);
        createdCount += result.created ? 1 : 0;
        updatedCount += result.created ? 0 : 1;
      } else if (mode === 'discovery') {
        const maxPages = Math.min(3, Math.max(1, Number(parameters.maxPages ?? 1)));
        let page = Math.max(1, Number(checkpoint.nextPage ?? 1));
        while (page < Number(checkpoint.startPage ?? 1) + maxPages) {
          const items = await this.provider.discover(page);
          if (items.items.length === 0) break;
          for (const item of items.items) {
            await this.renewRunLease(id, { nextPage: page, lastExternalId: item.externalId });
            try {
              const metadata = await this.provider.fetchMetadata(item.slug, { fresh: true });
              const result = await this.importMetadata(metadata, null, id);
              createdCount += result.created ? 1 : 0;
              updatedCount += result.created ? 0 : 1;
            } catch (error) {
              errorCount += 1;
              lastErrorCode = error instanceof ProviderResponseError ? error.code : error instanceof ConflictException ? 'CATALOG_MAPPING_CONFLICT' : 'IMPORT_ITEM_FAILED';
            }
            await this.renewRunLease(id, { nextPage: page, lastExternalId: item.externalId, processedOnPage: true });
          }
          page += 1;
          await this.renewRunLease(id, { nextPage: page, startPage: Number(checkpoint.startPage ?? 1), lastExternalId: null });
          if (items.totalPages !== null && page > items.totalPages) break;
        }
      } else if (mode === 'refresh') {
        const afterId = text(checkpoint.afterExternalId, 180);
        let sources = await this.dataSource.query(
          `SELECT id,movie_id,external_id,external_slug FROM content_sources WHERE provider='kkphim' AND ($1::text IS NULL OR external_id>$1) ORDER BY external_id LIMIT 30`, [afterId],
        ) as Array<{ id: string; movie_id: string; external_id: string; external_slug: string }>;
        if (sources.length === 0 && afterId) sources = await this.dataSource.query(`SELECT id,movie_id,external_id,external_slug FROM content_sources WHERE provider='kkphim' ORDER BY external_id LIMIT 30`) as Array<{ id: string; movie_id: string; external_id: string; external_slug: string }>;
        for (const source of sources) {
          await this.renewRunLease(id, { afterExternalId: source.external_id });
          try {
            const metadata = await this.provider.fetchMetadata(source.external_slug, { fresh: true });
            const result = await this.importMetadata(metadata, source.movie_id, id);
            updatedCount += result.created ? 0 : 1;
          } catch (error) {
            errorCount += 1;
            lastErrorCode = error instanceof ProviderResponseError ? error.code : 'REFRESH_ITEM_FAILED';
            if (error instanceof ProviderResponseError && error.code === 'PROVIDER_NOT_FOUND') await this.markSourceUnavailable(source.id, source.movie_id, id);
          }
          await this.renewRunLease(id, { afterExternalId: source.external_id });
        }
      }
      const finalStatus = errorCount > 0 ? 'partial' : 'completed';
      await this.dataSource.query(
        `UPDATE sync_runs SET status=$2,created_count=$3,updated_count=$4,error_count=$5,last_error_code=$6,checkpoint=checkpoint||$7::jsonb,finished_at=now(),lease_until=NULL WHERE id=$1`,
        [id, finalStatus, createdCount, updatedCount, errorCount, lastErrorCode, JSON.stringify({ completed: true })],
      );
    } catch (error) {
      const code = error instanceof ProviderResponseError ? error.code : error instanceof ConflictException ? 'CATALOG_MAPPING_CONFLICT' : 'SYNC_RUN_FAILED';
      await this.dataSource.query(`UPDATE sync_runs SET status='failed',last_error_code=$2,finished_at=now(),lease_until=NULL WHERE id=$1`, [id, code]);
    }
  }

  private async renewRunLease(id: string, checkpoint: Record<string, unknown>): Promise<void> {
    await this.dataSource.query(`UPDATE sync_runs SET lease_until=now()+interval '2 minutes',checkpoint=$2::jsonb WHERE id=$1 AND status='running'`, [id, JSON.stringify(checkpoint)]);
  }

  private async markSourceUnavailable(sourceId: string, movieId: string, runId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.query(`UPDATE content_sources SET source_status='unavailable',version=version+1,metadata_checked_at=now(),updated_at=now() WHERE id=$1`, [sourceId]);
      await manager.query(`UPDATE source_items SET source_status='unavailable',version=version+1,updated_at=now() WHERE source_id=$1`, [sourceId]);
      const movies = await manager.query(`SELECT version FROM movies WHERE id=$1`, [movieId]) as Array<{ version: string }>;
      if (movies[0]) await this.writeEvent(manager, 'movie.source.updated', movieId, movies[0].version, runId, { movieId, sourceId, sourceStatus: 'unavailable' });
    });
  }

  private async importMetadata(metadata: ProviderMovieMetadata, targetMovieId: string | null, correlationId: string) {
    return this.dataSource.transaction(async (manager) => {
      const sourceMatches = await manager.query(
        `SELECT * FROM content_sources WHERE provider='kkphim' AND (external_id=$1 OR external_slug=$2) FOR UPDATE`,
        [metadata.externalId, metadata.slug],
      ) as Array<Record<string, unknown>>;
      if (sourceMatches.length > 1 || sourceMatches.some((source) => source.external_id !== metadata.externalId)) {
        throw new ConflictException({ code: 'CATALOG_MAPPING_CONFLICT', message: 'Provider external ID/slug is already attached to a different source' });
      }
      const existingSource = sourceMatches[0];
      const movieId = targetMovieId ?? (existingSource ? String(existingSource.movie_id) : randomUUID());
      if (existingSource && String(existingSource.movie_id) !== movieId) throw new ConflictException({ code: 'CATALOG_MAPPING_CONFLICT', message: 'This provider item is already attached to another movie' });
      const movies = await manager.query(`SELECT * FROM movies WHERE id=$1 FOR UPDATE`, [movieId]) as MovieRow[];
      const current = movies[0];
      if (current && current.type !== metadata.type) throw new ConflictException({ code: 'CATALOG_MAPPING_CONFLICT', message: 'Movie kind does not match provider metadata' });
      const metadataLocked = existingSource?.metadata_locked === true;
      const hasMoviePlayable = metadata.type === 'movie';
      if (hasMoviePlayable && metadata.servers.some((server) => server.episodes.length !== 1)) {
        throw new ConflictException({ code: 'CATALOG_MAPPING_CONFLICT', message: 'A movie server must expose exactly one playable selector' });
      }
      const cleanMetadata = {
        title: metadata.title, originTitle: metadata.originTitle, description: safeDescription(metadata.description),
        posterUrl: metadata.posterUrl, backdropUrl: metadata.backdropUrl, releaseYear: metadata.releaseYear,
        type: metadata.type, contentKind: metadata.contentKind, averageRating: metadata.averageRating,
      };
      let movieChanged: boolean;
      let publishedTransition: boolean;
      if (!current) {
        await manager.query(
          `INSERT INTO movies(id,title,origin_title,description,poster_url,backdrop_url,release_year,type,content_kind,status,average_rating,published_at,version)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'published',$10,now(),1)`,
          [movieId, cleanMetadata.title, cleanMetadata.originTitle, cleanMetadata.description, cleanMetadata.posterUrl, cleanMetadata.backdropUrl, cleanMetadata.releaseYear, cleanMetadata.type, cleanMetadata.contentKind, cleanMetadata.averageRating],
        );
        movieChanged = true;
        publishedTransition = true;
      } else {
        const nextStatus = current.status === 'archived' ? 'archived' : current.status === 'draft' ? 'published' : current.status;
        publishedTransition = current.status === 'draft' && nextStatus === 'published';
        const next = {
          title: metadataLocked ? current.title : cleanMetadata.title,
          originTitle: metadataLocked ? current.origin_title : cleanMetadata.originTitle,
          description: metadataLocked ? current.description : cleanMetadata.description,
          posterUrl: metadataLocked ? current.poster_url : cleanMetadata.posterUrl,
          backdropUrl: metadataLocked ? current.backdrop_url : cleanMetadata.backdropUrl,
          releaseYear: cleanMetadata.releaseYear,
          contentKind: metadataLocked ? current.content_kind : cleanMetadata.contentKind,
          averageRating: cleanMetadata.averageRating,
        };
        movieChanged = current.title !== next.title || current.origin_title !== next.originTitle || current.description !== next.description || current.poster_url !== next.posterUrl || current.backdrop_url !== next.backdropUrl || current.release_year !== next.releaseYear || current.content_kind !== next.contentKind || Number(current.average_rating) !== next.averageRating || current.status !== nextStatus;
        if (movieChanged) {
          const version = String(BigInt(current.version) + 1n);
          await manager.query(
            `UPDATE movies SET title=$2,origin_title=$3,description=$4,poster_url=$5,backdrop_url=$6,release_year=$7,content_kind=$8,average_rating=$9,status=$10,published_at=CASE WHEN $10='published' THEN COALESCE(published_at,now()) ELSE published_at END,version=$11,updated_at=now() WHERE id=$1`,
            [movieId, next.title, next.originTitle, next.description, next.posterUrl, next.backdropUrl, next.releaseYear, next.contentKind, next.averageRating, nextStatus, version],
          );
        }
      }
      let sourceId: string;
      let sourceIdentityChanged = !existingSource;
      if (!existingSource) {
        sourceId = randomUUID();
        await manager.query(
          `INSERT INTO content_sources(id,movie_id,source_type,provider,external_id,external_slug,external_updated_at,source_status,metadata_checked_at,version)
           VALUES($1,$2,'third_party','kkphim',$3,$4,$5,'unknown',now(),1)`,
          [sourceId, movieId, metadata.externalId, metadata.slug, metadata.externalUpdatedAt],
        );
      } else {
        sourceId = String(existingSource.id);
        sourceIdentityChanged = String(existingSource.external_slug) !== metadata.slug
          || (existingSource.external_updated_at ? new Date(String(existingSource.external_updated_at)).toISOString() : null) !== metadata.externalUpdatedAt;
        await manager.query(
          `UPDATE content_sources SET external_slug=$2,external_updated_at=$3,metadata_checked_at=now(),version=version+CASE WHEN $4 THEN 1 ELSE 0 END,updated_at=now() WHERE id=$1`,
          [sourceId, metadata.slug, metadata.externalUpdatedAt, sourceIdentityChanged],
        );
      }
      if (!metadataLocked) await this.syncTaxonomies(manager, movieId, metadata);
      const sourceSync = await this.syncPlayablesAndSourceItems(manager, movieId, sourceId, metadata);
      const versionRows = await manager.query(`SELECT version,status FROM movies WHERE id=$1`, [movieId]) as Array<{ version: string; status: string }>;
      const version = versionRows[0]?.version ?? '1';
      if (publishedTransition) await this.writeEvent(manager, 'movie.published', movieId, version, correlationId, { movieId, version });
      else if (movieChanged) await this.writeEvent(manager, 'movie.updated', movieId, version, correlationId, { movieId, version });
      if (sourceSync.changed || sourceIdentityChanged) {
        await this.writeEvent(manager, 'movie.source.updated', movieId, version, correlationId, { movieId, sourceId, sourceStatus: sourceSync.sourceStatus });
      }
      return { movieId, sourceId, created: !current };
    });
  }

  private async syncTaxonomies(manager: EntityManager, movieId: string, metadata: ProviderMovieMetadata): Promise<void> {
    await manager.query(`DELETE FROM movie_genres WHERE movie_id=$1`, [movieId]);
    await manager.query(`DELETE FROM movie_countries WHERE movie_id=$1`, [movieId]);
    for (const genre of metadata.genres) {
      const id = randomUUID();
      await manager.query(`INSERT INTO genres(id,slug,name) VALUES($1,$2,$3) ON CONFLICT(slug) DO UPDATE SET name=EXCLUDED.name`, [id, genre.slug, genre.name]);
      await manager.query(`INSERT INTO movie_genres(movie_id,genre_id) SELECT $1,id FROM genres WHERE slug=$2 ON CONFLICT DO NOTHING`, [movieId, genre.slug]);
    }
    for (const country of metadata.countries) {
      await manager.query(`INSERT INTO countries(id,slug,name) VALUES($1,$2,$3) ON CONFLICT(slug) DO UPDATE SET name=EXCLUDED.name`, [randomUUID(), country.slug, country.name]);
      await manager.query(`INSERT INTO movie_countries(movie_id,country_id) SELECT $1,id FROM countries WHERE slug=$2 ON CONFLICT DO NOTHING`, [movieId, country.slug]);
    }
  }

  private async syncPlayablesAndSourceItems(manager: EntityManager, movieId: string, sourceId: string, metadata: ProviderMovieMetadata): Promise<{ changed: boolean; sourceStatus: SourceState }> {
    let changed = false;
    let seasonId: string | null = null;
    if (metadata.type === 'series') {
      const seasons = await manager.query(`SELECT id FROM seasons WHERE movie_id=$1 AND season_number=1 FOR UPDATE`, [movieId]) as Array<{ id: string }>;
      seasonId = seasons[0]?.id ?? randomUUID();
      if (!seasons[0]) await manager.query(`INSERT INTO seasons(id,movie_id,season_number,is_synthetic) VALUES($1,$2,1,true)`, [seasonId, movieId]);
    }
    const moviePlayableRows = metadata.type === 'movie'
      ? await manager.query(`SELECT id FROM playable_items WHERE movie_id=$1 AND kind='movie' FOR UPDATE`, [movieId]) as Array<{ id: string }>
      : [];
    const moviePlayableId = metadata.type === 'movie' ? moviePlayableRows[0]?.id ?? randomUUID() : null;
    if (metadata.type === 'movie' && !moviePlayableRows[0]) {
      await manager.query(`INSERT INTO playable_items(id,movie_id,kind,label,sort_order,duration_seconds) VALUES($1,$2,'movie','Full',0,$3)`, [moviePlayableId, movieId, metadata.durationSeconds]);
      changed = true;
    }
    const grouped = new Map<string, string>();
    for (const server of metadata.servers) {
      for (let index = 0; index < server.episodes.length; index += 1) {
        const episode = server.episodes[index];
        let playableId = moviePlayableId;
        if (metadata.type === 'series') {
          const identity = episodeIdentity(server, index, episode.label, episode.episodeNumber);
          const groupMatch = grouped.get(identity);
          const previousSelector = await manager.query(
            `SELECT playable_id FROM source_items WHERE source_id=$1 AND server_key=$2 AND external_episode_key=$3 LIMIT 1`,
            [sourceId, server.serverKey, episode.selectorKey],
          ) as Array<{ playable_id: string }>;
          const previousPlayableId = previousSelector[0]?.playable_id;
          const numbered = episode.episodeNumber === null ? [] : await manager.query(
            `SELECT id FROM playable_items WHERE movie_id=$1 AND season_id=$2 AND episode_number=$3 FOR UPDATE`,
            [movieId, seasonId, episode.episodeNumber],
          ) as Array<{ id: string }>;
          const special = episode.episodeNumber === null ? await manager.query(
            `SELECT id FROM playable_items WHERE movie_id=$1 AND season_id=$2 AND episode_number IS NULL AND lower(label)=lower($3) ORDER BY id LIMIT 1 FOR UPDATE`,
            [movieId, seasonId, episode.label],
          ) as Array<{ id: string }> : [];
          playableId = groupMatch ?? previousPlayableId ?? numbered[0]?.id ?? special[0]?.id ?? randomUUID();
          const priorGroup = groupMatch ?? (numbered[0]?.id ?? special[0]?.id);
          if (previousPlayableId && priorGroup && previousPlayableId !== priorGroup) throw new ConflictException({ code: 'CATALOG_MAPPING_CONFLICT', message: 'Provider episode now maps to a different playable item' });
          if (!groupMatch) grouped.set(identity, playableId);
          const playableExists = await manager.query(`SELECT 1 FROM playable_items WHERE id=$1`, [playableId]) as unknown[];
          if (playableExists.length === 0) {
            await manager.query(
              `INSERT INTO playable_items(id,movie_id,kind,season_id,episode_number,label,sort_order,duration_seconds) VALUES($1,$2,'episode',$3,$4,$5,$6,$7)`,
              [playableId, movieId, seasonId, episode.episodeNumber, episode.label, (episode.episodeNumber ?? index + 1) * 100, metadata.durationSeconds],
            );
            changed = true;
          }
        }
        if (!playableId) throw new ConflictException({ code: 'CATALOG_MAPPING_CONFLICT', message: 'Provider episode has no playable mapping' });
        const playbackMode = episode.hasHls ? 'external_hls' : episode.hasEmbed ? 'external_embed' : 'metadata_only';
        const sourceStatus: SourceState = episode.hasHls || episode.hasEmbed ? 'available' : 'unknown';
        const existing = await manager.query(`SELECT id,playable_id,external_episode_key,external_episode_slug,playback_mode,source_status FROM source_items WHERE source_id=$1 AND server_key=$2 AND playable_id=$3 FOR UPDATE`, [sourceId, server.serverKey, playableId]) as Array<Record<string, unknown>>;
        const conflictingSelector = await manager.query(`SELECT id FROM source_items WHERE source_id=$1 AND server_key=$2 AND external_episode_key=$3 AND playable_id<>$4`, [sourceId, server.serverKey, episode.selectorKey, playableId]) as unknown[];
        if (conflictingSelector.length) throw new ConflictException({ code: 'CATALOG_MAPPING_CONFLICT', message: 'Provider selector is already mapped to another episode on this server' });
        if (!existing[0]) {
          await manager.query(
            `INSERT INTO source_items(id,movie_id,source_id,playable_id,server_key,server_label,external_episode_key,external_episode_slug,playback_mode,source_status)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [randomUUID(), movieId, sourceId, playableId, server.serverKey, server.serverLabel, episode.selectorKey, episode.selectorSlug, playbackMode, sourceStatus],
          );
          changed = true;
        } else {
          const row = existing[0];
          const differs = row.external_episode_key !== episode.selectorKey || row.external_episode_slug !== episode.selectorSlug || row.playback_mode !== playbackMode || row.source_status !== sourceStatus || row.server_label !== server.serverLabel;
          if (differs) {
            await manager.query(
              `UPDATE source_items SET server_label=$2,external_episode_key=$3,external_episode_slug=$4,playback_mode=$5,source_status=$6,version=version+1,updated_at=now() WHERE id=$1`,
              [row.id, server.serverLabel, episode.selectorKey, episode.selectorSlug, playbackMode, sourceStatus],
            );
            changed = true;
          }
        }
      }
    }
    const current = await manager.query(`SELECT source_status FROM content_sources WHERE id=$1`, [sourceId]) as Array<{ source_status: SourceState }>;
    const sourceState: SourceState = metadata.servers.some((server) => server.episodes.some((episode) => episode.hasHls || episode.hasEmbed)) ? 'available' : 'unknown';
    const sourceChanged = current[0]?.source_status !== sourceState;
    await manager.query(`UPDATE content_sources SET source_status=$2,metadata_checked_at=now(),version=CASE WHEN $3 OR $4 THEN version+1 ELSE version END,updated_at=now() WHERE id=$1`, [sourceId, sourceState, changed, sourceChanged]);
    return { changed: changed || sourceChanged, sourceStatus: sourceState };
  }

  private async writeEvent(manager: EntityManager, eventType: MovieEvent, movieId: string, version: string | number, correlationId: string, payload: Record<string, unknown>): Promise<void> {
    const now = new Date();
    const envelope: EventEnvelope<Record<string, unknown>> = {
      eventId: randomUUID(), eventType, schemaVersion: 1, aggregateId: movieId,
      aggregateVersion: String(version), occurredAt: now.toISOString(), producer: 'catalog-service', correlationId, payload,
    };
    await manager.query(
      `INSERT INTO outbox_events(event_id,event_type,aggregate_id,aggregate_version,occurred_at,envelope) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
      [envelope.eventId, eventType, movieId, String(version), now, JSON.stringify(envelope)],
    );
  }

  async createMovie(input: Record<string, unknown>) {
    const id = randomUUID();
    const title = text(input.title, 300);
    if (!title) throw new BadRequestException('title is required');
    const type = input.type === 'series' ? 'series' : input.type === 'movie' ? 'movie' : null;
    if (!type) throw new BadRequestException('type must be movie or series');
    const contentKind = ['film', 'animation', 'show'].includes(String(input.contentKind)) ? String(input.contentKind) : 'film';
    await this.dataSource.query(
      `INSERT INTO movies(id,title,origin_title,description,poster_url,backdrop_url,release_year,type,content_kind,status,access_tier,is_kids_safe,average_rating)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10,$11,$12)`,
      [id, title, text(input.originTitle, 300), safeDescription(text(input.description, 20_000)), this.validImage(input.posterUrl), this.validImage(input.backdropUrl), this.validYear(input.releaseYear), type, contentKind, input.accessTier === 'subscription' ? 'subscription' : 'free', input.isKidsSafe === true, this.validRating(input.averageRating)],
    );
    return { movieId: id, status: 'draft' };
  }

  async adminMovies(page = 1, pageSize = 20, status?: string) {
    const size = Math.min(50, Math.max(1, pageSize));
    const offset = (Math.max(1, page) - 1) * size;
    const rows = await this.dataSource.query(`SELECT * FROM movies WHERE ($1::text IS NULL OR status=$1) ORDER BY created_at DESC,id LIMIT $2 OFFSET $3`, [status ?? null, size, offset]) as MovieRow[];
    const count = await this.dataSource.query(`SELECT count(*)::int AS total FROM movies WHERE ($1::text IS NULL OR status=$1)`, [status ?? null]) as Array<{ total: number }>;
    const totalItems = Number(count[0]?.total ?? 0);
    return { items: rows.map(publicMovie), page: Math.max(1, page), pageSize: size, totalItems, totalPages: Math.ceil(totalItems / size) };
  }

  async patchMovie(movieId: string, input: Record<string, unknown>) {
    const fields: Array<[string, unknown]> = [];
    const map: Record<string, string> = { title: 'title', originTitle: 'origin_title', description: 'description', posterUrl: 'poster_url', backdropUrl: 'backdrop_url', releaseYear: 'release_year', contentKind: 'content_kind', accessTier: 'access_tier', isKidsSafe: 'is_kids_safe', averageRating: 'average_rating' };
    for (const [key, column] of Object.entries(map)) {
      if (!(key in input) || input[key] === undefined) continue;
      let value: unknown = input[key];
      if (key === 'title') value = text(value, 300);
      if (key === 'originTitle') value = text(value, 300);
      if (key === 'description') value = safeDescription(text(value, 20_000));
      if (key === 'posterUrl' || key === 'backdropUrl') value = this.validImage(value);
      if (key === 'releaseYear') value = this.validYear(value);
      if (key === 'contentKind' && !['film', 'animation', 'show'].includes(String(value))) throw new BadRequestException('contentKind is invalid');
      if (key === 'accessTier' && !['free', 'subscription'].includes(String(value))) throw new BadRequestException('accessTier is invalid');
      if (key === 'averageRating') value = this.validRating(value);
      if (key === 'isKidsSafe' && typeof value !== 'boolean') throw new BadRequestException('isKidsSafe must be boolean');
      if (key === 'title' && !value) throw new BadRequestException('title cannot be empty');
      fields.push([column, value]);
    }
    if (fields.length === 0) throw new BadRequestException('At least one editable field is required');
    const row = await this.dataSource.transaction(async (manager) => {
        const current = await manager.query(`SELECT * FROM movies WHERE id=$1 FOR UPDATE`, [movieId]) as MovieRow[];
        if (!current[0]) throw new NotFoundException('Movie not found');
        if (current[0].status === 'archived') throw new ConflictException('Archived movie cannot be edited until restored');
        const set = fields.map(([column], index) => `${column}=$${index + 2}`).join(',');
        const values = fields.map(([, value]) => value);
        const updated = asRows<MovieRow>(await manager.query(`UPDATE movies SET ${set},version=version+1,updated_at=now() WHERE id=$1 RETURNING *`, [movieId, ...values]));
        await this.writeEvent(manager, 'movie.updated', movieId, updated[0].version, movieId, { movieId, version: updated[0].version });
        return updated[0];
      });
    return publicMovie(row);
  }

  async publish(movieId: string) {
    return this.dataSource.transaction(async (manager) => {
      const movies = await manager.query(`SELECT * FROM movies WHERE id=$1 FOR UPDATE`, [movieId]) as MovieRow[];
      const movie = movies[0];
      if (!movie) throw new NotFoundException('Movie not found');
      if (movie.status === 'archived') throw new ConflictException('Archived movie cannot be published');
      if (movie.status === 'published') return { movieId, status: 'published', version: movie.version };
      const playable = await manager.query(`SELECT 1 FROM playable_items p JOIN source_items si ON si.playable_id=p.id WHERE p.movie_id=$1 AND p.archived_at IS NULL AND si.source_status='available' LIMIT 1`, [movieId]) as unknown[];
      if (playable.length === 0) throw new ConflictException({ code: 'MOVIE_NOT_READY', message: 'At least one playable source item must be available before publishing' });
      const updated = asRows<{ version: string }>(await manager.query(`UPDATE movies SET status='published',published_at=now(),version=version+1,updated_at=now() WHERE id=$1 RETURNING version`, [movieId]));
      await this.writeEvent(manager, 'movie.published', movieId, updated[0].version, movieId, { movieId, version: updated[0].version });
      return { movieId, status: 'published', version: updated[0].version };
    });
  }

  async archive(movieId: string) {
    return this.dataSource.transaction(async (manager) => {
      const rows = await manager.query(`SELECT * FROM movies WHERE id=$1 FOR UPDATE`, [movieId]) as MovieRow[];
      const movie = rows[0];
      if (!movie) throw new NotFoundException('Movie not found');
      if (movie.status === 'archived') return { movieId, status: 'archived', version: movie.version };
      const updated = asRows<{ version: string }>(await manager.query(`UPDATE movies SET status='archived',version=version+1,updated_at=now() WHERE id=$1 RETURNING version`, [movieId]));
      await this.writeEvent(manager, 'movie.archived', movieId, updated[0].version, movieId, { movieId, version: updated[0].version });
      return { movieId, status: 'archived', version: updated[0].version };
    });
  }

  async addSeason(movieId: string, seasonNumber: number, isSynthetic = false) {
    const movies = await this.dataSource.query(`SELECT type FROM movies WHERE id=$1`, [movieId]) as Array<{ type: MovieKind }>;
    if (!movies[0]) throw new NotFoundException('Movie not found');
    if (movies[0].type !== 'series') throw new ConflictException('Seasons can only be added to a series');
    if (!Number.isSafeInteger(seasonNumber) || seasonNumber <= 0) throw new BadRequestException('seasonNumber must be positive');
    const id = randomUUID();
    await this.dataSource.query(`INSERT INTO seasons(id,movie_id,season_number,is_synthetic) VALUES($1,$2,$3,$4) ON CONFLICT(movie_id,season_number) DO NOTHING`, [id, movieId, seasonNumber, isSynthetic]);
    const rows = await this.dataSource.query(`SELECT id,movie_id AS "movieId",season_number AS "seasonNumber",is_synthetic AS "isSynthetic" FROM seasons WHERE movie_id=$1 AND season_number=$2`, [movieId, seasonNumber]);
    return rows[0];
  }

  async addPlayable(movieId: string, input: Record<string, unknown>) {
    const movies = await this.dataSource.query(`SELECT type FROM movies WHERE id=$1`, [movieId]) as Array<{ type: MovieKind }>;
    if (!movies[0]) throw new NotFoundException('Movie not found');
    const kind = input.kind === 'movie' || input.kind === 'episode' ? input.kind : null;
    if (!kind || (kind === 'movie') !== (movies[0].type === 'movie')) throw new ConflictException('Playable kind does not match movie type');
    let seasonId: string | null = null;
    if (kind === 'episode') {
      const season = await this.dataSource.query(`SELECT id FROM seasons WHERE id=$1 AND movie_id=$2`, [input.seasonId, movieId]) as Array<{ id: string }>;
      if (!season[0]) throw new BadRequestException('seasonId must belong to this movie');
      seasonId = season[0].id;
    }
    const label = text(input.label, 200);
    if (!label) throw new BadRequestException('label is required');
    const id = randomUUID();
    await this.dataSource.query(`INSERT INTO playable_items(id,movie_id,kind,season_id,episode_number,label,sort_order,duration_seconds) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id, movieId, kind, seasonId, kind === 'episode' ? this.validEpisodeNumber(input.episodeNumber) : null, label, Number.isInteger(input.sortOrder) ? input.sortOrder : 0, this.validDuration(input.durationSeconds)]);
    return { id, movieId, kind, seasonId, label };
  }

  async addContentSource(movieId: string, input: Record<string, unknown>) {
    const exists = await this.dataSource.query(`SELECT 1 FROM movies WHERE id=$1`, [movieId]) as unknown[];
    if (!exists.length) throw new NotFoundException('Movie not found');
    const sourceType = input.sourceType === 'owned' || input.sourceType === 'third_party' ? input.sourceType : null;
    if (!sourceType) throw new BadRequestException('sourceType is invalid');
    const provider = sourceType === 'owned' ? null : text(input.provider, 80);
    const externalId = sourceType === 'owned' ? null : text(input.externalId, 200);
    const externalSlug = sourceType === 'owned' ? null : text(input.externalSlug, 200);
    if (sourceType === 'third_party' && (!provider || !externalId || !externalSlug)) throw new BadRequestException('third-party source requires provider, externalId and externalSlug');
    const id = randomUUID();
    await this.dataSource.query(`INSERT INTO content_sources(id,movie_id,source_type,provider,external_id,external_slug,metadata_locked,source_status) VALUES($1,$2,$3,$4,$5,$6,$7,'unknown')`, [id, movieId, sourceType, provider, externalId, externalSlug, input.metadataLocked === true]);
    return { id, movieId, sourceType, provider, sourceStatus: 'unknown' };
  }

  async addSourceItem(sourceId: string, input: Record<string, unknown>) {
    const sourceRows = await this.dataSource.query(`SELECT * FROM content_sources WHERE id=$1`, [sourceId]) as Array<Record<string, unknown>>;
    const source = sourceRows[0];
    if (!source) throw new NotFoundException('Content source not found');
    const playable = await this.dataSource.query(`SELECT id FROM playable_items WHERE id=$1 AND movie_id=$2`, [input.playableId, source.movie_id]) as Array<{ id: string }>;
    if (!playable.length) throw new ConflictException('Playable item and source must belong to the same movie');
    const playbackMode = input.playbackMode;
    if (source.source_type === 'owned' && playbackMode !== 'owned_hls') throw new BadRequestException('owned sources require owned_hls mode');
    if (source.source_type === 'third_party' && !['external_hls', 'external_embed', 'metadata_only'].includes(String(playbackMode))) throw new BadRequestException('third-party playback mode is invalid');
    const serverKey = text(input.serverKey, 100);
    const serverLabel = text(input.serverLabel, 200);
    if (!serverKey || !serverLabel) throw new BadRequestException('serverKey and serverLabel are required');
    const externalEpisodeKey = source.source_type === 'owned' ? null : text(input.externalEpisodeKey, 200);
    const externalEpisodeSlug = source.source_type === 'owned' ? null : text(input.externalEpisodeSlug, 200);
    if (source.source_type === 'third_party' && !externalEpisodeKey) throw new BadRequestException('third-party selectors require externalEpisodeKey');
    const id = randomUUID();
    const initialStatus = source.source_type === 'owned' ? 'unknown' : input.sourceStatus === 'available' ? 'available' : 'unknown';
    await this.dataSource.query(`INSERT INTO source_items(id,movie_id,source_id,playable_id,server_key,server_label,external_episode_key,external_episode_slug,playback_mode,source_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, source.movie_id, source.id, input.playableId, serverKey, serverLabel, externalEpisodeKey, externalEpisodeSlug, playbackMode, initialStatus]);
    return { id, movieId: source.movie_id, sourceId: source.id, playableId: input.playableId, serverKey, playbackMode };
  }

  async patchSourceItem(sourceItemId: string, input: Record<string, unknown>, actorId: string | undefined, requestId: string) {
    return this.dataSource.transaction(async (manager) => {
      const rows = await manager.query(`SELECT * FROM source_items WHERE id=$1 FOR UPDATE`, [sourceItemId]) as Array<Record<string, unknown>>;
      const current = rows[0];
      if (!current) throw new NotFoundException('Source item not found');
      if (input.playableId !== undefined && input.playableId !== current.playable_id) throw new ConflictException('Mapping edits preserve playableId; create a new source item for a different playable');
      const serverKey = input.serverKey === undefined ? current.server_key : text(input.serverKey, 100);
      const serverLabel = input.serverLabel === undefined ? current.server_label : text(input.serverLabel, 200);
      const externalEpisodeKey = input.externalEpisodeKey === undefined ? current.external_episode_key : text(input.externalEpisodeKey, 200);
      const externalEpisodeSlug = input.externalEpisodeSlug === undefined ? current.external_episode_slug : text(input.externalEpisodeSlug, 200);
      const before = { movieId: current.movie_id, sourceId: current.source_id, playableId: current.playable_id, serverKey: current.server_key, externalEpisodeKey: current.external_episode_key, externalEpisodeSlug: current.external_episode_slug };
      await manager.query(`UPDATE source_items SET server_key=$2,server_label=$3,external_episode_key=$4,external_episode_slug=$5,version=version+1,updated_at=now() WHERE id=$1`, [sourceItemId, serverKey, serverLabel, externalEpisodeKey, externalEpisodeSlug]);
      const after = { ...before, serverKey, externalEpisodeKey, externalEpisodeSlug };
      const auditId = randomUUID();
      await manager.query(`INSERT INTO catalog_audit_logs(id,actor_id,action,movie_id,source_item_id,before_state,after_state,request_id) VALUES($1,$2,'source_item.mapping.updated',$3,$4,$5::jsonb,$6::jsonb,$7)`, [auditId, actorId ?? null, current.movie_id, sourceItemId, JSON.stringify(before), JSON.stringify(after), requestId]);
      const updated = await manager.query(`SELECT id,movie_id AS "movieId",source_id AS "sourceId",playable_id AS "playableId",server_key AS "serverKey",server_label AS "serverLabel",external_episode_key AS "externalEpisodeKey",external_episode_slug AS "externalEpisodeSlug",version FROM source_items WHERE id=$1`, [sourceItemId]);
      return updated[0];
    });
  }

  async metadataLock(sourceId: string, locked: boolean) {
    const rows = asRows<Record<string, unknown>>(await this.dataSource.query(`UPDATE content_sources SET metadata_locked=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING id,movie_id AS "movieId",metadata_locked AS "metadataLocked",version`, [sourceId, locked]));
    if (!rows[0]) throw new NotFoundException('Content source not found');
    return rows[0];
  }

  private validImage(value: unknown): string | null {
    if (value === null || value === undefined || value === '') return null;
    const candidate = text(value, 2_000);
    if (!candidate) throw new BadRequestException('Image URL is invalid');
    let url: URL;
    try { url = new URL(candidate); } catch { throw new BadRequestException('Image URL must be absolute'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new BadRequestException('Image URL is invalid');
    return url.toString();
  }
  private validYear(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1800 || number > 2200) throw new BadRequestException('releaseYear is invalid');
    return number;
  }
  private validRating(value: unknown): number {
    if (value === null || value === undefined || value === '') return 0;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > 10) throw new BadRequestException('averageRating must be between 0 and 10');
    return Math.round(number * 10) / 10;
  }
  private validEpisodeNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) throw new BadRequestException('episodeNumber must be a positive integer or null for a special');
    return number;
  }
  private validDuration(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) throw new BadRequestException('durationSeconds must be positive');
    return number;
  }
}
