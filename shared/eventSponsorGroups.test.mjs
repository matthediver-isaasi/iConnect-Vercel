import test from 'node:test';
import assert from 'node:assert/strict';
import { groupEventSponsors, resolveEventSponsorCategoryIds } from './eventSponsorGroups.js';

test('CMS uses assignment authority, retains uncategorised sponsors, and preserves legacy saved order', () => {
  const sponsors = [{ id: 's', name: 'Sponsor', category_id: 'old' }, { id: 't', name: 'Second', category_id: 'old' }];
  const categories = [{ id: 'g', name: 'Gold', legacy_category_id: 'old', display_order: 2 },
    { id: 'b', name: 'Bronze', legacy_category_id: 'older', display_order: 1 }];
  assert.deepEqual(groupEventSponsors(sponsors, [{ sponsor_id: 's', category_id: 'g' }], categories).map(g => g.name), ['Gold']);
  assert.deepEqual(groupEventSponsors(sponsors, [{ sponsor_id: 's', category_id: 'b' }], categories).map(g => g.name), ['Bronze']);
  assert.deepEqual(groupEventSponsors(sponsors, [{ sponsor_id: 's', category_id: null }], categories).map(g => g.name), ['']);
  assert.deepEqual(groupEventSponsors(sponsors, [], categories), []);
  const groups = groupEventSponsors(sponsors, [{ sponsor_id: 's', category_id: 'g' }, { sponsor_id: 't', category_id: 'b' }], categories, ['old','older']);
  assert.deepEqual(groups.map(g => g.name), ['Gold','Bronze']);
  assert.deepEqual(resolveEventSponsorCategoryIds(['old'], categories), ['g']);
  assert.deepEqual(resolveEventSponsorCategoryIds(['older','__none__'], categories), ['b','__none__']);
  assert.equal(groupEventSponsors(sponsors, [{ sponsor_id: 's', category_id: 'missing' }], categories)[0].sponsors[0].id, 's');
});
