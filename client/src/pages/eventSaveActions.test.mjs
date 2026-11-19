import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { transformSync } from 'esbuild';

const source = name => fs.readFileSync(new URL(`./${name}.jsx`, import.meta.url), 'utf8');
const create = source('CreateEvent');
const edit = source('EditEvent');
const complex = source('CreateComplexEvent');
const createPageUrl = name => `/${name}`;
const between = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));

test('all event editors compile and expose both save actions', () => {
  for (const text of [create, edit, complex]) {
    assert.doesNotThrow(() => transformSync(text, { loader: 'jsx' }));
    assert.match(text, /data-testid="button-save-close"/);
    assert.match(text, /Save &amp; Close/);
  }
  for (const text of [create, edit]) {
    // The first submit button is Save, so implicit Enter submission stays open.
    assert.match(text, /type="submit"\s+value="save"/);
    assert.ok(text.indexOf('value="save"') < text.indexOf('value="close"'));
    assert.match(text, /e\.nativeEvent\?\.submitter\?\.value === 'close'/);
  }
});

test('creation opens the saved record by default, preserving training and group context', () => {
  const body = between(create, '  const savedEventEditorUrl =', '  // Back-arrow');
  for (const search of ['', '?training=1', '?group_event=1&group_id=g1&from=GroupEvents']) {
    const url = new Function('window', 'createPageUrl', `${body}; return savedEventEditorUrl('saved-id');`)(
      { location: { search } }, createPageUrl);
    const params = new URLSearchParams(url.split('?')[1]);
    assert.equal(params.get('id'), 'saved-id');
    for (const [key, value] of new URLSearchParams(search)) assert.equal(params.get(key), value);
  }
});

test('simple and training creation respects Save versus Save & Close and failure recovery', () => {
  const callback = between(create, '    onSuccess: ({ createdEvent', '    onError:');
  for (const close of [false, true]) {
    for (const failure of [null, 'CPD failed']) {
      const window = { location: { href: '' } };
      const run = new Function('window', 'queryClient', 'toast', 'setTimeout', 'saveAndCloseRef',
        'backUrl', 'savedEventEditorUrl', `return ({${callback}}).onSuccess;`)(
        window, { invalidateQueries() {} }, { error() {}, success() {} }, fn => fn(),
        { current: close }, '/GroupEvents', id => `/EditEvent?id=${id}`);
      run({ createdEvent: { id: 'saved' }, cpdError: failure });
      assert.equal(window.location.href, close && !failure ? '/GroupEvents' : '/EditEvent?id=saved');
    }
  }
});

test('simple/training edits stay open on Save and close only after successful Save & Close', () => {
  const navigation = between(edit, '        const returnGroupId =', '\n      }\n      });');
  for (const closeAfterSave of [false, true]) {
    for (const cpdSaveError of [null, 'failed']) {
      for (const groupId of [null, 'g1']) {
        const window = { location: { href: '/EditEvent?id=saved' } };
        new Function('window', 'groupIdParam', 'event', 'fromParam', 'createPageUrl',
          'closeAfterSave', 'cpdSaveError', 'setTimeout', navigation)(
          window, groupId, {}, 'GroupEvents', createPageUrl, closeAfterSave, cpdSaveError, fn => fn());
        assert.equal(window.location.href, closeAfterSave && !cpdSaveError
          ? groupId ? '/GroupEvents' : '/Events' : '/EditEvent?id=saved');
      }
    }
  }
});

test('complex edit navigation respects both actions, group origin and retryable errors', () => {
  const navigation = between(complex, '        if (cpdSaveError) {\n          // The remapped', '\n      } else {\n        // Task #3263');
  for (const close of [false, true]) {
    for (const groupReturnUrl of [null, '/MemberGroupDetail?id=g1']) {
      for (const cpdSaveError of [null, 'failed']) {
        const window = { location: { href: '/CreateComplexEvent?id=saved' } };
        const baseline = { current: 'old' };
        new Function('window', 'cpdSaveError', 'closeAfterSave', 'groupReturnUrl', 'createPageUrl',
          'setTimeout', 'setIsDirtyState', 'baselineSnapshotRef', 'buildSnapshot', 'pendingBaselineResetRef', navigation)(
          window, cpdSaveError, close, groupReturnUrl, createPageUrl, fn => fn(), () => {},
          baseline, () => 'saved', { current: false });
        assert.equal(window.location.href, close && !cpdSaveError
          ? groupReturnUrl || '/Events' : '/CreateComplexEvent?id=saved');
        if (!close && !cpdSaveError) assert.equal(baseline.current, 'saved');
      }
    }
  }
});

test('complex confirmation dialogs retain the originally selected action', () => {
  assert.match(complex, /closeAfterSave = saveAndCloseRef\.current/);
  assert.match(complex, /saveAndCloseRef\.current = closeAfterSave/);
  assert.match(complex, /handleSave\(false, null, true\)/);
  assert.match(complex, /handleSave\(false, null, false\)/);
  assert.match(complex, /handleSave\(true, false\)/);
  assert.match(complex, /handleSave\(true, true\)/);
  assert.match(complex, /window\.location\.href = closeAfterSave\s*\? groupReturnUrl/);
  assert.match(edit, /setPendingSubmit\(\(\) => submitUpdate\)/);
  assert.match(edit, /setBadgeRemovalSave\(\{ removedSpeakerIds, runUpdate \}\)/);
});

test('new complex events open their saved ID unless Save & Close was selected', () => {
  const navigation = between(complex, '          const params = new URLSearchParams(window.location.search);\n          params.set("id", eventId);\n          window.location.href = closeAfterSave', '\n        }\n      }\n    } catch');
  for (const close of [false, true]) {
    for (const group of [null, '/GroupEvents']) {
      const window = { location: { search: '?group_event=1&group_id=g1', href: '' } };
      new Function('window', 'eventId', 'closeAfterSave', 'groupReturnUrl', 'createPageUrl', navigation)(
        window, 'saved-id', close, group, createPageUrl);
      if (close) {
        assert.equal(window.location.href, group || '/Events');
      } else {
        const [path, search] = window.location.href.split('?');
        assert.equal(path, '/CreateComplexEvent');
        assert.equal(new URLSearchParams(search).get('id'), 'saved-id');
        assert.equal(new URLSearchParams(search).get('group_id'), 'g1');
      }
    }
  }
});
