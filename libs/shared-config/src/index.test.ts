import assert from 'node:assert/strict';
import test from 'node:test';
import { loadHttpServiceConfig } from './index';

test('shared service configuration requires an explicit supported environment', () => {
  assert.throws(() => loadHttpServiceConfig('profile-service', 'PROFILE_PORT', 3002, {}), /NODE_ENV/);
  assert.deepEqual(loadHttpServiceConfig('profile-service', 'PROFILE_PORT', 3002, { NODE_ENV: 'test' }), {
    serviceName: 'profile-service', port: 3002, nodeEnv: 'test',
  });
  assert.throws(() => loadHttpServiceConfig('profile-service', 'PROFILE_PORT', 3002, {
    NODE_ENV: 'test', PROFILE_PORT: '70000',
  }), /PROFILE_PORT/);
});
