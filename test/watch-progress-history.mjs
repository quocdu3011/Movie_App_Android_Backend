import assert from 'node:assert/strict';
import { CatalogService } from '../dist/apps/catalog-service/catalog.service.js';
import { StreamingService } from '../dist/apps/streaming-service/streaming.service.js';

const profileId = '4550e4c5-b0ec-4cc0-bcf3-728b8bdc79e7';
const playableId = 'd4887c8b-48d3-4d43-bc91-909d5edf4e10';
const sourceItemId = '78c09d73-62fb-4ca2-84ce-0b3895704180';

let historyQuery = '';
await StreamingService.prototype.getProfileProgress.call({
  dataSource: { query: async (sql) => { historyQuery = sql; return []; } },
}, profileId);

assert.match(historyQuery, /DISTINCT ON\s*\(movie_id\)/);
assert.match(historyQuery, /requires_minimum_progress/);
assert.match(historyQuery, /position_seconds::numeric\s*\/\s*duration_seconds\s*>\s*0\.02/);
assert.match(historyQuery, /ORDER BY updated_at DESC,session_ordinal DESC,playable_id/);

let selectionQuery = '';
const selection = await CatalogService.prototype.playbackSelection.call({
  dataSource: { query: async (sql) => {
    selectionQuery = sql;
    return [{ movieStatus: 'published' }];
  } },
}, playableId, sourceItemId);

assert.equal(selection.movieStatus, 'published');
assert.match(selectionQuery, /p\.episode_number\s*=\s*1/);
assert.match(selectionQuery, /COUNT\(\*\)/);
assert.match(selectionQuery, /requiresMinimumProgress/);
console.log('watch history keeps one latest playable per movie and filters only qualifying first/single items');
