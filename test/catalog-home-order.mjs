import assert from 'node:assert/strict';
import { CatalogService } from '../dist/apps/catalog-service/catalog.service.js';

const movie = {
  id: 'b9b30e1b-c859-4b20-9c8e-80bbf76d9091',
  title: 'Phim đã được projection', origin_title: null, description: null,
  poster_url: null, backdrop_url: null, release_year: 2026, type: 'series', content_kind: 'film',
  status: 'published', access_tier: 'free', is_kids_safe: false, average_rating: 8.5,
  published_at: new Date('2026-01-01T00:00:00.000Z'), version: '1',
  created_at: new Date('2026-01-01T00:00:00.000Z'), updated_at: new Date('2026-01-01T00:00:00.000Z'),
};

const calls = [];
const dataSource = {
  async query(sql) {
    calls.push(sql);
    return [
      { ...movie, collection_type: 'new_releases', collection_name: 'Mới phát hành', display_order: 10, position: 1 },
      { ...movie, id: null, collection_type: 'trending', collection_name: 'Top thịnh hành', display_order: 20, position: null },
    ];
  },
};

const service = new CatalogService(dataSource, {}, {});
const home = await service.home(50);
const homeQuery = calls[0];

assert.deepEqual(home.map((section) => section.type), ['new_releases', 'trending']);
assert.equal(home[0].name, 'Mới phát hành');
assert.equal(home[0].items[0].id, movie.id);
assert.deepEqual(home[1].items, []);
assert.match(homeQuery, /catalog_home_collections/);
assert.match(homeQuery, /catalog_home_collection_items/);
assert.doesNotMatch(homeQuery, /content_sources|average_rating DESC|ln\(/);
console.log('catalog home reads only precomputed projection sections');
