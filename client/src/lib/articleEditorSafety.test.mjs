import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadArticleForEditing, articleUpdateWithImageIntent } from './articleEditorSafety.js';

test('loads the exact record and saved image rather than searching a list', async () => {
  const article = { id: 'draft-a', feature_image_url: 'https://example.test/saved.jpg' };
  const loaded = await loadArticleForEditing({
    async get(id) { assert.equal(id, article.id); return article; },
    list() { throw new Error('Must not list articles'); },
  }, article.id);
  assert.equal(loaded.feature_image_url, article.feature_image_url);
});
test('missing, partial and wrong records fail closed; genuinely empty images remain editable', async () => {
  for (const record of [null, { id: 'other', feature_image_url: '' }, { id: 'draft-a' }]) {
    await assert.rejects(loadArticleForEditing({ get: async () => record }, 'draft-a'));
  }
  const empty = { id: 'draft-a', feature_image_url: null };
  assert.equal(await loadArticleForEditing({ get: async () => empty }, 'draft-a'), empty);
});
test('text updates cannot clear images but explicit removal/upload/focal edits work', () => {
  const empty = { title: 'Edited text', feature_image_url: '', feature_image_focal_point: { x: 50, y: 50 } };
  assert.deepEqual(articleUpdateWithImageIntent(empty, false), { title: 'Edited text' });
  assert.deepEqual(articleUpdateWithImageIntent(empty, true), empty);
  const uploaded = { ...empty, feature_image_url: 'https://example.test/new.jpg' };
  assert.deepEqual(articleUpdateWithImageIntent(uploaded, true), uploaded);
});
test('both save paths enforce image intent and preview retains only the banner edit control', () => {
  const editor = readFileSync(new URL('../pages/ArticleEditor.jsx', import.meta.url), 'utf8');
  assert.match(editor, /articleUpdateWithImageIntent\(autoSaveData, imageChangedRef.current\)/);
  assert.match(editor, /articleUpdateWithImageIntent\(articleData, imageChangedRef.current\)/);
  assert.match(editor, /hydratedArticleId !== articleId \|\| articleFetching \|\| articleError \|\| uploadingImage/);
  assert.match(editor, /lastAutoSaveSnapshot.current === snapshot/);
  const view = readFileSync(new URL('../pages/ArticleView.jsx', import.meta.url), 'utf8');
  assert.match(view, /isAuthor && !\(isDraft && canViewDraft\)/);
});
