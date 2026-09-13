import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RECOMMENDATION_CONFIG, RecommendationConfig } from './recommendation.config';

interface ProfileData { active?: boolean; userId?: string; profileId?: string; isKids?: boolean }
interface CatalogEntry { movieId: string; movie: Record<string, unknown> | null; tombstone: boolean }

@Injectable()
export class RecommendationService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource, @Inject(RECOMMENDATION_CONFIG) private readonly config: RecommendationConfig) {}

  async ready(): Promise<void> { await this.dataSource.query('SELECT 1'); }
  async metrics(): Promise<string> {
    const rows = await this.dataSource.query(`SELECT count(*)::text AS count FROM watch_events`) as Array<{ count: string }>;
    return ['# HELP movieapp_recommendation_qualified_views Durable qualified views used by recommendations.', '# TYPE movieapp_recommendation_qualified_views gauge', `movieapp_recommendation_qualified_views ${rows[0]?.count ?? '0'}`, ''].join('\n');
  }

  async processQualified(event: { eventId: string; sessionId: string; userId: string; profileId: string; movieId: string; occurredAt: string }): Promise<void> {
    const occurredAt = new Date(event.occurredAt);
    if (!Number.isFinite(occurredAt.getTime())) return;
    await this.dataSource.transaction(async (manager) => {
      const duplicate = await manager.query(`SELECT 1 FROM processed_events WHERE consumer_name='recommendation' AND event_id=$1`, [event.eventId]) as unknown[];
      if (duplicate.length) return;
      await manager.query(`INSERT INTO watch_events(event_id,session_id,user_id,profile_id,movie_id,occurred_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(session_id) DO NOTHING`, [event.eventId, event.sessionId, event.userId, event.profileId, event.movieId, occurredAt]);
      await manager.query(`INSERT INTO processed_events(consumer_name,event_id) VALUES('recommendation',$1)`, [event.eventId]);
    });
  }

  async processProfileDeleted(eventId: string, profileId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const duplicate = await manager.query(`SELECT 1 FROM processed_events WHERE consumer_name='recommendation' AND event_id=$1`, [eventId]) as unknown[];
      if (duplicate.length) return;
      await manager.query(`DELETE FROM watch_events WHERE profile_id=$1`, [profileId]);
      await manager.query(`INSERT INTO processed_events(consumer_name,event_id) VALUES('recommendation',$1)`, [eventId]);
    });
  }

  async recommendations(profileId: string, userId: string): Promise<Record<string, unknown>> {
    const profile = await this.profile(profileId, userId);
    const watchedRows = await this.dataSource.query(`SELECT movie_id FROM watch_events WHERE profile_id=$1 ORDER BY occurred_at DESC LIMIT 100`, [profileId]) as Array<{ movie_id: string }>;
    const watchedIds = [...new Set(watchedRows.map((row) => row.movie_id))];
    const watched = await this.batch(watchedIds, profile.isKids === true);
    const genres = [...new Set(watched.flatMap((entry) => Array.isArray(entry.movie?.genres) ? entry.movie.genres.flatMap((genre) => typeof genre === 'object' && genre !== null && typeof (genre as Record<string, unknown>).slug === 'string' ? [(genre as Record<string, unknown>).slug as string] : []) : []))];
    const candidates = await this.candidates(genres, watchedIds, profile.isKids === true);
    if (candidates.length) return { type: 'recommendations', items: candidates, basis: 'same_genre' };
    const trending = await this.trending(profile.isKids === true);
    if (trending.items.length) return { type: 'fallback_trending', items: trending.items, basis: 'trending' };
    const fresh = await this.candidates([], watchedIds, profile.isKids === true);
    return { type: 'fallback_new_releases', items: fresh, basis: 'new_releases' };
  }

  async trending(isKids = false): Promise<{ type: string; items: Record<string, unknown>[] }> {
    const rows = await this.dataSource.query(`SELECT movie_id FROM watch_events WHERE occurred_at >= now()-interval '7 days' GROUP BY movie_id ORDER BY count(DISTINCT session_id) DESC,movie_id ASC LIMIT 100`) as Array<{ movie_id: string }>;
    const hydrated = await this.batch(rows.map((row) => row.movie_id), isKids);
    return { type: 'trending_7d', items: hydrated.flatMap((entry) => entry.movie ? [entry.movie] : []) };
  }

  private async profile(profileId: string, userId: string): Promise<ProfileData> {
    const result = await this.call(this.config.profileUrl, this.config.profileToken, 'recommendation-service', '/internal/profiles/validate', { profileId, userId });
    const profile = result as ProfileData;
    if (!profile.active || profile.profileId !== profileId || profile.userId !== userId) throw new NotFoundException('Active profile not found');
    return profile;
  }

  private async batch(movieIds: string[], isKids: boolean): Promise<CatalogEntry[]> {
    if (!movieIds.length) return [];
    return this.call(this.config.catalogUrl, this.config.catalogToken, 'recommendation-service', '/internal/catalog/movies/batch', { movieIds, isKids, includeTombstones: true }) as Promise<CatalogEntry[]>;
  }

  private async candidates(genreSlugs: string[], excludeMovieIds: string[], isKids: boolean): Promise<Record<string, unknown>[]> {
    const result = await this.call(this.config.catalogUrl, this.config.catalogToken, 'recommendation-service', '/internal/catalog/recommendations/candidates', { genreSlugs, excludeMovieIds, isKids, limit: 20 });
    return Array.isArray(result) ? result as Record<string, unknown>[] : [];
  }

  private async call(baseUrl: string, token: string, caller: string, path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try { response = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-caller-service': caller, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(3_000) }); }
    catch { throw new ServiceUnavailableException('Recommendation dependency unavailable'); }
    if (!response.ok) {
      if (response.status === 404) throw new NotFoundException('Referenced profile or movie not found');
      throw new ServiceUnavailableException('Recommendation dependency unavailable');
    }
    try { return (await response.json() as { data?: unknown }).data; } catch { throw new ServiceUnavailableException('Recommendation dependency returned invalid response'); }
  }
}
