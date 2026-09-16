import test from 'node:test';
import assert from 'node:assert/strict';
import { KkphimAdapter, parseProviderDetail, parseProviderList } from './index';

const legacy = {
  status: true,
  pathImage: 'https://images.example/uploads/',
  movie: {
    _id: 'kk-1', slug: 'pho-demo', name: 'Phố <b>Demo</b>', origin_name: 'Demo Street',
    content: '<p>Mô tả &amp; nội dung</p><script>unsafe()</script>', type: 'single', year: 2024,
    time: '1 giờ 35 phút', status: 'completed', tmdb: { vote_average: 10, vote_count: 50 }, view_count: 1200, poster_url: 'poster.jpg',
    category: [{ name: 'Hoạt hình', slug: 'hoat-hinh' }], country: [{ name: 'Việt Nam', slug: 'viet-nam' }],
  },
  episodes: [{ server_name: 'Vietsub', server_data: [{ name: 'Full', slug: 'full', filename: 'file-full', link_m3u8: 'https://media.example/master.m3u8?secret=1', link_embed: 'https://player.example/embed' }] }],
};

test('KKPhim legacy detail produces URL-free metadata and preserves rating 10.0/animation film', () => {
  const result = parseProviderDetail(legacy);
  assert.equal(result.type, 'movie');
  assert.equal(result.contentKind, 'animation');
  assert.equal(result.averageRating, 10);
  assert.equal(result.providerViewCount, 1200);
  assert.equal(result.providerVoteCount, 50);
  assert.equal(result.isCompleted, true);
  assert.equal(result.servers[0].episodes[0].label, 'Full');
  assert.equal(result.durationSeconds, 5700);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('link_m3u8'), false);
  assert.equal(serialized.includes('link_embed'), false);
  assert.equal(serialized.includes('media.example'), false);
  assert.equal(result.posterUrl, 'https://images.example/uploads/poster.jpg');
  assert.equal(result.description?.includes('unsafe'), false);
});

test('KKPhim hoathinh with a Full-only selector stays a movie', () => {
  const input = structuredClone(legacy);
  input.movie.type = 'hoathinh';
  const result = parseProviderDetail(input);
  assert.equal(result.type, 'movie');
  assert.equal(result.contentKind, 'animation');
});

test('KKPhim v1 detail maps repeated episode numbers on separate servers to safe selectors', () => {
  const input = {
    status: 'success', data: { item: {
      _id: 'kk-series', slug: 'series', name: 'Series', type: 'series', episode_total: '2', year: '2025',
      episodes: [
        { server_name: 'Server A', server_data: [{ name: 'Tập 1', slug: 'tap-1', filename: 's1e1', link_m3u8: 'https://media/a.m3u8' }, { name: 'Special', slug: 'special', filename: 'sp1' }] },
        { server_name: 'Server B', server_data: [{ name: 'Tập 1', slug: 'tap-1-b', filename: 's1e1-b', link_m3u8: 'https://media/b.m3u8' }, { name: 'Special', slug: 'special-b', filename: 'sp1-b' }] },
      ],
    } },
  };
  const result = parseProviderDetail(input);
  assert.equal(result.type, 'series');
  assert.equal(result.servers.length, 2);
  assert.equal(result.servers[0].episodes[0].episodeNumber, 1);
  assert.equal(result.servers[0].episodes[1].episodeNumber, null);
  assert.equal(JSON.stringify(result).includes('https://media/'), false);
});

test('KKPhim list parser accepts legacy and v1 envelopes', () => {
  const legacyPage = parseProviderList({ status: true, items: [{ _id: 'a', slug: 'a', name: 'A' }], pagination: { currentPage: 3, totalItems: 9, totalItemsPerPage: 3, totalPages: 3 } });
  const v1Page = parseProviderList({ status: 'success', data: { items: [{ _id: 'b', slug: 'b', name: 'B' }], params: { pagination: { currentPage: 2, totalItems: 8, totalItemsPerPage: 4, pageRanges: 2 } } } });
  assert.equal(legacyPage.page, 3);
  assert.equal(v1Page.page, 2);
  assert.equal(v1Page.totalPages, 2);
});

test('playback resolver selects requested server/episode but metadata cache never contains its URL', async () => {
  const calls: string[] = [];
  const adapter = new KkphimAdapter('https://phimapi.test', 500, async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify(legacy), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const metadata = await adapter.fetchMetadata('pho-demo');
  assert.equal(JSON.stringify(metadata).includes('media.example'), false);
  const playback = await adapter.resolvePlayback({ externalSlug: 'pho-demo', externalEpisodeKey: 'file-full', serverKey: 'vietsub' });
  assert.equal(playback.mode, 'external_hls');
  assert.equal(playback.playbackUrl, 'https://media.example/master.m3u8?secret=1');
  assert.equal(calls.length, 2);
});
