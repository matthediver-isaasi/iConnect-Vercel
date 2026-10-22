import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicationImportService } from './publicationImportService.js';
import { config } from '../article-briefs/publication-import.js';
import { readFileSync } from 'node:fs';

const ctx = { isAuthenticated: true, tenantId: 'tenant', memberId: 'actor' };
const snapshot = { actor: { id: 'actor' }, member: { role_id: 'role' },
  role: { id: 'role', excluded_features: [] }, accessItems: [] };

test('workbook JSON has dedicated development and deployment body limits', () => {
  assert.equal(config.api.bodyParser.sizeLimit, '2mb');
  const app = readFileSync(new URL('../../server/app.ts', import.meta.url), 'utf8');
  assert.match(app, /app\.use\('\/api\/article-briefs\/publication-import', express\.json\(\{ limit: '2mb' \}\)\)/);
  assert.ok(app.indexOf("'/api/article-briefs/publication-import'") < app.indexOf('app.use(express.json('));
});

test('unacknowledged database outcomes remain retryable, SQL rejections are definitive', async () => {
  for (const [code, status] of [['', 503], ['08006', 503], ['57014', 503], ['P0001', 409], ['23503', 409]]) {
    const db = { rpc: async () => ({ error: { code, message: 'database unavailable' } }) };
    const service = createPublicationImportService({ db, parser: {}, secret: 'synthetic-test-secret' });
    await assert.rejects(service.template(ctx), error => error.status === status);
  }
});

test('compressed text cannot produce an oversized signed plan', async () => {
  const records = [{ row: 2, values: { Title: 'Synthetic', Notes: 'x'.repeat(512 * 1024) } }];
  let resolved = false;
  const service = createPublicationImportService({
    db: { rpc: async () => ({ data: snapshot }) }, secret: 'synthetic-test-secret',
    parser: {
      parsePublicationWorkbook: () => ({ records }),
      resolvePublicationRows: () => { resolved = true; return []; },
    },
  });
  await assert.rejects(service.preview(ctx, { fileName: 'synthetic.xlsx', workbook: 'eA==' }), /512 KB/);
  assert.equal(resolved, false);
});
