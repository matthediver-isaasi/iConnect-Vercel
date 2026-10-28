import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { Packer } from 'docx';
import handler, { sendSubmitterCopyEmail } from './send-submitter-copy.js';
import { prepareSubmitterCopy } from '../_lib/submitterCopyProjection.js';
import { buildSubmissionsDocument } from '../../client/src/lib/formSubmissionWordExport.js';
import { compatibilityForm, submitThroughRealProcessor } from '../public/formSubmissionCompatibility.helpers.mjs';

function fixture() {
  const rowRule = { mode: 'show_when', source_field_id: 'choice', value: 'yes' };
  const form = {
    id: 'form', tenant_id: 'tenant', name: 'Example', allow_submitter_email_copy: true,
    pages: [{ id: 'private-page', starts_hidden: true }],
    fields: [
      { id: 'trigger', type: 'text', starts_hidden: true, label: 'Private trigger' },
      { id: 'secret', type: 'file', starts_hidden: true, label: 'Private upload' },
      { id: 'conditional', type: 'text', label: 'Conditional private' },
      { id: 'page-secret', type: 'text', page_id: 'private-page', label: 'Private page field' },
      { id: 'revealed', type: 'text', starts_hidden: true, label: 'Revealed answer' },
      { id: 'blank', type: 'text', label: 'Visible blank' },
      { id: 'zero', type: 'number', label: 'Visible zero' },
      { id: 'false', type: 'boolean', label: 'Visible false' },
      { id: 'rows', type: 'repeatable_rows', label: 'Visible rows', children: [
        { id: 'choice', type: 'dropdown', options: ['yes', 'no'], starts_hidden: true, label: 'Hidden row source' },
        { id: 'detail', type: 'text', label: 'Row detail', row_visibility: rowRule },
        { id: 'upload', type: 'file', label: 'Row upload', row_visibility: rowRule },
        { id: 'org', type: 'organisation_dropdown', label: 'Organisation' },
        { id: 'blank', type: 'text', label: 'Blank cell' },
        { id: 'zero', type: 'number', label: 'Zero cell' },
        { id: 'false', type: 'boolean', label: 'False cell' },
      ] },
      { id: 'hidden-rows', type: 'repeatable_rows', starts_hidden: true, label: 'Hidden container',
        children: [{ id: 'hidden-child', type: 'file', label: 'Hidden child label' }] },
    ],
    visibility_rules: [{
      trigger_field_id: 'trigger', operator: 'equals', value: 'go',
      actions: [{ action_type: 'show', target_field_ids: ['revealed'] },
        { action_type: 'hide', target_field_ids: ['conditional'] }],
    }],
  };
  const file = name => ({ file_name: name, file_url: `https://files.test/${name}` });
  const submission = {
    id: 'submission', form_id: form.id, tenant_id: form.tenant_id,
    created_date: '2026-01-01T12:00:00Z',
    submission_data: {
      trigger: 'go', secret: file('private-root.pdf'), conditional: 'retained-conditional',
      'page-secret': 'retained-page', revealed: 'Now visible', zero: 0, false: false,
      rows: [
        { choice: 'no', detail: 'retained-row', upload: file('private-row.pdf'), org: 'org-1', zero: 0, false: false },
        { choice: 'yes', detail: 'Visible detail', upload: file('visible.pdf'), org: 'org-1' },
      ],
      'hidden-rows': [{ 'hidden-child': file('private-container.pdf') }],
    },
  };
  return { form, submission };
}

function database(form, submission, version = null) {
  return { from(table) {
    const filters = [];
    const rows = table === 'form' ? [form] : table === 'form_submission' ? [submission]
      : table === 'survey_version' ? (version ? [version] : [])
      : table === 'organization' ? [{ id: 'org-1', tenant_id: form.tenant_id, name: 'Readable organisation' }]
      : table === 'tenant' ? [{ id: form.tenant_id, name: 'Example tenant' }] : [];
    const result = single => {
      const found = rows.filter(row => filters.every(([key, value]) => row[key] === value));
      return { data: single ? found[0] || null : found, error: null };
    };
    const query = {
      select() { return this; }, eq(key, value) { filters.push([key, value]); return this; },
      in() { return this; }, order() { return this; },
      single: async () => result(true), maybeSingle: async () => result(true),
      then(resolve, reject) { return Promise.resolve(result(false)).then(resolve, reject); },
    };
    return query;
  } };
}

async function unpack(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  return (await Promise.all(Object.values(zip.files).filter(f => !f.dir && /\.(xml|rels)$/.test(f.name))
    .map(f => f.async('string')))).join('\n');
}
function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
}

