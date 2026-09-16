export interface PlaybackSelectors {
  externalSlug: string;
  externalEpisodeKey: string;
  serverKey: string;
}

export interface ProviderPlaybackResult {
  mode: 'external_hls' | 'external_embed' | 'metadata_only';
  playbackUrl?: string;
  subtitleUrls?: string[];
}

export interface ProviderEpisodeSelector {
  label: string;
  selectorKey: string;
  selectorSlug: string | null;
  episodeNumber: number | null;
  hasHls: boolean;
  hasEmbed: boolean;
}

export interface ProviderServer {
  serverKey: string;
  serverLabel: string;
  episodes: ProviderEpisodeSelector[];
}

export interface ProviderTaxonomyItem {
  slug: string;
  name: string;
}

/** Safe projection only: raw provider responses and media URLs are deliberately absent. */
export interface ProviderMovieMetadata {
  externalId: string;
  slug: string;
  title: string;
  originTitle: string | null;
  description: string | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  releaseYear: number | null;
  type: 'movie' | 'series';
  contentKind: 'film' | 'animation' | 'show';
  averageRating: number;
  providerViewCount: number;
  providerVoteCount: number;
  isCompleted: boolean;
  durationSeconds: number | null;
  externalUpdatedAt: string | null;
  genres: ProviderTaxonomyItem[];
  countries: ProviderTaxonomyItem[];
  servers: ProviderServer[];
}

export interface ProviderDiscoveryItem {
  externalId: string;
  slug: string;
  title: string;
  posterUrl: string | null;
  releaseYear: number | null;
}

export interface ProviderSearchPage {
  items: ProviderDiscoveryItem[];
  page: number;
  pageSize: number;
  totalItems: number | null;
  totalPages: number | null;
}

export interface ProviderMetadataClient {
  readonly provider: string;
  fetchMetadata(externalSlug: string, options?: { fresh?: boolean }): Promise<ProviderMovieMetadata>;
  search(keyword: string, page: number): Promise<ProviderSearchPage>;
  discover(page: number): Promise<ProviderSearchPage>;
}

/** Playback resolution is separate from metadata ingestion and must never persist its result. */
export interface ProviderPlaybackResolver {
  resolvePlayback(selectors: PlaybackSelectors): Promise<ProviderPlaybackResult>;
}

export class ProviderResponseError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    super(code);
    this.name = 'ProviderResponseError';
  }
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const result = String(value).trim();
  return result ? result : null;
}

function safeHttpUrl(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch { return null; }
}

function safeImage(value: unknown, imageBase: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const absolute = safeHttpUrl(raw);
  if (absolute) return absolute;
  const base = safeHttpUrl(imageBase);
  if (!base || raw.startsWith('//') || raw.includes('..')) return null;
  try { return new URL(raw.replace(/^\/+/, ''), base.endsWith('/') ? base : `${base}/`).toString(); } catch { return null; }
}

function cleanHtml(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const clean = raw
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(?:p|div|li)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([\da-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/[\t ]+/g, ' ').replace(/ *\n */g, '\n').trim();
  return clean || null;
}

function episodeNumber(value: unknown): number | null {
  const label = text(value);
  if (!label) return null;
  const match = /^(?:(?:tập|tap|episode|ep)\s*)?(\d{1,4})$/i.exec(label);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function taxonomy(value: unknown): ProviderTaxonomyItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    const row = object(entry);
    const name = text(row?.name);
    const slug = text(row?.slug);
    if (!name || !slug || seen.has(slug)) return [];
    seen.add(slug);
    return [{ name: cleanHtml(name) ?? name, slug: slug.toLowerCase() }];
  });
}

function normalizeKey(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100);
}

