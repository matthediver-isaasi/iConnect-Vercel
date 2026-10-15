import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./campaignSurveyDelivery.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/export /g, '');

function fixture(linkAssignmentId = 'assignment', hasList = false) {
  const writes = [];
  let requestedAssignment;
  const db = { from(table) {
    const query = {
      select() { return query; }, eq() { return query; }, ilike() { return query; },
      order() { return query; }, limit() { return query; },
      insert(value) { writes.push({ table, value }); return query; },
      update(value) { writes.push({ table, value }); return query; },
      single() { return Promise.resolve({ data: table === 'tenant'
        ? { id: 'tenant', slug: 'fixture' } : { id: 'delivery' } }); },
      then(resolve) { return Promise.resolve({ data: table === 'booking'
        ? [{ id: 'booking', attendee_email: 'source@example.org' }] : null }).then(resolve); },
    };
    return query;
  } };
  const context = vm.createContext({
    resolveEventEmailContext: async () => {},
    usesEventSurvey: () => true,
    replaceEventSurvey: text => text,
    resolveCampaignEventSurveySelection: async () => ({
      assignmentId: 'assignment', url: 'https://fixture.dev.iconn.app/survey/token',
    }),
    prepareCertificateSurveyLinks: async options => {
      requestedAssignment = options.assignmentId;
      return { html: 'survey list', links: [{
        assignmentId: linkAssignmentId,
        assignmentUrl: 'https://fixture.example.org/survey/token',
        url: 'https://fixture.example.org/survey/token#certificate_grant=test-only',
      }] };
    },
  });
  vm.runInContext(source, context);
  return {
    writes, requested: () => requestedAssignment,
    run: () => context.prepareCampaignSurveyDelivery({
      db, campaign: { id: 'campaign', html_content: '<a href="{{event_survey_url}}">Survey</a>'
        + (hasList ? '{{event_survey_list}}' : ''),
      event_survey_context: { event_type: 'event', event_id: 'event' } },
      tenantId: 'tenant', recipient: { email: 'source@example.org' },
      destination: 'tester@example.org', test: true,
    }),
  };
}

test('same assignment matches across preview and canonical domains, with or without survey list', async () => {
  for (const hasList of [false, true]) {
    const f = fixture('assignment', hasList);
    const result = await f.run();
    assert.match(result.html, /https:\/\/fixture\.example\.org\/survey\/token#certificate_grant=test-only/);
    assert.equal(f.requested(), hasList ? null : 'assignment');
    assert.equal(f.writes[0].value.destination_email, 'tester@example.org');
    assert.equal(f.writes[0].value.source_email, 'source@example.org');
  }
});

test('different assignment still fails and marks the delivery failed', async () => {
  const f = fixture('different-assignment');
  await assert.rejects(f.run(), /selected campaign survey is no longer available/);
  assert.equal(f.writes.at(-1).value.status, 'failed');
});