test('actual mailed DOCX omits hidden labels, retained values and file relationships; admin stays complete', async () => {
  const { form, submission } = fixture();
  const before = structuredClone({ form, submission });
  let mail;
  const result = await sendSubmitterCopyEmail({ form, submission, recipientEmail: 'copy@example.test' }, {
    supabase: database(form, submission), buildInboxDelivery: async () => ({}),
    sendEmail: async value => { mail = value; return { success: true }; },
  });
  assert.equal(result.success, true);
  const xml = await unpack(mail.attachments[0].data);
  for (const hidden of ['Private trigger', 'Private upload', 'Conditional private', 'Private page field',
    'retained-conditional', 'retained-page', 'Hidden row source', 'retained-row', 'private-row.pdf',
    'private-root.pdf', 'Hidden container', 'Hidden child label', 'private-container.pdf']) {
    assert.ok(!xml.includes(hidden), hidden);
  }
  for (const visible of ['Revealed answer', 'Now visible', 'Visible blank', 'Visible zero', 'Visible false',
    'Blank cell: -', 'Zero cell: 0', 'False cell: No', 'Readable organisation', 'visible.pdf']) {
    assert.ok(xml.includes(visible), visible);
  }
  assert.equal((xml.match(/Row detail:/g) || []).length, 1);
  assert.deepEqual({ form, submission }, before);
  const admin = await unpack(await Packer.toBuffer(buildSubmissionsDocument({
    submissions: [submission], formsById: { [form.id]: form },
    selectedOptions: form.fields.map(f => ({ key: f.id, label: f.label })),
    resolvers: { resolveFile: raw => ({ name: raw.file_name, url: raw.file_url }) },
  })));
  for (const retained of ['Private upload', 'private-root.pdf', 'retained-row', 'Hidden row source', 'Hidden child label']) {
    assert.ok(admin.includes(retained), retained);
  }
  assert.equal((admin.match(/Row detail:/g) || []).length, 2);
});

