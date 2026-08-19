import test from 'node:test';
import assert from 'node:assert/strict';

process.env.INTEGRATION_ENCRYPTION_KEY ||= 'adzuna-feed-test-encryption-key';

const {
  ADZUNA_ATTRIBUTION,
  fetchAdzunaJobs,
  getAdzunaCredentials,
  getAdzunaQuery,
  mapAdzunaJob,
  sanitiseAdzunaHtml,
  syncAdzunaFeed,
} = await import('./adzunaFeed.js');
const {
  decryptCredentials,
  encryptCredentials,
  maskCredentials,
  mergeCredentialUpdates,
} = await import('../admin/integrations.js');
const {
  hasManagedJobProvenance,
  stripManagedJobProvenance,
} = await import('./jobFeedOwnership.js');

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.operation = 'select';
    this.updateData = null;
  }
  select() { return this; }
  eq(field, value) { this.filters.push(['eq', field, value]); return this; }
  lt(field, value) { this.filters.push(['lt', field, value]); return this; }
  limit() { return this; }
  update(data) { this.operation = 'update'; this.updateData = data; return this; }
  matches(row) {
    return this.filters.every(([op, field, value]) => op === 'eq' ? row[field] === value : String(row[field] || '') < String(value));
  }
  async maybeSingle() {
    const rows = this.db.rows(this.table).filter(row => this.matches(row));
    return { data: rows[0] || null, error: null };
  }
  async upsert(payload) {
    const rows = Array.isArray(payload) ? payload : [payload];
    if (this.table === 'tenant_job_feed_config') {
      for (const row of rows) {
        const current = this.db.configs.get(row.tenant_id) || {};
        this.db.configs.set(row.tenant_id, { ...current, ...row });
      }
    } else if (this.table === 'job_posting') {
      for (const row of rows) {
        const current = this.db.jobs.find(job =>
          job.tenant_id === row.tenant_id &&
          job.external_source === row.external_source &&
          job.external_id === row.external_id
        );
        if (current) Object.assign(current, row);
        else this.db.jobs.push({ id: `job-${this.db.jobs.length + 1}`, ...row });
      }
    }
    return { data: rows, error: null };
  }
  async execute() {
    if (this.operation === 'update') {
      for (const row of this.db.rows(this.table)) {
        if (this.matches(row)) Object.assign(row, this.updateData);
      }
    }
    return { data: null, error: null };
  }
  then(resolve, reject) { return this.execute().then(resolve, reject); }
}

class FakeDb {
  constructor({ integrations = [], configs = [], jobs = [] } = {}) {
    this.integrations = integrations;
    this.configs = new Map(configs.map(row => [row.tenant_id, { ...row }]));
    this.jobs = jobs.map(row => ({ ...row }));
  }
  rows(table) {
    if (table === 'tenant_integrations') return this.integrations;
    if (table === 'tenant_job_feed_config') return [...this.configs.values()];
    if (table === 'job_posting') return this.jobs;
    return [];
  }
  from(table) { return new FakeQuery(this, table); }
}

const sampleJob = (id = 'adz-1', title = 'Careers Adviser') => ({
  id,
  title,
  description: 'Help <strong>graduates</strong>',
  redirect_url: `https://www.adzuna.co.uk/jobs/details/${id}`,
  company: { display_name: 'Example University' },
  location: { display_name: 'London' },
  salary_min: 30000,
  salary_max: 35000,
  contract_type: 'permanent',
  contract_time: 'full_time',
});

test('credentials are encrypted, masked, and masked re-saves preserve secrets', () => {
  const original = { app_id: 'tenant-app-id-1234', app_key: 'tenant-secret-key-5678', country: 'gb' };
  const encrypted = encryptCredentials(original);
  assert.notEqual(encrypted.app_id, original.app_id);
  assert.notEqual(encrypted.app_key, original.app_key);
  assert.equal(JSON.stringify(encrypted).includes(original.app_key), false);

  const decrypted = decryptCredentials(encrypted);
  const masked = maskCredentials(decrypted);
  assert.equal(masked.app_id.includes('****'), true);
  assert.equal(masked.app_key.includes('****'), true);
  assert.equal(masked.country, 'gb');

  const merged = mergeCredentialUpdates(decrypted, { ...masked, country: 'gb' });
  assert.deepEqual(merged, original);
});

test('tenant credential resolution is isolated and disabled tenants return no credentials', async () => {
  const db = new FakeDb({ integrations: [
    { tenant_id: 'tenant-a', integration_type: 'adzuna', is_enabled: true, credentials: { app_id: 'a-id', app_key: 'a-key' } },
    { tenant_id: 'tenant-b', integration_type: 'adzuna', is_enabled: false, credentials: { app_id: 'b-id', app_key: 'b-key' } },
  ] });
  assert.deepEqual(await getAdzunaCredentials('tenant-a', { db }), { app_id: 'a-id', app_key: 'a-key' });
  assert.equal(await getAdzunaCredentials('tenant-b', { db }), null);
  assert.equal(await getAdzunaCredentials('tenant-c', { db }), null);
});