function nonNegativeCount(value: unknown): number | null {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function highestCount(values: unknown[]): number {
  return values.reduce<number>((highest, value) => Math.max(highest, nonNegativeCount(value) ?? 0), 0);
}

function episodeTotal(value: unknown): number | null {
  const source = text(value);
  const matches = source?.match(/\d+/g);
  if (!matches?.length) return null;
  const total = Number(matches[matches.length - 1]);
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}

function parseDuration(value: unknown): number | null {
  const source = text(value);
  if (!source) return null;
  const hours = /(\d+)\s*(?:h|giờ)/i.exec(source);
  const minutes = /(\d+)\s*(?:m|phút|min)/i.exec(source);
  const seconds = /(\d+)\s*(?:s|giây|sec)/i.exec(source);
  if (!hours && !minutes && !seconds) return null;
  const total = Number(hours?.[1] ?? 0) * 3600 + Number(minutes?.[1] ?? 0) * 60 + Number(seconds?.[1] ?? 0);
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

function movieObject(response: JsonObject): JsonObject {
  const v1Item = object(object(response.data)?.item);
  const legacy = object(response.movie);
  const candidate = v1Item ?? legacy;
  if (!candidate || response.status === false || response.status === 'error') throw new ProviderResponseError('PROVIDER_INVALID_DETAIL');
  return candidate;
}

function parseServers(value: unknown): ProviderServer[] {
  if (!Array.isArray(value)) return [];
  const seenServers = new Set<string>();
  return value.flatMap((serverValue, serverIndex) => {
    const server = object(serverValue);
    const label = text(server?.server_name) ?? `Server ${serverIndex + 1}`;
    const serverKey = normalizeKey(label) || `server-${serverIndex + 1}`;
    if (seenServers.has(serverKey)) throw new ProviderResponseError('PROVIDER_MAPPING_CONFLICT');
    seenServers.add(serverKey);
    const rawEpisodes = Array.isArray(server?.server_data) ? server.server_data : [];
    const seenEpisodeKeys = new Set<string>();
    const episodes = rawEpisodes.flatMap((episodeValue) => {
      const episode = object(episodeValue);
      if (!episode) return [];
      const episodeLabel = text(episode.name) ?? text(episode.filename) ?? text(episode.slug);
      const slug = text(episode.slug);
      const filename = text(episode.filename);
      const selectorKey = [filename, slug, episodeLabel].find((candidate) => !!candidate && !/^https?:\/\//i.test(candidate) && candidate.length <= 200);
      if (!episodeLabel || !selectorKey) throw new ProviderResponseError('PROVIDER_MAPPING_CONFLICT');
      if (seenEpisodeKeys.has(selectorKey)) throw new ProviderResponseError('PROVIDER_MAPPING_CONFLICT');
      seenEpisodeKeys.add(selectorKey);
      return [{
        label: cleanHtml(episodeLabel) ?? episodeLabel,
        selectorKey,
        selectorSlug: slug && !/^https?:\/\//i.test(slug) ? slug : null,
        episodeNumber: episodeNumber(episode.name),
        hasHls: safeHttpUrl(episode.link_m3u8)?.startsWith('https://') === true,
        hasEmbed: safeHttpUrl(episode.link_embed)?.startsWith('https://') === true,
      }];
    });
    return episodes.length ? [{ serverKey, serverLabel: label, episodes }] : [];
  });
}

export function parseProviderDetail(input: unknown): ProviderMovieMetadata {
  const response = object(input);
  if (!response) throw new ProviderResponseError('PROVIDER_INVALID_DETAIL');
  const movie = movieObject(response);
  const externalId = text(movie._id) ?? text(movie.id);
  const slug = text(movie.slug);
  const title = cleanHtml(movie.name);
  const originTitle = cleanHtml(movie.origin_name) ?? cleanHtml(movie.originTitle);
  const servers = parseServers(movie.episodes ?? (object(response.data)?.episodes) ?? response.episodes);
  if (!externalId || !slug || !title || !servers.length) throw new ProviderResponseError('PROVIDER_INVALID_DETAIL');
  const categories = taxonomy(movie.category);
  const rawType = (text(movie.type) ?? '').toLowerCase();
  const explicitSeries = ['series', 'tvshows', 'tv-show', 'phim-bo', 'phim bộ'].includes(rawType);
  const explicitMovie = ['single', 'movie', 'phim-le', 'phim lẻ'].includes(rawType);
  const distinctKeys = new Set(servers.flatMap((server) => server.episodes.map((episode) => episode.episodeNumber !== null ? `number:${episode.episodeNumber}` : `label:${normalizeKey(episode.label)}`)));
  const totalText = text(movie.episode_total);
  const totalMatch = totalText ? /(?:\d+\s*\/\s*)?(\d+)/.exec(totalText) : null;
  const declaredMultipleEpisodes = !!totalMatch && Number(totalMatch[1]) > 1;
  const inferredSeries = declaredMultipleEpisodes || distinctKeys.size > 1 || rawType === 'hoathinh' && distinctKeys.size > 1;
  const animationType = rawType === 'hoathinh' || categories.some((item) => /hoat-hinh|animation|cartoon/.test(item.slug));
  const fullOnly = distinctKeys.size === 1 && servers.every((server) => server.episodes.length === 1)
    && servers.every((server) => /^(full|movie|phim lẻ)$/i.test(server.episodes[0].label));
  if (!explicitSeries && !explicitMovie && !inferredSeries && !(animationType && fullOnly)) throw new ProviderResponseError('PROVIDER_MAPPING_CONFLICT');
  const type = explicitSeries || (!explicitMovie && inferredSeries) ? 'series' : 'movie';
  const contentKind = rawType === 'tvshows' || rawType === 'tv-show' ? 'show'
    : animationType ? 'animation' : 'film';
  const tmdb = object(movie.tmdb);
  const imdb = object(movie.imdb);
  const ratingCandidates = [tmdb?.vote_average, imdb?.vote_average, movie.vote_average, movie.rating];
  const rawRating = ratingCandidates.map((value) => Number(value)).find((value) => Number.isFinite(value) && value >= 0 && value <= 10);
  const providerViewCount = highestCount([movie.view_count, movie.viewCount, movie.views, tmdb?.view_count, tmdb?.views]);
  const providerVoteCount = highestCount([tmdb?.vote_count, imdb?.vote_count, movie.vote_count, movie.voteCount, movie.rating_count]);
  const episodeCurrent = episodeTotal(movie.episode_current);
  const episodeCount = episodeTotal(movie.episode_total);
  const providerStatus = (text(movie.status) ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const isCompleted = /completed|complete|hoan tat|da xong/.test(providerStatus)
    || (episodeCurrent !== null && episodeCount !== null && episodeCount > 0 && episodeCurrent >= episodeCount);
  const yearValue = Number(movie.year);
  const releaseYear = Number.isInteger(yearValue) && yearValue >= 1800 && yearValue <= 2200 ? yearValue : null;
  const modified = text(object(movie.modified)?.time);
  const poster = safeImage(movie.poster_url ?? movie.posterUrl, response.pathImage ?? object(response.data)?.pathImage);
  const thumb = safeImage(movie.thumb_url ?? movie.backdrop_url, response.pathImage ?? object(response.data)?.pathImage);
  return {
    externalId, slug, title, originTitle, description: cleanHtml(movie.content), posterUrl: poster, backdropUrl: thumb,
    releaseYear, type, contentKind, averageRating: rawRating ?? 0, providerViewCount, providerVoteCount, isCompleted,
    durationSeconds: parseDuration(movie.time), externalUpdatedAt: modified && Number.isFinite(Date.parse(modified)) ? new Date(modified).toISOString() : null,
    genres: categories, countries: taxonomy(movie.country), servers,
  };
}

function parseListItem(value: unknown, imageBase: unknown): ProviderDiscoveryItem | null {
  const row = object(value);
  const externalId = text(row?._id) ?? text(row?.id);
  const slug = text(row?.slug);
  const title = cleanHtml(row?.name);
  if (!externalId || !slug || !title) return null;
  const year = Number(row?.year);
  return {
    externalId, slug, title, posterUrl: safeImage(row?.poster_url ?? row?.thumb_url, imageBase),
    releaseYear: Number.isInteger(year) && year >= 1800 && year <= 2200 ? year : null,
  };
}

export function parseProviderList(input: unknown): ProviderSearchPage {
  const response = object(input);
  if (!response || response.status === false || response.status === 'error') throw new ProviderResponseError('PROVIDER_INVALID_LIST');
  const data = object(response.data);
  const items = Array.isArray(response.items) ? response.items : Array.isArray(data?.items) ? data.items : null;
  if (!items) throw new ProviderResponseError('PROVIDER_INVALID_LIST');
  const pagination = object(response.pagination) ?? object(object(data?.params)?.pagination);
  const parsed = items.map((item) => parseListItem(item, response.pathImage ?? data?.pathImage)).filter((item): item is ProviderDiscoveryItem => item !== null);
  const number = (value: unknown): number | null => {
    const result = Number(value);
    return Number.isSafeInteger(result) && result >= 0 ? result : null;
  };
  return {
    items: parsed,
    page: number(pagination?.currentPage) ?? number(object(data?.params)?.page) ?? 1,
    pageSize: number(pagination?.totalItemsPerPage) ?? (parsed.length || 10),
    totalItems: number(pagination?.totalItems),
    totalPages: number(pagination?.totalPages) ?? number(pagination?.pageRanges),
  };
}

export class KkphimAdapter implements ProviderMetadataClient, ProviderPlaybackResolver {
  readonly provider = 'kkphim';
  private readonly metadataCache = new Map<string, { expiresAt: number; value: ProviderMovieMetadata }>();

  constructor(private readonly baseUrl: string, private readonly timeoutMs = 5_000, private readonly fetcher: typeof fetch = fetch) {}

  async fetchMetadata(externalSlug: string, options: { fresh?: boolean } = {}): Promise<ProviderMovieMetadata> {
    const key = externalSlug.trim();
    if (!key || key.length > 180) throw new ProviderResponseError('PROVIDER_INVALID_SELECTOR');
    const cached = this.metadataCache.get(key);
    if (!options.fresh && cached && cached.expiresAt > Date.now()) return structuredClone(cached.value);
    const response = await this.get(`/phim/${encodeURIComponent(key)}`);
    const safe = parseProviderDetail(response);
    this.metadataCache.set(key, { expiresAt: Date.now() + 15 * 60_000, value: safe });
    if (this.metadataCache.size > 2_000) this.metadataCache.delete(this.metadataCache.keys().next().value as string);
    return structuredClone(safe);
  }

  async search(keyword: string, page: number): Promise<ProviderSearchPage> {
    const q = keyword.trim();
    if (q.length < 1 || q.length > 100 || !Number.isSafeInteger(page) || page < 1 || page > 10_000) throw new ProviderResponseError('PROVIDER_INVALID_SEARCH');
    return parseProviderList(await this.get(`/v1/api/tim-kiem?keyword=${encodeURIComponent(q)}&page=${page}&limit=20`));
  }

  async discover(page: number): Promise<ProviderSearchPage> {
    if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) throw new ProviderResponseError('PROVIDER_INVALID_PAGE');
    return parseProviderList(await this.get(`/danh-sach/phim-moi-cap-nhat?page=${page}`));
  }

  async resolvePlayback(selectors: PlaybackSelectors): Promise<ProviderPlaybackResult> {
    const response = object(await this.get(`/phim/${encodeURIComponent(selectors.externalSlug)}`));
    if (!response) throw new ProviderResponseError('PROVIDER_INVALID_DETAIL');
    const metadata = parseProviderDetail(response);
    const server = metadata.servers.find((item) => item.serverKey === selectors.serverKey);
    const selected = server?.episodes.find((episode) => episode.selectorKey === selectors.externalEpisodeKey);
    if (!selected) throw new ProviderResponseError('PROVIDER_MAPPING_CONFLICT');
    const rootMovie = movieObject(response);
    const rawServers = rootMovie.episodes ?? response.episodes;
    if (!Array.isArray(rawServers)) throw new ProviderResponseError('PROVIDER_INVALID_DETAIL');
    const rawServer = rawServers.map(object).find((item) => normalizeKey(text(item?.server_name) ?? '') === selectors.serverKey);
    const rawEpisodeList = Array.isArray(rawServer?.server_data) ? rawServer.server_data : [];
    const rawEpisode = rawEpisodeList.map(object).find((item) => (text(item?.filename) ?? text(item?.slug) ?? text(item?.name)) === selectors.externalEpisodeKey);
    const hls = safeHttpUrl(rawEpisode?.link_m3u8);
    if (hls?.startsWith('https://') && selected.hasHls) return { mode: 'external_hls', playbackUrl: hls };
    const embed = safeHttpUrl(rawEpisode?.link_embed);
    if (embed?.startsWith('https://') && selected.hasEmbed) return { mode: 'external_embed', playbackUrl: embed };
    return { mode: 'metadata_only' };
  }

  private async get(path: string): Promise<unknown> {
    const url = new URL(path, `${this.baseUrl.replace(/\/$/, '')}/`);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetcher(url, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
      } catch {
        if (attempt < 2) { await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1))); continue; }
        throw new ProviderResponseError('PROVIDER_UNAVAILABLE');
      }
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt < 2) { await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1))); continue; }
        throw new ProviderResponseError(response.status === 404 ? 'PROVIDER_NOT_FOUND' : 'PROVIDER_HTTP_ERROR', response.status);
      }
      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > 2_000_000) throw new ProviderResponseError('PROVIDER_RESPONSE_TOO_LARGE');
      let body: string;
      try { body = await response.text(); } catch { throw new ProviderResponseError('PROVIDER_INVALID_RESPONSE'); }
      if (Buffer.byteLength(body) > 2_000_000) throw new ProviderResponseError('PROVIDER_RESPONSE_TOO_LARGE');
      try { return JSON.parse(body) as unknown; } catch { throw new ProviderResponseError('PROVIDER_INVALID_RESPONSE'); }
    }
    throw new ProviderResponseError('PROVIDER_UNAVAILABLE');
  }
}
