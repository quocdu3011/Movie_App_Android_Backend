import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (path) => readFile(resolve(root, path), 'utf8');
const [catalogSpec, paymentSpec, backendDesign, todo, gatewayCatalog, gatewayStreaming, gatewayPayment] = await Promise.all([
  read('document/catalog-openapi.yaml'), read('document/payment-openapi.yaml'), read('document/backend-chi-tiet.md'), read('document/todo-prompt-backend.md'),
  read('apps/api-gateway/src/catalog/catalog-proxy.controller.ts'), read('apps/api-gateway/src/streaming/streaming-proxy.controller.ts'), read('apps/api-gateway/src/payments/payment-proxy.controller.ts'),
]);

for (const path of ['/catalog/home', '/catalog/movies', '/catalog/search', '/admin/movies', '/admin/providers/kkphim/import']) assert.match(catalogSpec, new RegExp(`^  ${path.replaceAll('/', '\\/')}:`, 'm'), `Catalog OpenAPI is missing ${path}`);
for (const path of ['/subscriptions/plans', '/subscriptions/subscribe', '/subscriptions/current', '/payments/webhook/{provider}']) assert.match(paymentSpec, new RegExp(`^  ${path.replaceAll('/', '\\/')}:`, 'm'), `Payment OpenAPI is missing ${path}`);
for (const source of [gatewayCatalog, gatewayStreaming, gatewayPayment]) assert.match(source, /@Controller\(/, 'Gateway controller is expected to declare its route prefix');
for (const route of ['/streaming/playback-sessions', '/profiles', '/home', '/subscriptions/subscribe']) assert.ok(backendDesign.includes(route), `Backend design is missing route ${route}`);
for (const phrase of ['Không deploy ở giai đoạn này.', 'Android Media3 device test thực tế']) assert.ok(todo.includes(phrase), `G9 TODO safety boundary is missing: ${phrase}`);

console.log('PASS G9 contract: Catalog/Payment OpenAPI paths, Gateway route sources and backend/TODO contract boundaries are aligned.');
