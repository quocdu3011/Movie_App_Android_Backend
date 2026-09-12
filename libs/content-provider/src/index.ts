export interface PlaybackSelectors {
  externalSlug: string;
  externalEpisodeSlug: string;
  serverKey: string;
}

export interface ProviderPlaybackResult {
  mode: 'external_hls' | 'external_embed' | 'metadata_only';
  playbackUrl?: string;
  subtitleUrls?: string[];
}

/** Implemented by provider adapters in the catalog/streaming phases; no network client exists in G0. */
export interface ContentProviderAdapter {
  readonly provider: string;
  fetchMetadata(externalSlug: string): Promise<unknown>;
  resolvePlayback(selectors: PlaybackSelectors): Promise<ProviderPlaybackResult>;
}
