import assert from 'node:assert/strict';
import { test } from 'node:test';
import Module from 'node:module';
import { readFile } from 'node:fs/promises';
import { build, transform } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Isolated entity/query boundaries: these tests never contact a tenant.
const fixtureBundle = await build({
  stdin: {
    contents: `export { default as Notice } from './client/src/components/surveys/AssignmentVersionNotice.jsx';
      export { state } from '@tanstack/react-query';
      export { calls } from '@/api/base44Client';`,
    resolveDir: process.cwd(), loader: 'js',
  },
  bundle: true, write: false, packages: 'external', external: ['react', 'react/jsx-runtime'], platform: 'node', format: 'cjs',
  jsx: 'automatic', logLevel: 'silent',
  plugins: [{
    name: 'version-fixtures',
    setup(builder) {
      builder.onResolve({ filter: /^(@tanstack\/react-query|@\/api\/base44Client|@\/components\/ui\/badge)$/ },
        args => ({ path: args.path, namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
        contents: path.includes('react-query')
          ? `export const state = { form: {}, versions: {}, queries: [] };
             export function useQuery(options) {
               state.queries.push(options);
               return options.queryKey[0] === 'survey-assignment-version-form' ? state.form : state.versions;
             }`
          : path.includes('base44Client')
            ? `export const calls = [];
               export const base44 = { entities: Object.fromEntries(['Form', 'SurveyVersion'].map(name =>
                 [name, { filter: async criteria => { calls.push([name, criteria]); return []; } }])) };`
            : `import React from 'react'; export function Badge({children}) { return React.createElement('strong', null, children); }`,
        loader: 'js',
      }));
    },
  }],
});
function load(code) {
  const mod = new Module(`${process.cwd()}/survey-version-fixture.cjs`);
  mod.filename = `${process.cwd()}/survey-version-fixture.cjs`;
  mod.paths = Module._nodeModulePaths(process.cwd());
  mod._compile(code, mod.filename);
  return mod.exports;
}
const { Notice, state, calls } = load(fixtureBundle.outputFiles[0].text);
const assignment = Object.freeze({ id: 'assignment', form_id: 'survey', survey_version_id: 'v2', survey_version_number: 88 });
const versions = [
  { id: 'v2', form_id: 'survey', version_number: 2 },
  { id: 'v3', form_id: 'survey', version_number: 3 },
  { id: 'v9', form_id: 'survey', version_number: 9 },
];
function render({ current = 3, rows = versions, row = assignment, form = true, error = false, loading = false } = {}) {
  state.form = { data: form ? [{ id: 'survey', survey_settings: { current_version: current, status: 'published' } }] : [], isError: error };
  state.versions = { data: rows, isLoading: loading };
  state.queries = [];
  return renderToStaticMarkup(React.createElement(Notice, { assignment: row }));
}

test('uses loaded snapshot ID, not denormalized number or highest version; reflects actual serving resolver', async () => {
  const html = render();
  assert.match(html, /Assigned snapshot: Version 2/);
  assert.match(html, /Link serves current published Version 3/);
  assert.match(html, /older than current Version 3/);
  assert.match(html, /not a version pin/);
  assert.doesNotMatch(html, /Version (9|88)/);
  calls.length = 0;
  for (const query of state.queries) await query.queryFn();
  assert.deepEqual(calls, [['Form', { id: 'survey' }], ['SurveyVersion', { form_id: 'survey' }]]);
});

test('same version and republished older current do not produce older-than-current notices', () => {
  assert.doesNotMatch(render({ current: 2 }), /older than current/);
  assert.doesNotMatch(render({ current: 2, row: { ...assignment, survey_version_id: 'v3' } }), /older than current/);
});

test('missing reference, deleted snapshot, missing current, foreign snapshot and query error are explicit', () => {
  assert.match(render({ row: { ...assignment, survey_version_id: null } }), /Not recorded/);
  assert.match(render({ rows: [] }), /Assigned snapshot: Unavailable/);
  assert.match(render({ rows: [] }), /Current published version unavailable/);
  assert.match(render({ form: false }), /Current published version unavailable/);
  assert.match(render({ rows: [{ id: 'v2', form_id: 'other', version_number: 2 }] }), /Assigned snapshot: Unavailable/);
  assert.match(render({ error: true }), /could not be loaded. Retry/);
  assert.match(render({ loading: true }), /Loading version details/);
});

const builder = await readFile('client/src/pages/FormBuilder.jsx', 'utf8');
const between = (start, end) => {
  const offset = builder.indexOf(start);
  assert.ok(offset >= 0, start);
  const stop = builder.indexOf(end, offset);
  assert.ok(stop > offset, end);
  return builder.slice(offset, stop);
};
const eventControls = between('              {!isSurveyForm && (\n              <div', '              <div className="flex flex-col gap-2 min-w-[260px]');
const eventPicker = between('            {!isSurveyForm && formData.is_event_related && (', '            {/* Contract Settings Section');
const duplicateControls = between('                {isSurveyForm ? (\n                  <p', '              </CardContent>');
const compiled = await transform(`
  import React from 'react';
  const Switch = ({id, checked, onCheckedChange}) => <input id={id} type="checkbox" checked={checked} readOnly />;
  const Label = props => <label {...props} />;
  const LinkedEventCombobox = ({value}) => <select data-testid="linked-event" value={value} readOnly><option value={value}>{value}</option></select>;
  export function Controls({formData}) {
    const isSurveyForm = formData.form_type === 'survey';
    const eventOptions = [];
    const setFormData = () => { throw new Error('Rendering must not change stored settings'); };
    return <>${eventControls}${eventPicker}${duplicateControls}</>;
  }
`, { loader: 'jsx', format: 'cjs' });
const { Controls } = load(compiled.code);

test('actual builder JSX hides conflicting survey controls without changing stored values; standard mode restores them', () => {
  const settings = Object.freeze({
    form_type: 'survey', is_event_related: true, related_event_id: 'historic-event',
    prevent_duplicate_email_submission: true,
  });
  const html = renderToStaticMarkup(React.createElement(Controls, { formData: settings }));
  assert.doesNotMatch(html, /id="is_event_related"|data-testid="linked-event"|id="prevent_duplicate_email_submission"/);
  assert.match(html, /Events tab/);
  assert.match(html, /One submission per respondent/);
  const standard = renderToStaticMarkup(React.createElement(Controls, { formData: { ...settings, form_type: 'standard' } }));
  assert.match(standard, /id="is_event_related"[^>]*checked/);
  assert.match(standard, /historic-event/);
  assert.match(standard, /id="prevent_duplicate_email_submission"[^>]*checked/);
  assert.doesNotMatch(standard, /survey-event-authority|survey-submission-authority/);
  const unlinked = renderToStaticMarkup(React.createElement(Controls, { formData: { ...settings, form_type: 'standard', is_event_related: false } }));
  assert.doesNotMatch(unlinked, /data-testid="linked-event"/);
  assert.equal(settings.related_event_id, 'historic-event');
  assert.equal(settings.prevent_duplicate_email_submission, true);
});

test('both assignment surfaces render the shared version notice and all edited JSX parses', async () => {
  for (const file of ['SurveyEventAssignmentsPanel', 'EventSurveysSection']) {
    const source = await readFile(`client/src/components/surveys/${file}.jsx`, 'utf8');
    assert.match(source, /<AssignmentVersionNotice assignment=\{row\} \/>/);
    await transform(source, { loader: 'jsx' });
  }
  await transform(builder, { loader: 'jsx' });
});
