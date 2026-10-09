import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { publishCreatedProjectCard, publishProjectCardUpdate } from './projectBoardCache.js';
test('uploads and covers publish to both caches without dropping card relationships', async () => {
  const client = new QueryClient();
  const key = ['project-board', 'board'];
  const card = { id: 'card', board_id: 'board', cover_image: null, project_card_label: [{ label_id: 'label' }] };
  client.setQueryData(key, { cards: [card, { id: 'other' }], labels: ['label'] });
  client.setQueryData(['card-detail', 'card'], { card, attachments: [], comments: ['comment'] });
  const attachment = { id: 'image', url: '/image.png', file_type: 'image/png' };
  await publishProjectCardUpdate(client, 'card', {}, { attachment });
  await publishProjectCardUpdate(client, 'card', { cover_image: attachment.url });
  assert.equal(client.getQueryData(key).cards[0].cover_image, '/image.png');
  assert.deepEqual(client.getQueryData(key).cards[0].project_card_label, [{ label_id: 'label' }]);
  assert.deepEqual(client.getQueryData(['card-detail', 'card']).attachments, [attachment]);
  assert.deepEqual(client.getQueryData(['card-detail', 'card']).comments, ['comment']);
  await publishProjectCardUpdate(client, 'card', { cover_image: null }, { removedAttachmentId: 'image' });
  assert.deepEqual(client.getQueryData(['card-detail', 'card']).attachments, []);
  assert.equal(client.getQueryData(key).cards[0].cover_image, null);
  assert.deepEqual(client.getQueryData(key).cards[1], { id: 'other' });
  client.clear();
});

test('confirmed card is visible while the background board request is still pending', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = ['project-board', 'board'];
  client.setQueryData(key, { board: { id: 'board' }, cards: [{ id: 'old' }] });
  let complete;
  const observer = new QueryObserver(client, {
    queryKey: key, staleTime: Infinity,
    queryFn: () => new Promise(resolve => { complete = resolve; }),
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    await publishCreatedProjectCard(client, 'board', { id: 'new', board_id: 'board', list_id: 'list', title: 'Saved' });
    assert.equal(client.getQueryState(key).fetchStatus, 'fetching');
    assert.deepEqual(client.getQueryData(key).cards.map(card => card.id), ['old', 'new']);
    assert.deepEqual(client.getQueryData(key).cards[1].project_card_attachment, []);
    complete(client.getQueryData(key));
  } finally { unsubscribe(); client.clear(); }
});

test('a pre-save board read cannot overwrite the newly confirmed card', async () => {
  const client = new QueryClient();
  const key = ['project-board', 'board'];
  client.setQueryData(key, { cards: [] });
  let finishOld;
  const oldRead = client.fetchQuery({ queryKey: key,
    queryFn: () => new Promise(resolve => { finishOld = resolve; }) }).catch(() => {});
  await publishCreatedProjectCard(client, 'board', { id: 'new', board_id: 'board' });
  finishOld({ cards: [] });
  await oldRead;
  assert.equal(client.getQueryData(key).cards[0].id, 'new');
  client.clear();
});

test('does not duplicate realtime cards, affect another board or create an incomplete board cache', async () => {
  const client = new QueryClient();
  const key = ['project-board', 'board'];
  const existing = { id: 'new', board_id: 'board', title: 'Updated by colleague', project_card_attachment: [{ id: 'file' }] };
  client.setQueryData(key, { cards: [existing], members: ['member'] });
  client.setQueryData(['project-board', 'other'], { cards: [] });
  await publishCreatedProjectCard(client, 'board', { id: 'new', board_id: 'board', title: 'Original' });
  assert.deepEqual(client.getQueryData(key), { cards: [existing], members: ['member'] });
  await publishCreatedProjectCard(client, 'other', existing);
  assert.deepEqual(client.getQueryData(['project-board', 'other']).cards, []);
  await publishCreatedProjectCard(client, 'missing', { id: 'card', board_id: 'missing' });
  assert.equal(client.getQueryData(['project-board', 'missing']), undefined);
  await publishCreatedProjectCard(client, 'board', null);
  assert.deepEqual(client.getQueryData(key).cards, [existing]);
  client.clear();
});
