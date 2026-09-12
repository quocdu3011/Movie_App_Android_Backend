import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { HttpExceptionEnvelopeFilter } from './envelope';

function capture(exception: unknown) {
  let status = 0;
  let body: unknown;
  const request = { requestId: 'request-test' };
  const response = {
    status(value: number) { status = value; return this; },
    json(value: unknown) { body = value; return this; },
  };
  const host = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }) };
  new HttpExceptionEnvelopeFilter().catch(exception, host as never);
  return { status, body };
}

test('HTTP envelope preserves a validated domain error code and details', () => {
  const result = capture(new HttpException({ code: 'PLAYBACK_MODE_UNSUPPORTED', message: 'HLS is required', details: { sourceType: 'third_party' } }, 422));
  assert.deepEqual(result, {
    status: 422,
    body: {
      success: false, data: null,
      error: { code: 'PLAYBACK_MODE_UNSUPPORTED', message: 'HLS is required', details: { sourceType: 'third_party' } },
      requestId: 'request-test',
    },
  });
});

test('HTTP envelope keeps the standard status code when an exception has no domain code', () => {
  const result = capture(new HttpException('Not found', 404));
  assert.deepEqual((result.body as { error: unknown }).error, { code: 'HTTP_404', message: 'Not found' });
});
