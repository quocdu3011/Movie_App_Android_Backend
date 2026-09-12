import assert from 'node:assert/strict';
import { KkphimAdapter } from '../dist/libs/content-provider/index.js';

const baseUrl = process.env.KKPHIM_API_BASE_URL?.trim() || 'https://phimapi.com';
const parsedBase = new URL(baseUrl);
assert.equal(parsedBase.protocol, 'https:', 'Live KKPhim smoke must use HTTPS');
assert.equal(parsedBase.hostname, 'phimapi.com', 'Live smoke only targets the documented KKPhim API host');

const timeoutMs = Number(process.env.KKPHIM_TIMEOUT_MS ?? 10_000);
const provider = new KkphimAdapter(parsedBase.origin, Math.max(500, Math.min(15_000, timeoutMs)));

try {
  const discovery = await provider.discover(1);
  assert.ok(discovery.items.length > 0, 'KKPhim discovery page must contain parseable items');
  const candidate = discovery.items[0];
  assert.ok(candidate.externalId && candidate.slug && candidate.title);
  console.log('PASS live discovery', JSON.stringify({ page: discovery.page, pageSize: discovery.pageSize, itemCount: discovery.items.length }));

  const keyword = candidate.title.split(/\s+/).find((part) => part.length >= 2) || candidate.title;
  const search = await provider.search(keyword, 1);
  assert.ok(Array.isArray(search.items), 'KKPhim search response must parse into an item list');
  console.log('PASS live search', JSON.stringify({ page: search.page, itemCount: search.items.length, hasPagination: search.totalItems !== null || search.totalPages !== null }));

  const metadata = await provider.fetchMetadata(candidate.slug, { fresh: true });
  assert.equal(metadata.externalId, candidate.externalId, 'detail external ID must match discovery');
  assert.equal(metadata.slug, candidate.slug, 'detail slug must match discovery');
  assert.ok(metadata.title);
  const safeMetadata = JSON.stringify(metadata);
  for (const field of ['link_m3u8', 'link_embed', 'playbackUrl', 'credential']) {
    assert.ok(!safeMetadata.toLowerCase().includes(field.toLowerCase()), `metadata projection must not contain ${field}`);
  }
  const selectors = metadata.servers.flatMap((server) => server.episodes.map((episode) => ({ server, episode })));
  assert.ok(selectors.length > 0, 'live detail must include at least one normalized selector');
  console.log('PASS live detail', JSON.stringify({ type: metadata.type, contentKind: metadata.contentKind, serverCount: metadata.servers.length, selectorCount: selectors.length, rating: metadata.averageRating, playbackFieldsInMetadata: false }));

  const selected = selectors.find(({ episode }) => episode.hasHls || episode.hasEmbed) || selectors[0];
  const resolved = await provider.resolvePlayback({
    externalSlug: metadata.slug,
    serverKey: selected.server.serverKey,
    externalEpisodeKey: selected.episode.selectorKey,
  });
  assert.ok(['external_hls', 'external_embed', 'metadata_only'].includes(resolved.mode));
  if (resolved.playbackUrl) {
    const playbackUrl = new URL(resolved.playbackUrl);
    assert.equal(playbackUrl.protocol, 'https:');
    assert.equal(playbackUrl.username, '');
    assert.equal(playbackUrl.password, '');
  }
  console.log('PASS live resolver', JSON.stringify({ mode: resolved.mode, urlReturned: Boolean(resolved.playbackUrl), urlWrittenOrPrinted: false }));
} catch (error) {
  const code = typeof error?.code === 'string' ? error.code : error?.name || 'UNKNOWN_ERROR';
  console.error('FAIL live KKPhim smoke', code);
  process.exitCode = 1;
}