test('query construction uses bounded UK-supported search criteria', () => {
  const params = getAdzunaQuery({
    keywords: 'careers adviser',
    exclusions: 'sales retail',
    category: 'teaching-jobs',
    location: 'Manchester',
    max_days_old: 999,
    result_limit: 500,
  });
  assert.equal(params.get('what'), 'careers adviser');
  assert.equal(params.get('what_exclude'), 'sales retail');
  assert.equal(params.get('category'), 'teaching-jobs');
  assert.equal(params.get('where'), 'Manchester');
  assert.equal(params.get('max_days_old'), '90');
  assert.equal(params.get('results_per_page'), '50');
  assert.equal(params.has('app_key'), false);
});

test('response mapping sanitises content and exposes safe public provenance', () => {
  const mapped = mapAdzunaJob({
    ...sampleJob(),
    description: '<script>steal()</script><img src=x onerror=steal()>Useful & inclusive',
  }, '2026-08-19T10:00:00.000Z');
  assert.equal(mapped.description.includes('script'), false);
  assert.equal(mapped.description.includes('onerror'), false);
  assert.equal(mapped.description.includes('&amp;'), true);
  assert.equal(mapped.external_source, 'adzuna');
  assert.equal(mapped.source_attribution, ADZUNA_ATTRIBUTION);
  assert.equal(mapped.application_value, mapped.external_url);
  assert.equal(mapped.application_value.startsWith('https://'), true);
  assert.equal(mapped.created_date, '2026-08-19T10:00:00.000Z');
  assert.equal(mapped.closing_date, null);
  assert.equal('app_key' in mapped, false);
  assert.equal(mapAdzunaJob({ ...sampleJob(), redirect_url: 'javascript:alert(1)' }), null);
  assert.equal(sanitiseAdzunaHtml('<b>Safe</b>'), 'Safe');
});

test('generic job writes cannot forge provenance while null legacy fields are harmless', () => {
  assert.equal(hasManagedJobProvenance({ title: 'Native', external_source: null }), false);
  assert.equal(hasManagedJobProvenance({ external_source: 'adzuna' }), true);
  assert.deepEqual(
    stripManagedJobProvenance({ title: 'Native', external_source: null, external_id: '' }),
    { title: 'Native' }
  );
});

test('connection failures return safe authentication errors without response bodies', async () => {
  await assert.rejects(
    fetchAdzunaJobs({ app_id: 'id', app_key: 'secret' }, {}, async () => ({
      ok: false, status: 401, text: async () => 'provider response containing secrets',
    })),
    error => error.message === 'Adzuna authentication failed. Check the API ID and key.'
  );
});

test('sync is idempotent, updates repeats, retires stale Adzuna jobs, and leaves native jobs unchanged', async () => {
  const db = new FakeDb({
    integrations: [{ tenant_id: 'tenant-a', integration_type: 'adzuna', is_enabled: true, credentials: { app_id: 'id', app_key: 'key' } }],
    configs: [{ tenant_id: 'tenant-a', keywords: 'careers', result_limit: 25 }],
    jobs: [
      { id: 'native', tenant_id: 'tenant-a', status: 'active', title: 'Native', external_source: null },
      { id: 'old-1', tenant_id: 'tenant-a', status: 'active', title: 'Old title', external_source: 'adzuna', external_id: 'adz-1', external_last_seen_at: '2026-08-18T00:00:00.000Z' },
      { id: 'old-2', tenant_id: 'tenant-a', status: 'active', title: 'Stale', external_source: 'adzuna', external_id: 'adz-2', external_last_seen_at: '2026-08-18T00:00:00.000Z' },
    ],
  });
  let title = 'Updated title';
  const fetcher = async () => ({ ok: true, json: async () => ({ results: [sampleJob('adz-1', title)] }) });

  await syncAdzunaFeed('tenant-a', { db, fetcher, now: () => '2026-08-19T10:00:00.000Z' });
  assert.equal(db.jobs.length, 3);
  assert.equal(db.jobs.find(job => job.id === 'old-1').title, 'Updated title');
  assert.equal(db.jobs.find(job => job.id === 'old-2').status, 'expired');
  assert.equal(db.jobs.find(job => job.id === 'native').status, 'active');

  title = 'Updated again';
  await syncAdzunaFeed('tenant-a', { db, fetcher, now: () => '2026-08-19T11:00:00.000Z' });
  assert.equal(db.jobs.length, 3);
  assert.equal(db.jobs.find(job => job.id === 'old-1').title, 'Updated again');
  assert.equal(db.configs.get('tenant-a').last_error, null);
});

test('failed refresh leaves the last good imported and native jobs available', async () => {
  const db = new FakeDb({
    integrations: [{ tenant_id: 'tenant-a', integration_type: 'adzuna', is_enabled: true, credentials: { app_id: 'id', app_key: 'key' } }],
    configs: [{ tenant_id: 'tenant-a' }],
    jobs: [
      { id: 'native', tenant_id: 'tenant-a', status: 'active', external_source: null },
      { id: 'external', tenant_id: 'tenant-a', status: 'active', external_source: 'adzuna', external_id: 'adz-1', external_last_seen_at: '2026-08-18T00:00:00.000Z' },
    ],
  });
  const before = structuredClone(db.jobs);
  await assert.rejects(syncAdzunaFeed('tenant-a', {
    db,
    fetcher: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    now: () => '2026-08-19T12:00:00.000Z',
  }), /Adzuna is unavailable/);
  assert.deepEqual(db.jobs, before);
});