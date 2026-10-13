import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform, hash, reportingFunctions, compareReports } from './repair-bnms-survey-reporting-names.mjs';

const fields = () => [
  { id: 'text', type: 'text', label: 'Comment', reporting_name: 'Do not change', options: [1, 2] },
  ...Array.from({length: 19}, (_,i) => ({
    id: `q${i}`, type: 'score', label: i === 18 ? ' Presenters only — feedback? ' : `Question ${i}`,
    ...(i === 18 ? {} : { reporting_name: 'Exhibition standard' }),
    weight: i + 1, score_min: 1, score_max: 5, options: { arbitrary: [2,1] },
  })),
];

test('changes only score reporting_name, verbatim, with stable order and no input mutation', () => {
  const before = fields(), saved = structuredClone(before);
  const after = transform(before);
  assert.deepEqual(before, saved);
  assert.deepEqual(after.map(f => f.id), before.map(f => f.id));
  assert.deepEqual(after[0], before[0]);
  for (let i = 1; i < after.length; i++) {
    const {reporting_name: old, ...rest} = before[i];
    assert.deepEqual(after[i], {...rest, reporting_name: before[i].label});
  }
  assert.deepEqual(transform(after), after);
});

test('fails closed on shape, duplicate/missing identities, score count and blank labels', () => {
  for (const invalid of [null, {}, [null], fields().slice(1, 5),
    fields().map((f,i) => i === 2 ? {...f, id:'q0'} : f),
    fields().map((f,i) => i === 2 ? {...f, id:null} : f),
    fields().map((f,i) => i === 2 ? {...f, label:'  '} : f),
    fields().map((f,i) => i === 2 ? {...f, label:42} : f)]) {
    assert.throws(() => transform(invalid));
  }
});

test('historical snapshots retain their own labels and unrelated metadata', () => {
  const current = fields(), historical = fields();
  historical[1].label = 'Historical wording';
  assert.equal(transform(historical)[1].reporting_name, 'Historical wording');
  assert.equal(transform(current)[1].reporting_name, 'Question 0');
  assert.equal(hash({b:2,a:1}), hash({a:1,b:2}));
  assert.notEqual(hash([1,2]), hash([2,1]));
});

test('real report functions preserve numeric results by field ID and correct export/distribution labels', () => {
  const f = reportingFunctions();
  const beforeFields = fields(), afterFields = transform(beforeFields);
  const submissions = [{id:'s1',survey_version_id:'v1'}, {id:'s2',survey_version_id:'v1'}];
  const answers = beforeFields.slice(1).flatMap((q,i) => [
    {submission_id:'s1',field_id:q.id, raw_score: i % 5 + 1, normalised_score:(i%5)/4,weight:q.weight},
    {submission_id:'s2',field_id:q.id, raw_score:null,is_na:true},
  ]);
  const report = fields => {
    const ctx = {form:{name:'Fixture'},versions:[{id:'v1',version_number:1,fields}]};
    const meta = f.buildQuestionMeta(ctx.versions);
    const agg = f.aggregate(ctx,submissions,answers,meta);
    return {
      meta:[...meta.values()].sort((a,b)=>a.fieldId.localeCompare(b.fieldId)),
      summary:agg.summary,categories:agg.categories,
      questions:[...agg.questions].sort((a,b)=>a.fieldId.localeCompare(b.fieldId)),
      distributions:[...meta.keys()].sort().map(id=>f.distributionView(answers,agg.perSubmission,meta,id)),
      sheets:f.buildSummarySheetRows(ctx,agg,[],agg.perSubmission,{isAnonymous:false},false,[1]),
    };
  };
  const before = report(beforeFields), after = report(afterFields);
  compareReports([before],[after]);
  assert.equal(after.sheets.questionsSheet.length,20);
  after.questions[0].validCount++;
  assert.throws(()=>compareReports([before],[after]),/changed beyond labels/);
});

test('pinned manifest contains only recovery metadata, two original snapshots and 57 fields', () => {
  const manifest = JSON.parse(readFileSync(new URL('./data/bnms-survey-reporting-names.json',import.meta.url)));
  assert.deepEqual(manifest.entries.map(e=>e.version),[null,1,2]);
  assert.equal(manifest.entries.flatMap(e=>e.fields).length,57);
  for (const entry of manifest.entries) {
    assert.equal(entry.fields.filter(f=>f.before!==f.after).length,19);
    assert.ok(entry.fields.every(f=>f.after===f.label));
    assert.equal(entry.fields.filter(f=>!f.beforePresent).length,1);
  }
});

test('UI consumes the same server labels for results, charts and distribution heading', () => {
  const source=readFileSync(new URL('../client/src/pages/SurveyReports.jsx',import.meta.url),'utf8');
  assert.match(source,/\{q\.label\}/);
  assert.match(source,/name: q\.label/);
  assert.match(source,/DialogDescription>\{distribution\?\.label/);
});
