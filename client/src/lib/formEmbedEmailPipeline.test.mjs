import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const embedSource = await readFile(new URL('../pages/EmbedForm.jsx', import.meta.url), 'utf8');
const nativeSource = await readFile(new URL('../pages/FormView.jsx', import.meta.url), 'utf8');
const publicClientSource = await readFile(new URL('../api/publicClient.js', import.meta.url), 'utf8');
const entityRouteSource = await readFile(
  new URL('../../../api/entities/[entity]/index.js', import.meta.url),
  'utf8',
);

test('native and embedded forms persist through the same public server endpoint', () => {
  assert.match(nativeSource, /fetch\('\/api\/public\/form-submission'/);
  assert.match(embedSource, /publicClient\.submitForm\(\{/);
  assert.match(
    publicClientSource,
    /async submitForm\(data\)[\s\S]*?this\._fetch\('\/api\/public\/form-submission'/,
  );
});

test('embedded redirects happen only after the server submission promise succeeds', () => {
  const mutationStart = embedSource.indexOf('const submitFormMutation = useMutation({');
  const mutationEnd = embedSource.indexOf('// For card swipe layout', mutationStart);
  const mutation = embedSource.slice(mutationStart, mutationEnd);
  const mutationFn = mutation.indexOf('mutationFn:');
  const onSuccess = mutation.indexOf('onSuccess:');
  const redirect = mutation.indexOf('window.top.location.href');

  assert.ok(mutationFn > -1);
  assert.ok(onSuccess > mutationFn);
  assert.ok(redirect > onSuccess);
  assert.doesNotMatch(mutation.slice(mutationFn, onSuccess), /window\.top\.location\.href/);
});

test('cached native clients and generic entity clients converge on the shared guarded sender', () => {
  assert.match(nativeSource, /fetch\('\/api\/forms\/send-submission-email'/);
  assert.match(entityRouteSource, /sendSubmissionEmailsGuarded\(\{/);
  assert.match(entityRouteSource, /trigger:\s*'entity-api'/);
});