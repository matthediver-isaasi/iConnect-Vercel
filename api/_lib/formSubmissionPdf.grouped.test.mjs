import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildFormSubmissionPdf } from './formSubmissionPdf.js';

const group = (sub_questions) => ({
  id: 'questions',
  type: 'grouped_question',
  label: 'Supporting questions',
  sub_questions,
});

async function parsePdf(buffer) {
  assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
  const pdf = await getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    disableFontFace: true,
  }).promise;
  try {
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      pages.push({
        width: page.view[2] - page.view[0],
        height: page.view[3] - page.view[1],
        lines: content.items.filter(item => item.str.trim()).map(item => ({
          text: item.str,
          x: item.transform[4],
          y: item.transform[5],
          width: item.width,
        })),
      });
    }
    return pages;
  } finally {
    await pdf.destroy();
  }
}

const textOn = page => page.lines.map(line => line.text).join(' ');
const allText = pages => pages.map(textOn).join(' ');
const location = (pages, needle) => {
  for (let page = 0; page < pages.length; page++) {
    const line = pages[page].lines.find(item => item.text.includes(needle));
    if (line) return { page, ...line };
  }
  assert.fail(`Missing rendered text: ${needle}`);
};
const before = (a, b) => a.page < b.page || (a.page === b.page && a.y > b.y);

test('grouped answers use configured order, append unknown questions safely, and omit blank entries', async () => {
  const fields = [group([
    { id: 'second', label: 'Second configured question' },
    { id: 'first', label: 'First configured question' },
    { id: 'empty', label: 'Unanswered configured question' },
  ])];
  const pages = await parsePdf(buildFormSubmissionPdf({
    title: 'Synthetic application',
    fields,
    submissionData: {
      questions: {
        first: 'First response token',
        empty: '  ',
        unknown_key: 'Additional response token',
        second: 'Second response token',
        empty_array: [],
        null_answer: null,
      },
    },
  }));
  const rendered = allText(pages);
  for (const token of ['Supporting questions', 'Second configured question', 'Second response token',
    'First configured question', 'First response token', 'Unavailable question', 'Additional response token']) {
    assert.ok(rendered.includes(token), `PDF should display ${token}`);
  }
  for (const token of ['unknown_key', 'empty_array', 'null_answer', 'Unanswered configured question', 'No answers provided']) {
    assert.ok(!rendered.includes(token), `PDF must not display ${token}`);
  }
  const ordered = ['Second configured question', 'Second response token', 'First configured question',
    'First response token', 'Unavailable question', 'Additional response token'].map(token => location(pages, token));
  ordered.slice(1).forEach((item, index) => assert.ok(before(ordered[index], item), 'question and answer order'));
  // Each answer sits below its own label; paragraphs are separated by more than
  // the ordinary line height and the rendered text remains within the margins.
  for (const [label, answer] of [[0, 1], [2, 3], [4, 5]]) {
    assert.ok(ordered[label].y > ordered[answer].y, 'answer belongs below question label');
    assert.ok(ordered[label].x >= 35 && ordered[answer].x >= 35, 'left margin is respected');
  }
  assert.ok(ordered[1].y - ordered[2].y > ordered[0].y - ordered[1].y,
    'paragraph gap exceeds label-to-answer gap');
});

test('empty grouped answer shows one placeholder rather than blank question labels', async () => {
  for (const value of [{ first: '', second: null }, {}, null]) {
    const pages = await parsePdf(buildFormSubmissionPdf({
      title: 'Blank application',
      fields: [group([{ id: 'first', label: 'Question one' }, { id: 'second', label: 'Question two' }])],
      submissionData: { questions: value },
    }));
    assert.match(allText(pages), /No answers provided/);
    assert.doesNotMatch(allText(pages), /Question one|Question two|Unavailable question/);
  }
});

test('unconfigured answer IDs survive without exposing IDs even when no definitions remain', async () => {
  const pages = await parsePdf(buildFormSubmissionPdf({
    title: 'Archived form definition',
    fields: [group([])],
    submissionData: { questions: {
      removed_question_id: 'Retained historical response',
      also_removed: 'Another historical response',
      blank_removed: '  ',
    } },
  }));
  const rendered = allText(pages);
  assert.equal((rendered.match(/Unavailable question/g) || []).length, 2);
  assert.ok(before(location(pages, 'Retained historical response'), location(pages, 'Another historical response')));
  assert.doesNotMatch(rendered, /removed_question_id|also_removed|blank_removed|No answers provided/);
});