test('internal endpoint loads full configuration and the saved survey version, ignores forged hidden ids', async () => {
  const { form, submission } = fixture();
  const version = { id: 'version', form_id: form.id, tenant_id: form.tenant_id,
    fields: form.fields, pages: form.pages, visibility_rules: form.visibility_rules };
  submission.survey_version_id = version.id;
  form.fields = [{ id: 'secret', type: 'file', label: 'WRONG LIVE CONFIG' }];
  const previous = process.env.INTERNAL_API_SECRET;
  process.env.INTERNAL_API_SECRET = 'fixture-only-secret';
  try {
    let mail;
    const res = response();
    await handler({ method: 'POST', body: { internalToken: 'fixture-only-secret', form_id: form.id,
      submission_id: submission.id, recipient_email: 'copy@example.test', hiddenFieldIds: [] } }, res, {
      supabase: database(form, submission, version), buildInboxDelivery: async () => ({}),
      sendEmail: async value => { mail = value; return { success: true }; },
    });
    assert.equal(res.body.success, true);
    const xml = await unpack(mail.attachments[0].data);
    assert.ok(xml.includes('Revealed answer'));
    assert.ok(!xml.includes('private-root.pdf'));
    assert.ok(!xml.includes('WRONG LIVE CONFIG'));
  } finally {
    if (previous === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = previous;
  }
});

test('availability hiding uses raw earlier answers, not projected sources or sibling selection', async () => {
  const { form, submission } = fixture();
  form.fields = [
    { id: 'primary', type: 'organisation_dropdown', starts_hidden: true },
    { id: 'rows', type: 'repeatable_rows', hide_when_first_column_empty: true, children: [
      { id: 'org', type: 'organisation_dropdown', exclude_values_from: { scope: 'form', source_field_id: 'primary' } },
    ] },
  ];
  submission.submission_data.primary = 'org-1';
  const copy = await prepareSubmitterCopy({ db: database(form, submission), form, submission });
  assert.deepEqual(copy.form.fields, []);
  assert.deepEqual(copy.submission.submission_data, {});
});

test('privacy, missing version and delivery failures never send an unsafe copy', async () => {
  const { form, submission } = fixture();
  let sends = 0;
  const dependencies = { supabase: database(form, submission), buildInboxDelivery: async () => ({}),
    sendEmail: async () => { sends++; throw new Error('mock delivery failure'); } };
  const args = { form, submission, recipientEmail: 'copy@example.test' };
  assert.equal((await sendSubmitterCopyEmail(args, dependencies)).success, false);
  assert.equal(sends, 1);
  submission.survey_version_id = 'missing';
  assert.equal((await sendSubmitterCopyEmail(args, dependencies)).success, false);
  assert.equal(sends, 1);
  form.form_type = 'survey';
  const version = { id: 'missing', form_id: form.id, tenant_id: form.tenant_id,
    survey_settings: { anonymous_completion_version: 1, response_identity: 'anonymous' } };
  dependencies.supabase = database(form, submission, version);
  assert.equal((await sendSubmitterCopyEmail(args, dependencies)).success, false);
  assert.equal(sends, 1);
});

test('public submission passes full visibility context, honors opt-in and survives copy failure', async () => {
  for (const [enabled, requested, email, expected] of [
    [true, true, 'copy@example.test', 1], [false, true, 'copy@example.test', 0],
    [true, false, 'copy@example.test', 0], [true, true, 'invalid', 0],
  ]) {
    const form = { ...compatibilityForm(), form_type: 'standard', entity_action: 'none',
      organization_entity_action: 'none', entity_pipelines: { members: [], organisations: [] },
      allow_submitter_email_copy: enabled, fields: [{ id: 'answer', type: 'text' }],
      pages: [{ id: 'page' }], visibility_rules: [] };
    let calls = 0;
    const result = await submitThroughRealProcessor({
      form, submissionData: { answer: 'Saved answer' },
      requestBodyOverrides: { submitterCopyRequested: requested, submitterCopyEmail: email },
      sendSubmitterCopyEmail: async args => {
        calls++;
        assert.deepEqual(args.form.pages, form.pages);
        assert.deepEqual(args.form.visibility_rules, form.visibility_rules);
        assert.deepEqual(args.visibilityOptions, {});
        assert.equal(args.submission.submission_data.answer, 'Saved answer');
        throw new Error('mock copy failure');
      },
    });
    assert.equal(result.response.statusCode, 201);
    assert.equal(calls, expected);
    assert.equal(result.insertedSubmissions[0].submission_data.answer, 'Saved answer');
  }
});

test('public submission entry path generates a respondent-only attachment from stored raw answers', async () => {
  const fixtureData = fixture();
  const form = { ...compatibilityForm(), ...fixtureData.form, form_type: 'standard',
    entity_action: 'none', organization_entity_action: 'none',
    entity_pipelines: { members: [], organisations: [] } };
  // Public row validation intentionally rejects forged hidden file metadata;
  // keep this end-to-end fixture scalar, with nested output covered above.
  form.fields = form.fields.filter(f => !['rows', 'hidden-rows', 'secret'].includes(f.id));
  const answers = { trigger: 'go', conditional: 'retained-conditional', 'page-secret': 'retained-page',
    revealed: 'Now visible', zero: 0, false: false };
  let mail;
  const result = await submitThroughRealProcessor({
    form, submissionData: answers,
    requestBodyOverrides: { submitterCopyRequested: true, submitterCopyEmail: 'copy@example.test' },
    sendSubmitterCopyEmail: args => sendSubmitterCopyEmail(args, {
      supabase: database(form, args.submission), buildInboxDelivery: async () => ({}),
      sendEmail: async value => { mail = value; return { success: true }; },
    }),
  });
  assert.equal(result.response.statusCode, 201);
  const xml = await unpack(mail.attachments[0].data);
  assert.ok(xml.includes('Revealed answer'));
  assert.ok(!xml.includes('retained-conditional'));
  assert.ok(!xml.includes('retained-page'));
  assert.equal(result.insertedSubmissions[0].submission_data.conditional, 'retained-conditional');
});

test('conditional pages, LMIC context, legacy nested children and hidden email metadata', async () => {
  const { form, submission } = fixture();
  form.pages[0].starts_hidden = false;
  form.visibility_rules.push({
    trigger_field_id: 'country', operator: 'is_lmic',
    actions: [{ action_type: 'visibility', field_states: { 'private-page': { visible: false } } }],
  });
  form.fields.push({ id: 'internal-email', type: 'email', starts_hidden: true, label: 'Internal email' });
  const rows = form.fields.find(f => f.id === 'rows');
  rows.config = { children: rows.children };
  delete rows.children;
  submission.submission_data.country = 'India';
  submission.submission_data['internal-email'] = 'internal@example.test';
  submission.submitted_by_email = 'internal@example.test';
  let mail;
  const result = await sendSubmitterCopyEmail({
    form, submission, recipientEmail: 'copy@example.test', visibilityOptions: { lmicCodes: ['IN'] },
  }, {
    supabase: database(form, submission), buildInboxDelivery: async () => ({}),
    sendEmail: async value => { mail = value; return { success: true }; },
  });
  assert.equal(result.success, true);
  const xml = await unpack(mail.attachments[0].data);
  for (const hidden of ['retained-page', 'internal@example.test', 'private-row.pdf', 'Hidden row source']) {
    assert.ok(!xml.includes(hidden), hidden);
  }
});
