import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CatalogQueryDto } from './catalog.dto';
import { CatalogConfig, CATALOG_CONFIG } from './catalog.config';
import { Inject } from '@nestjs/common';
import { CatalogService } from './catalog.service';

interface SearchHit { _id: string }
interface SearchResponse { hits?: { total?: { value?: number }; hits?: SearchHit[] } }
interface BulkResponse { errors?: boolean; items?: Array<{ index?: { status?: number } }> }

const INDEX = 'movieapp_catalog_v1';

@Injectable()
export class CatalogSearchService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CATALOG_CONFIG) private readonly config: CatalogConfig,
    private readonly catalog: CatalogService,
  ) {}

  async ensureIndex(): Promise<void> {
    const exists = await this.request('HEAD', `/${INDEX}`);
    if (exists.status === 200) return;
    if (exists.status !== 404) throw new Error(`OpenSearch index check returned ${exists.status}`);
    const created = await this.request('PUT', `/${INDEX}`, {
      settings: { analysis: { normalizer: { lowercase_normalizer: { type: 'custom', filter: ['lowercase', 'asciifolding'] } }, analyzer: { vi_text: { type: 'custom', tokenizer: 'standard', filter: ['lowercase', 'asciifolding'] } } } },
      mappings: { properties: {
        id: { type: 'keyword' }, title: { type: 'text', analyzer: 'vi_text', fields: { sort: { type: 'keyword', normalizer: 'lowercase_normalizer' } } },
        originTitle: { type: 'text', analyzer: 'vi_text' }, genreSlugs: { type: 'keyword' }, countrySlugs: { type: 'keyword' },
        sourceTypes: { type: 'keyword' }, providers: { type: 'keyword' }, type: { type: 'keyword' }, contentKind: { type: 'keyword' },
        releaseYear: { type: 'integer' }, averageRating: { type: 'float' }, publishedAt: { type: 'date' }, isKidsSafe: { type: 'boolean' }, version: { type: 'long' },
      } },
    });
    if (!created.ok && created.status !== 400) throw new Error(`OpenSearch index creation returned ${created.status}`);
  }

  async search(query: CatalogQueryDto, isKids: boolean) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const filters: Array<Record<string, unknown>> = [{ term: { status: 'published' } }];
    if (isKids) filters.push({ term: { isKidsSafe: true } });
    if (query.genre) filters.push({ term: { genreSlugs: query.genre } });
    if (query.country) filters.push({ term: { countrySlugs: query.country } });
    if (query.year) filters.push({ term: { releaseYear: query.year } });
    if (query.type) filters.push({ term: { type: query.type } });
    if (query.contentKind) filters.push({ term: { contentKind: query.contentKind } });
    if (query.sourceType) filters.push({ term: { sourceTypes: query.sourceType } });
    if (query.provider) filters.push({ term: { providers: query.provider } });
    const sort = query.sort === 'rating' ? [{ averageRating: 'desc' }, { id: 'asc' }]
      : query.sort === 'title' ? [{ 'title.sort': 'asc' }, { id: 'asc' }]
        : [{ publishedAt: 'desc' }, { id: 'asc' }];
    const response = await this.request('POST', `/${INDEX}/_search`, {
      from: 0, size: 10_000, track_total_hits: true, sort,
      query: { bool: { filter: filters, must: [{ multi_match: { query: query.q?.trim().slice(0, 100), fields: ['title^3', 'originTitle'], operator: 'and' } }] } },
    });
    if (!response.ok) throw new ServiceUnavailableException('Search service unavailable');
    const body = await response.json() as SearchResponse;
    const ids = body.hits?.hits?.map((hit) => hit._id) ?? [];
    const fresh = [] as Array<{ movieId: string; movie: Record<string, unknown> | null; tombstone: boolean }>;
    for (let start = 0; start < ids.length; start += 100) fresh.push(...await this.catalog.batchMovies(ids.slice(start, start + 100), isKids, false));
    const movies = new Map<string, Record<string, unknown>>(fresh.flatMap((entry) => entry.movie ? [[entry.movieId, entry.movie] as const] : []));
    const allItems = ids.flatMap((id) => {
      const movie = movies.get(id);
      return movie ? [movie] : [];
    });
    const items = allItems.slice((page - 1) * pageSize, page * pageSize);
    const totalItems = allItems.length;
    return { items, page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) };
  }

  async indexCurrentMovie(movieId: string): Promise<void> {
    const rows = await this.dataSource.query(`
      SELECT m.id,m.title,m.origin_title,m.type,m.content_kind,m.release_year,m.average_rating,m.published_at,m.is_kids_safe,m.status,m.version,
        COALESCE((SELECT array_agg(g.slug ORDER BY g.slug) FROM movie_genres mg JOIN genres g ON g.id=mg.genre_id WHERE mg.movie_id=m.id), ARRAY[]::text[]) AS genres,
        COALESCE((SELECT array_agg(c.slug ORDER BY c.slug) FROM movie_countries mc JOIN countries c ON c.id=mc.country_id WHERE mc.movie_id=m.id), ARRAY[]::text[]) AS countries,
        COALESCE((SELECT array_agg(DISTINCT cs.source_type ORDER BY cs.source_type) FROM content_sources cs WHERE cs.movie_id=m.id), ARRAY[]::text[]) AS source_types,
        COALESCE((SELECT array_agg(DISTINCT cs.provider ORDER BY cs.provider) FILTER (WHERE cs.provider IS NOT NULL) FROM content_sources cs WHERE cs.movie_id=m.id), ARRAY[]::text[]) AS providers
      FROM movies m WHERE m.id=$1
    `, [movieId]) as Array<Record<string, unknown>>;
    const row = rows[0];
    if (!row || row.status !== 'published') {
      const deleted = await this.request('DELETE', `/${INDEX}/_doc/${encodeURIComponent(movieId)}`);
      if (!deleted.ok && deleted.status !== 404) throw new Error(`OpenSearch delete returned ${deleted.status}`);
      return;
    }
    const indexed = await this.request('PUT', `/${INDEX}/_doc/${encodeURIComponent(movieId)}`, {
      id: row.id, title: row.title, originTitle: row.origin_title, type: row.type, contentKind: row.content_kind,
      releaseYear: row.release_year, averageRating: Number(row.average_rating), publishedAt: row.published_at,
      isKidsSafe: row.is_kids_safe, status: row.status, version: Number(row.version), genreSlugs: row.genres,
      countrySlugs: row.countries, sourceTypes: row.source_types, providers: row.providers,
    });
    if (!indexed.ok) throw new Error(`OpenSearch index write returned ${indexed.status}`);
  }

  async reindexPublished(): Promise<void> {
    const movies = await this.dataSource.query(`SELECT id FROM movies WHERE status='published' ORDER BY id`) as Array<{ id: string }>;
    for (let start = 0; start < movies.length; start += 200) {
      const ids = movies.slice(start, start + 200).map((movie) => movie.id);
      const rows = await this.indexRows(ids);
      const lines = rows.flatMap((row) => [
        JSON.stringify({ index: { _index: INDEX, _id: row.id } }),
        JSON.stringify(this.searchDocument(row)),
      ]).join('\n');
      if (!lines) continue;
      const response = await this.bulkRequest(`${lines}\n`);
      if (!response.ok) throw new Error(`OpenSearch bulk index returned ${response.status}`);
      const body = await response.json() as BulkResponse;
      if (body.errors || body.items?.some((item) => (item.index?.status ?? 500) >= 300)) throw new Error('OpenSearch bulk index rejected one or more documents');
    }
  }

  private async indexRows(movieIds: string[]): Promise<Array<Record<string, unknown>>> {
    return this.dataSource.query(`
      SELECT m.id,m.title,m.origin_title,m.type,m.content_kind,m.release_year,m.average_rating,m.published_at,m.is_kids_safe,m.status,m.version,
        COALESCE((SELECT array_agg(g.slug ORDER BY g.slug) FROM movie_genres mg JOIN genres g ON g.id=mg.genre_id WHERE mg.movie_id=m.id), ARRAY[]::text[]) AS genres,
        COALESCE((SELECT array_agg(c.slug ORDER BY c.slug) FROM movie_countries mc JOIN countries c ON c.id=mc.country_id WHERE mc.movie_id=m.id), ARRAY[]::text[]) AS countries,
        COALESCE((SELECT array_agg(DISTINCT cs.source_type ORDER BY cs.source_type) FROM content_sources cs WHERE cs.movie_id=m.id), ARRAY[]::text[]) AS source_types,
        COALESCE((SELECT array_agg(DISTINCT cs.provider ORDER BY cs.provider) FILTER (WHERE cs.provider IS NOT NULL) FROM content_sources cs WHERE cs.movie_id=m.id), ARRAY[]::text[]) AS providers
      FROM movies m WHERE m.id=ANY($1::uuid[]) AND m.status='published'
    `, [movieIds]) as Promise<Array<Record<string, unknown>>>;
  }

  private searchDocument(row: Record<string, unknown>): Record<string, unknown> {
    return {
      id: row.id, title: row.title, originTitle: row.origin_title, type: row.type, contentKind: row.content_kind,
      releaseYear: row.release_year, averageRating: Number(row.average_rating), publishedAt: row.published_at,
      isKidsSafe: row.is_kids_safe, status: row.status, version: Number(row.version), genreSlugs: row.genres,
      countrySlugs: row.countries, sourceTypes: row.source_types, providers: row.providers,
    };
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (this.config.opensearchAuthorization) headers.authorization = this.config.opensearchAuthorization;
      return await fetch(`${this.config.opensearchUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(4_000) });
    } catch { throw new ServiceUnavailableException('Search service unavailable'); }
  }

  private async bulkRequest(body: string): Promise<Response> {
    try {
      const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/x-ndjson' };
      if (this.config.opensearchAuthorization) headers.authorization = this.config.opensearchAuthorization;
      return await fetch(`${this.config.opensearchUrl}/_bulk`, { method: 'POST', headers, body, signal: AbortSignal.timeout(20_000) });
    } catch { throw new ServiceUnavailableException('Search service unavailable'); }
  }
}