test('actual LF and CRLF create visible paragraph space, not escaped or JSON text', async () => {
  const pages = await parsePdf(buildFormSubmissionPdf({
    title: 'Paragraph layout',
    fields: [group([{ id: 'narrative', label: 'Narrative prompt' }])],
    submissionData: { questions: {
      narrative: 'First paragraph marker.\n\nSecond paragraph marker.\r\n\r\nThird paragraph marker.',
    } },
  }));
  const first = location(pages, 'First paragraph marker.');
  const second = location(pages, 'Second paragraph marker.');
  const third = location(pages, 'Third paragraph marker.');
  assert.equal(first.page, second.page);
  assert.equal(second.page, third.page);
  // The normal grouped line pitch is 5mm (14.17pt); blank lines must add
  // another line of space, not merely flatten paragraphs into one line.
  assert.ok(first.y - second.y > 22, 'LF blank line adds visible vertical space');
  assert.ok(second.y - third.y > 22, 'CRLF blank line adds visible vertical space');
  assert.doesNotMatch(allText(pages), /\\[nr]|"First paragraph|\\u000a/);
});

test('long labels and long multi-page answers fit on pages without losing the final answer', async () => {
  const longLabel = 'Describe the evidence and proposed approach '.repeat(8).trim();
  const answer = Array.from({ length: 240 }, (_, n) => `Segment${String(n).padStart(3, '0')} explains the proposed approach clearly.`).join(' ');
  const pages = await parsePdf(buildFormSubmissionPdf({
    title: 'Long-form application',
    fields: [group([{ id: 'detail', label: longLabel }])],
    submissionData: { questions: { detail: answer } },
  }));
  assert.ok(pages.length > 1, 'long answer needs multiple PDF pages');
  const tokens = [...allText(pages).matchAll(/Segment\d{3}/g)].map(match => match[0]);
  assert.deepEqual(tokens, Array.from({ length: 240 }, (_, n) => `Segment${String(n).padStart(3, '0')}`),
    'every segment appears once, in order, across page boundaries');
  assert.ok(pages[0].lines.filter(line => line.text.includes('Describe the evidence')).length > 1,
    'long question label wraps');
  for (const page of pages) {
    for (const line of page.lines) {
      const marginPoints = 20 * 72 / 25.4;
      assert.ok(line.y >= marginPoints - 2 && line.y <= page.height - marginPoints + 2,
        `text must stay inside vertical 20mm margins: ${line.text}`);
      assert.ok(line.x >= marginPoints - 2, `text must stay inside left 20mm margin: ${line.text}`);
      assert.ok(line.x + line.width <= page.width - marginPoints + 2,
        `text must stay inside right 20mm margin: ${line.text}`);
    }
  }
});

test('label longer than a full page retains every word and keeps its final line with the answer', async () => {
  const labelTokens = Array.from({ length: 780 }, (_, n) => `LabelWord${String(n).padStart(3, '0')}`);
  const pages = await parsePdf(buildFormSubmissionPdf({
    title: 'Long label pagination',
    fields: [group([{ id: 'long', label: labelTokens.join(' ') }])],
    submissionData: { questions: { long: 'First answer after enormous label' } },
  }));
  assert.ok(pages.length >= 2, 'label alone needs more than a page');
  assert.deepEqual(
    [...allText(pages).matchAll(/LabelWord\d{3}/g)].map(match => match[0]),
    labelTokens,
    'no label words disappear or move out of order',
  );
  const lastLabel = location(pages, labelTokens.at(-1));
  const firstAnswer = location(pages, 'First answer after enormous label');
  assert.equal(lastLabel.page, firstAnswer.page, 'last label line accompanies first answer line');
  assert.ok(lastLabel.y > firstAnswer.y);
});

test('final question label is never orphaned from its first answer line', async () => {
  // Vary the preceding answer length to exercise the exact page boundary
  // without relying on a single font-metric or jsPDF version.
  let boundaryCase = null;
  for (let count = 130; count <= 230; count += 2) {
    const pages = await parsePdf(buildFormSubmissionPdf({
      title: 'Pagination check',
      fields: [group([
        { id: 'intro', label: 'Intro question' },
        { id: 'final', label: 'Final question marker' },
      ])],
      submissionData: { questions: {
        intro: 'Preceding answer text '.repeat(count),
        final: 'Final answer marker with enough text to wrap onto another line.',
      } },
    }));
    const label = location(pages, 'Final question marker');
    if (label.page > 0 || label.y < 110) {
      boundaryCase = { pages, label };
      if (label.y < 110) break;
    }
  }
  assert.ok(boundaryCase, 'fixture exercises a page boundary');
  const { pages, label } = boundaryCase;
  const answer = location(pages, 'Final answer marker');
  assert.equal(answer.page, label.page, 'final question label must accompany its first answer line');
  assert.ok(label.y > answer.y);
});

// Bundle the *real handler* while replacing only external I/O boundaries.
// This follows the repository's esbuild handler-fixture pattern, keeping the
// production PDF builder untouched and executed for both request variants.
const slot = '__groupedApplicationPdfFixture';
async function loadHandler() {
  const stubs = new Map([
    ['@supabase/supabase-js', `export const createClient = () => globalThis.${slot}.db;`],
    ['../_lib/memberGroupAdminAccess.js', `
      export const getCallerGroupManageAccess = async () => ({ tenantContext: { tenantId: 'tenant-test' } });
      export const canManageGroup = (_access, groupId) => groupId === 'group-test';`],
    ['../_lib/formSubmissionPdf.js', `
      export const buildFormSubmissionPdf = (...args) => globalThis.${slot}.buildPdf(...args);
      export const loadFormSubmissionRelationshipLabels = async () => ({});
      export const loadFormSubmissionOrganisationLabels = async () => ({});
      export const loadFormSubmissionOrganisationGroupLabels = async () => ({});`],
    ['../_lib/tenantStorageUsage.js', 'export const addTenantStorageBytes = async () => {};'],
  ]);
  const output = await build({
    entryPoints: [new URL('../member-groups/vacancy-application-pdf.js', import.meta.url).pathname],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    plugins: [{
      name: 'grouped-pdf-boundaries',
      setup(plugin) {
        plugin.onResolve({ filter: /.*/ }, args =>
          stubs.has(args.path) ? { path: args.path, namespace: 'fixture' } : undefined);
        plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, args =>
          ({ contents: stubs.get(args.path), loader: 'js' }));
      },
    }],
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)).default;
}

