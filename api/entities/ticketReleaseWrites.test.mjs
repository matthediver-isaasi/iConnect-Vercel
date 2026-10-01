import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { validateTicketRelease } from '../../shared/ticketRelease.js';

const createSource = readFileSync(new URL('./[entity]/index.js', import.meta.url), 'utf8');
const patchSource = readFileSync(new URL('./[entity]/[id].js', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Execute the actual authorization + validation sections, with the external
// authorizer/database stubbed. This avoids loading unrelated entity workflows.
const createSection = createSource.slice(
  createSource.indexOf('      // Task #1519: Group-Admin event-write authorization + guardrails.'),
  createSource.indexOf("      if (entityNorm === 'membergroup' && tenantCtx.tenantId)"),
);
const patchSection = patchSource.slice(
  patchSource.indexOf('      // Task #1519: Group-Admin event-write authorization + guardrails on update.'),
  patchSource.indexOf('      // Task #1588: Group-Admin resource-write authorization on update.'),
);

async function validateWrite({ method = 'POST', entity = 'complexeventticketclass', body = {}, existing = {}, denied = false, authorizedBody, lookupError = null }) {
  const trace = [];
  const sanitizedBody = structuredClone(body);
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
  const query = {
    select() { return query; },
    eq(key, value) { trace.push(`filter:${key}:${value}`); return query; },
    async maybeSingle() { return { data: existing, error: lookupError }; },
  };
  const context = {
    entity, entityNorm: entity, entityNormalized: entity, sanitizedBody,
    tenantCtx: { tenantId: 'tenant-a' }, req: {}, res, tableName: entity, id: 'ticket-a',
    supabase: { from() { return query; } },
    isEventFamilyEntity: () => true,
    authorizeGroupAdminEventWrite: async () => {
      trace.push('authorize');
      return denied ? { ok: false, status: 403, error: 'Denied' } : { ok: true, body: authorizedBody ?? sanitizedBody };
    },
    validateTicketRelease: ticket => {
      trace.push('validate');
      return validateTicketRelease(ticket);
    },
    persist: () => { trace.push('write'); },
  };
  const section = method === 'PATCH' ? patchSection : createSection;
  await new AsyncFunction(...Object.keys(context), `${section}\npersist();`)(...Object.values(context));
  return { res, trace, body: sanitizedBody };
}

const release = { release_at: '2035-07-01T09:00:00.000Z', release_timezone: 'Europe/London' };

test('release validation follows event authorization and precedes actual writes', () => {
  assert.ok(createSection.includes('validateTicketRelease(ticket)'));
  assert.ok(patchSection.includes('validateTicketRelease(ticket)'));
  assert.ok(createSource.indexOf('validateTicketRelease(ticket)') < createSource.indexOf('.insert(sanitizedBody)'));
  assert.ok(patchSource.indexOf('validateTicketRelease(ticket)') < patchSource.indexOf('.update(sanitizedBody)'));
});

for (const entity of ['event', 'complexeventticketclass']) {
  const payload = ticket => entity === 'event' ? { pricing_config: { ticket_classes: [ticket] } } : ticket;
  for (const method of ['POST', 'PATCH']) {
    test(`${method} ${entity}: authorized schedule and legacy tickets pass, malformed schedules fail before writes`, async () => {
      for (const ticket of [{ name: 'Legacy' }, release, { release_at: null, release_timezone: null }]) {
        const result = await validateWrite({ method, entity, body: payload(ticket) });
        assert.equal(result.res.statusCode, 200);
        assert.deepEqual(result.trace.filter(x => !x.startsWith('filter:')), ['authorize', 'validate', 'write']);
      }
      for (const ticket of [
        { release_at: release.release_at },
        { release_timezone: 'Europe/London' },
        { ...release, release_timezone: 'Not/AZone' },
        { ...release, release_at: '2035-02-30T09:00:00Z' },
        { ...release, release_at: '2035-07-01T09:00' },
      ]) {
        const result = await validateWrite({ method, entity, body: payload(ticket) });
        assert.equal(result.res.statusCode, 400);
        assert.ok(result.res.body.error);
        assert.ok(!result.trace.includes('write'));
      }
    });

    test(`${method} ${entity}: denial occurs before release validation`, async () => {
      const result = await validateWrite({ method, entity, body: payload({ release_at: 'bad' }), denied: true });
      assert.equal(result.res.statusCode, 403);
      assert.ok(!result.trace.includes('validate'));
      assert.ok(!result.trace.includes('write'));
    });
  }
}

test('authorized body, not raw request, is validated and persisted', async () => {
  const result = await validateWrite({ body: { release_at: 'bad' }, authorizedBody: release });
  assert.equal(result.res.statusCode, 200);
  assert.deepEqual(result.body, release);
});

test('complex PATCH validates the merged schedule, including partial clears', async () => {
  for (const body of [{ name: 'Renamed' }, { release_timezone: 'America/New_York' }, { release_at: '2036-01-01T12:00:00Z' }]) {
    const result = await validateWrite({ method: 'PATCH', body, existing: release });
    assert.equal(result.res.statusCode, 200);
    assert.ok(result.trace.includes('filter:tenant_id:tenant-a'));
  }
  for (const body of [{ release_at: null }, { release_timezone: null }]) {
    const result = await validateWrite({ method: 'PATCH', body, existing: release });
    assert.equal(result.res.statusCode, 400);
    assert.ok(!result.trace.includes('write'));
  }
  const cleared = await validateWrite({
    method: 'PATCH', existing: release, body: { release_at: null, release_timezone: null },
  });
  assert.equal(cleared.res.statusCode, 200);
});

test('simple PATCH validates retained pricing config but treats supplied JSON as a replacement', async () => {
  const existing = { pricing_config: { ticket_classes: [{ release_at: 'bad' }] } };
  const retained = await validateWrite({ method: 'PATCH', entity: 'event', existing, body: { title: 'Renamed' } });
  assert.equal(retained.res.statusCode, 400);
  const replaced = await validateWrite({
    method: 'PATCH', entity: 'event', existing,
    body: { pricing_config: { ticket_classes: [release] } },
  });
  assert.equal(replaced.res.statusCode, 200);
});

test('PATCH fails closed if the authorized existing row cannot be loaded', async () => {
  for (const [existing, lookupError, status] of [[null, null, 404], [null, { message: 'Lookup failed' }, 500]]) {
    const result = await validateWrite({ method: 'PATCH', existing, lookupError, body: release });
    assert.equal(result.res.statusCode, status);
    assert.ok(!result.trace.includes('write'));
  }
});