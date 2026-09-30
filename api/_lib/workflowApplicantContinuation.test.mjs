import test from 'node:test';
import assert from 'node:assert/strict';
import { issueWorkflowApplicantContinuationLinks } from './workflowApplicantContinuation.js';

const tenantId = 'tenant-gfi';
const organizationId = 'organization-gfi';
const policy = { version: 1, mode: 'applicant_continuation' };
const forms = new Map([
  ['university-application', {
    id: 'university-form', tenant_id: tenantId, slug: 'university-application',
    is_active: true, require_authentication: false, mutation_access_policy: policy,
    entity_pipelines: { organisations: [{
      id: 'org-pipeline',
      mappings: [{ target_type: 'custom', target_field: 'application-status' }],
    }] },
  }],
  ['partner-application', {
    id: 'partner-form', tenant_id: tenantId, slug: 'partner-application',
    is_active: true, require_authentication: false, mutation_access_policy: null,
    entity_pipelines: { organisations: [{
      id: 'org-pipeline',
      mappings: [{ target_type: 'custom', target_field: 'application-status' }],
    }] },
  }],
]);

function queryFor(row) {
  return {
    select() { return this; },
    eq() { return this; },
    async maybeSingle() { return { data: row, error: null }; },
  };
}

function db() {
  return {
    from(table) {
      if (table === 'tenant') {
        return queryFor({ id: tenantId, slug: 'gfi', domain: 'graduatefutures.org' });
      }
      if (table === 'form') {
        const query = queryFor(null);
        query.eq = function eq(key, value) {
          if (key === 'slug') this.slug = value;
          return this;
        };
        query.maybeSingle = async function maybeSingle() {
          return { data: forms.get(this.slug) || null, error: null };
        };
        return query;
      }
      throw new Error(`Unexpected table ${table}`);
    },
  };
}

test('issues both GFI workflow URL shapes for explicit and legacy-null policy forms', async () => {
  const issued = [];
  const issueContinuation = async ({ form, organizationId: org, issuedBy }) => {
    issued.push([form.slug, org, issuedBy]);
    return { applicant_continuation_token: `token-${form.slug}` };
  };
  const html = [
    `<a href="https://graduatefutures.org/FormView?slug=partner-application&amp;organization_id=${organizationId}">Partner</a>`,
    `<a href="https://www.graduatefutures.org/FormView?slug=university-application&amp;organization_id=${organizationId}">University</a>`,
    `<a href="/university-application?organization_id=${organizationId}">Safe path</a>`,
  ].join('');
  const result = await issueWorkflowApplicantContinuationLinks({
    html, tenantId, entityType: 'organization', organizationId, db: db(), issueContinuation,
    issuedBy: 'trusted_workflow:workflow-gfi',
  });

  assert.match(result, /partner-application&amp;organization_id=organization-gfi&amp;applicant_continuation_token=token-partner-application/);
  assert.match(result, /university-application&amp;organization_id=organization-gfi&amp;applicant_continuation_token=token-university-application/);
  assert.match(result, /\/university-application\?organization_id=organization-gfi&applicant_continuation_token=token-university-application/);
  assert.deepEqual(issued, [
    ['partner-application', organizationId, 'trusted_workflow:workflow-gfi'],
    ['university-application', organizationId, 'trusted_workflow:workflow-gfi'],
  ]);
});

test('does not issue for hostile, mismatched, or non-organisation links', async () => {
  const hostile = [
    `<a href="https://evil.example/FormView?slug=university-application&organization_id=${organizationId}">external</a>`,
    `<a href="//graduatefutures.org/FormView?slug=university-application&organization_id=${organizationId}">scheme-relative</a>`,
    '<a href="https://graduatefutures.org/FormView?slug=university-application&organization_id=other">other org</a>',
    `<a href="http://graduatefutures.org/FormView?slug=university-application&organization_id=${organizationId}">http</a>`,
    `<a href="https://graduatefutures.org:8443/FormView?slug=university-application&organization_id=${organizationId}">port</a>`,
    `<a href="https://user:password@graduatefutures.org/FormView?slug=university-application&organization_id=${organizationId}">credentials</a>`,
    `<a href="https://graduatefutures.org/FormView?slug=university-application&slug=partner-application&organization_id=${organizationId}">duplicate slug</a>`,
    `<a href="https://graduatefutures.org/FormView?slug=university-application&organization_id=${organizationId}&organization_id=other">duplicate org</a>`,
  ].join('');
  let issued = 0;
  const options = {
    html: hostile, tenantId, entityType: 'organization', organizationId, db: db(),
    issueContinuation: async () => { issued += 1; return { applicant_continuation_token: 'secret' }; },
  };
  assert.equal(await issueWorkflowApplicantContinuationLinks(options), hostile);
  assert.equal(issued, 0);
  assert.equal(await issueWorkflowApplicantContinuationLinks({
    ...options, entityType: 'member',
    html: `<a href="/university-application?organization_id=${organizationId}">member</a>`,
  }), `<a href="/university-application?organization_id=${organizationId}">member</a>`);
  assert.equal(issued, 0);
});

test('does not issue when a form lookup returns another tenant', async () => {
  const crossTenantDb = db();
  const originalFrom = crossTenantDb.from.bind(crossTenantDb);
  crossTenantDb.from = (table) => {
    if (table !== 'form') return originalFrom(table);
    return queryFor({
      ...forms.get('university-application'),
      tenant_id: 'other-tenant',
    });
  };
  let issued = 0;
  const html = `<a href="/university-application?organization_id=${organizationId}">other tenant</a>`;
  const result = await issueWorkflowApplicantContinuationLinks({
    html, tenantId, entityType: 'organization', organizationId, db: crossTenantDb,
    issueContinuation: async () => { issued += 1; return { applicant_continuation_token: 'secret' }; },
  });
  assert.equal(result, html);
  assert.equal(issued, 0);
});