test('actual vacancy PDF handler uploads parsed PDFs for form submission and legacy application', async () => {
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SERVICE_KEY;
  process.env.SUPABASE_URL = 'https://example.invalid';
  process.env.SUPABASE_SERVICE_KEY = 'test-only-key';
  const uploads = [];
  const rows = {
    form_submission: {
      id: 'submission-test', tenant_id: 'tenant-test', vacancy_id: 'vacancy-test',
      created_date: '2026-01-05T12:00:00Z', submitted_by_name: 'Synthetic Applicant',
      submission_data: { questions: {
        q2: 'Final short answer for review',
        q1: `Opening synthetic paragraph.\n\n${Array.from({ length: 260 }, (_, n) =>
          `ReviewSegment${String(n).padStart(3, '0')} describes synthetic evidence.`).join(' ')}\r\n\r\nClosing synthetic paragraph.`,
      } },
      form: { name: 'Application', fields: [group([
        { id: 'q1', label: 'Detailed narrative prompt' }, { id: 'q2', label: 'Final short question' },
      ])] },
    },
    vacancy_application: {
      id: 'legacy-test', tenant_id: 'tenant-test', vacancy_id: 'vacancy-test',
      member_id: null, message: 'Synthetic legacy message', status: 'pending',
      created_at: '2026-01-05T12:00:00Z',
    },
    vacancy: { id: 'vacancy-test', tenant_id: 'tenant-test', member_group_id: 'group-test', role_title: 'Synthetic Role' },
  };
  globalThis[slot] = {
    buildPdf: buildFormSubmissionPdf,
    db: {
      from(table) {
        return {
          select() { return this; },
          eq() { return this; },
          async maybeSingle() { return { data: rows[table], error: null }; },
        };
      },
      storage: {
        from(bucket) {
          assert.equal(bucket, 'private-uploads');
          return {
            async list() { return { data: [] }; },
            async upload(path, buffer, options) {
              uploads.push({ path, buffer, options });
              return { error: null };
            },
            async createSignedUrl(path, ttl) {
              assert.equal(ttl, 300);
              return { data: { signedUrl: `https://example.invalid/download/${path}` }, error: null };
            },
          };
        },
      },
    },
  };
  try {
    const handler = await loadHandler();
    for (const [sourceType, id] of [['submission', 'submission-test'], ['application', 'legacy-test']]) {
      const response = {
        status(code) { this.code = code; return this; },
        json(body) { this.body = body; return this; },
      };
      await handler({ method: 'GET', query: { source_type: sourceType, source_id: id } }, response);
      assert.equal(response.code, 200, JSON.stringify(response.body));
      assert.equal(response.body.success, true);
      const upload = uploads.at(-1);
      assert.equal(upload.path, `tenant-test/vacancy-applications/${sourceType}_${id}.pdf`);
      assert.deepEqual(upload.options, { contentType: 'application/pdf', upsert: true });
      const pages = await parsePdf(upload.buffer);
      const text = allText(pages);
      assert.match(text, /Synthetic Role/);
      if (sourceType === 'submission') {
        assert.ok(pages.length > 1, 'saved synthetic handler PDF spans multiple pages');
        assert.ok(before(location(pages, 'Detailed narrative prompt'), location(pages, 'Final short question')));
        assert.match(text, /Opening synthetic paragraph/);
        assert.match(text, /Closing synthetic paragraph/);
        assert.match(text, /Final short answer for review/);
        assert.equal(location(pages, 'Final short question').page, location(pages, 'Final short answer for review').page);
        await writeFile('/tmp/grouped-application-verification.pdf', upload.buffer);
      } else {
        assert.match(text, /Synthetic legacy message/);
        assert.match(text, /Unknown member/);
      }
    }
  } finally {
    delete globalThis[slot];
    if (previousUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_KEY;
    else process.env.SUPABASE_SERVICE_KEY = previousKey;
  }
});