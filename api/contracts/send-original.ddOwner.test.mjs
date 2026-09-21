import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const fixtureSlot = '__sendOriginalDdOwnerFixture';

async function loadHandler() {
  const result = await build({
    entryPoints: [new URL('./send-original.js', import.meta.url).pathname],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    plugins: [{
      name: 'send-original-controlled-dependencies',
      setup(builder) {
        builder.onResolve({ filter: /database\.js$/ }, () => ({
          path: 'database',
          namespace: 'fixture',
        }));
        builder.onResolve({ filter: /emailService\.js$/ }, () => ({
          path: 'emailService',
          namespace: 'fixture',
        }));
        builder.onResolve({ filter: /tenantContext\.js$/ }, () => ({
          path: 'tenantContext',
          namespace: 'fixture',
        }));
        builder.onResolve({ filter: /contractPlaceholders\.js$/ }, () => ({
          path: 'contractPlaceholders',
          namespace: 'fixture',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => {
          const fixture = `globalThis.${fixtureSlot}`;
          if (path === 'database') {
            return {
              contents: `export const supabase = { from: (...args) => ${fixture}.db.from(...args) };`,
              loader: 'js',
            };
          }
          if (path === 'emailService') {
            return {
              contents: `export const sendEmail = (...args) => ${fixture}.sendEmail(...args);`,
              loader: 'js',
            };
          }
          if (path === 'tenantContext') {
            return {
              contents: `export const getTenantContext = (...args) => ${fixture}.getTenantContext(...args);`,
              loader: 'js',
            };
          }
          return {
            contents: `
              export const buildContractBracketPlaceholders = async () => ({});
              export const replaceContractBracketPlaceholders = text => text;
            `,
            loader: 'js',
          };
        });
      },
    }],
  });

  const bundled = result.outputFiles[0].text;
  return (await import(`data:text/javascript;base64,${Buffer.from(bundled).toString('base64')}`)).default;
}

function createFixture({ assignedOwner = true } = {}) {
  const tenantId = 'tenant-dd-owner';
  const submissionId = 'submission-dd-owner';
  const formId = 'form-dd';
  const contractId = 'contract-1';
  const rows = {
    contract_instance: [{
      id: contractId,
      tenant_id: tenantId,
      form_submission_id: submissionId,
      source_contact_field_id: 'contact-field',
      form_id: 'contract-form',
      signers: [],
      status: 'draft',
    }],
    form_submission: [{
      id: submissionId,
      tenant_id: tenantId,
      organization_id: 'organization-1',
      form_id: formId,
    }],
    form: [{
      id: 'contract-form',
      tenant_id: tenantId,
      name: 'Representative agreement',
      description: '',
      slug: 'representative-agreement',
      contract_settings: {
        initial_email_template_id: 'owner-template',
        source_dd_form_id: formId,
      },
    }],
    tenant: [{ id: tenantId, slug: 'tenant-dd-owner' }],
    email_template: [{
      id: 'owner-template',
      tenant_id: tenantId,
      subject: 'Agreement owner: {{dd_owner}} ({{dd_owner_email}})',
      body: '<p>Contact {{ dd_owner }} at {{ dd_owner_email }}</p>',
    }],
    form_submission_due_diligence: assignedOwner ? [{
      form_submission_id: submissionId,
      tenant_id: tenantId,
      owner_name: 'Assigned Owner',
      owner_member_id: 'member-owner',
    }] : [],
    member: assignedOwner ? [{
      id: 'member-owner',
      tenant_id: tenantId,
      email: 'assigned.owner@example.test',
    }] : [],
    form_due_diligence_config: [{
      form_id: formId,
      tenant_id: tenantId,
      default_owner_name: 'Default DD Owner',
    }],
  };
  const queries = [];
  const sent = [];

  const db = {
    from(table) {
      assert.ok(table in rows, `Unexpected table: ${table}`);
      const record = { table, select: null, terminal: null };
      queries.push(record);
      let filters = [];
      let operation = 'select';
      let updateValue;
      let singular = false;
      const query = {
        select(columns = '*') {
          record.select = columns;
          return query;
        },
        eq(column, value) {
          filters.push(row => row[column] === value);
          return query;
        },
        in(column, values) {
          filters.push(row => values.includes(row[column]));
          return query;
        },
        is(column, value) {
          filters.push(row => (row[column] ?? null) === value);
          return query;
        },
        single() {
          singular = true;
          record.terminal = 'single';
          return query;
        },
        maybeSingle() {
          singular = true;
          record.terminal = 'maybeSingle';
          return query;
        },
        update(value) {
          operation = 'update';
          updateValue = value;
          return query;
        },
        then(resolve, reject) {
          const selected = rows[table].filter(row => filters.every(filter => filter(row)));
          if (operation === 'update') {
            selected.forEach(row => Object.assign(row, updateValue));
          }
          return Promise.resolve({
            data: singular ? selected[0] || null : selected,
            error: null,
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };

  return {
    db,
    queries,
    sent,
    getTenantContext: async () => ({ tenantId }),
    sendEmail: async message => {
      sent.push(message);
      return { success: true };
    },
  };
}

function responseRecorder() {
  return {
    statusCode: null,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

async function invoke(handler, fixture) {
  globalThis[fixtureSlot] = fixture;
  const req = {
    method: 'POST',
    body: {
      formSubmissionId: 'submission-dd-owner',
      fieldId: 'contact-field',
      contractFormId: 'contract-form',
      signer: {
        firstName: 'Contract',
        lastName: 'Signer',
        email: 'signer@example.test',
      },
    },
  };
  const res = responseRecorder();
  await handler(req, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  assert.equal(fixture.sent.length, 1);
  return fixture.sent[0];
}

assert.equal(process.env.TEST_ISOLATION_ACTIVE, '1', 'Run through scripts/run-isolated-tests.mjs');
const handler = await loadHandler();

test('send-original resolves assigned DD owner placeholders through the real helper', async () => {
  const fixture = createFixture();
  const email = await invoke(handler, fixture);

  assert.equal(email.subject, 'Agreement owner: Assigned Owner (assigned.owner@example.test)');
  assert.equal(email.html, '<p>Contact Assigned Owner at assigned.owner@example.test</p>');

  const assignment = fixture.queries.find(query => query.table === 'form_submission_due_diligence');
  const member = fixture.queries.find(query => query.table === 'member');
  assert.deepEqual(
    { select: assignment.select, terminal: assignment.terminal },
    { select: 'owner_name, owner_member_id', terminal: 'maybeSingle' },
  );
  assert.deepEqual(
    { select: member.select, terminal: member.terminal },
    { select: 'email', terminal: 'maybeSingle' },
  );
});

test('send-original uses the configured default DD owner when no assignment exists', async () => {
  const fixture = createFixture({ assignedOwner: false });
  const email = await invoke(handler, fixture);

  assert.equal(email.subject, 'Agreement owner: Default DD Owner ()');
  assert.equal(email.html, '<p>Contact Default DD Owner at </p>');
  const assignment = fixture.queries.find(query => query.table === 'form_submission_due_diligence');
  const configuration = fixture.queries.find(query => query.table === 'form_due_diligence_config');
  assert.equal(assignment.terminal, 'maybeSingle');
  assert.deepEqual(
    { select: configuration.select, terminal: configuration.terminal },
    { select: 'default_owner_name', terminal: 'maybeSingle' },
  );
});