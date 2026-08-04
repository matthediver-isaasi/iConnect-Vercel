import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CUSTOM_FIELDS_SLOT,
  MEMBER_BACK_DEFAULT_ORDER,
  ORG_BACK_DEFAULT_ORDER,
  resolveBackFieldOrder,
  reorderBackFieldOrder,
  groupBackOrderItems,
  CORE_FIELDS,
  applyCoreFieldVisibility,
  isOrgCoreItemVisible,
  isVisibleOnFront,
  isVisibleOnBack,
} from './directorySettings.js';

import {
  CUSTOM_FIELDS_SLOT as SRV_SLOT,
  MEMBER_BACK_DEFAULT_ORDER as SRV_MEMBER_DEFAULT,
  ORG_BACK_DEFAULT_ORDER as SRV_ORG_DEFAULT,
  resolveBackFieldOrder as srvResolve,
  CORE_FIELD_KEYS as SRV_CORE_KEYS,
  applyCoreFieldVisibility as srvApplyCoreVis,
  isOrgCoreItemVisible as srvIsOrgCoreItemVisible,
} from '../../../api/_lib/directoryConfig.js';

const customFields = [{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }];

test('client and server constants stay in sync', () => {
  assert.equal(CUSTOM_FIELDS_SLOT, SRV_SLOT);
  assert.deepEqual(MEMBER_BACK_DEFAULT_ORDER, SRV_MEMBER_DEFAULT);
  assert.deepEqual(ORG_BACK_DEFAULT_ORDER, SRV_ORG_DEFAULT);
});

test('no saved order → default order with customs expanded at slot', () => {
  for (const resolve of [resolveBackFieldOrder, srvResolve]) {
    const out = resolve({
      directoryOrder: null,
      tenantOrder: null,
      defaultOrder: MEMBER_BACK_DEFAULT_ORDER,
      customFields,
    });
    const slotIdx = MEMBER_BACK_DEFAULT_ORDER.indexOf(CUSTOM_FIELDS_SLOT);
    assert.deepEqual(out.slice(slotIdx, slotIdx + 3), ['custom:f1', 'custom:f2', 'custom:f3']);
    assert.equal(out.length, MEMBER_BACK_DEFAULT_ORDER.length - 1 + 3);
    assert.ok(!out.includes(CUSTOM_FIELDS_SLOT));
  }
});

test('tenant order respected, unknown keys dropped, missing keys appended', () => {
  const tenantOrder = ['custom:f2', 'show_awards', 'bogus_key', 'show_organization', 'custom:gone'];
  for (const resolve of [resolveBackFieldOrder, srvResolve]) {
    const out = resolve({
      directoryOrder: null,
      tenantOrder,
      defaultOrder: MEMBER_BACK_DEFAULT_ORDER,
      customFields,
    });
    assert.deepEqual(out.slice(0, 3), ['custom:f2', 'show_awards', 'show_organization']);
    assert.ok(!out.includes('bogus_key'));
    assert.ok(!out.includes('custom:gone'));
    // Missing cores follow default order; missing customs at slot position.
    assert.deepEqual(out.slice(3), [
      'show_profile_photo', 'show_job_title', 'show_bio_in_popup',
      'show_events', 'show_articles', 'custom:f1', 'custom:f3', 'show_linkedin',
    ]);
  }
});

test('directory override wins over tenant order', () => {
  for (const resolve of [resolveBackFieldOrder, srvResolve]) {
    const out = resolve({
      directoryOrder: ['org_members_list', 'custom:f1', 'org_member_count'],
      tenantOrder: ['org_member_count', 'org_members_list'],
      defaultOrder: ORG_BACK_DEFAULT_ORDER,
      customFields,
    });
    assert.deepEqual(out, ['org_members_list', 'custom:f1', 'org_member_count', 'custom:f2', 'custom:f3']);
  }
});

test('empty/garbage saved lists treated as unset', () => {
  for (const resolve of [resolveBackFieldOrder, srvResolve]) {
    const out = resolve({
      directoryOrder: [],
      tenantOrder: ['nothing', 'known', 42],
      defaultOrder: ORG_BACK_DEFAULT_ORDER,
      customFields: [],
    });
    assert.deepEqual(out, ['org_member_count', 'org_members_list']);
  }
});

// Mirrors the detail-modal render pipeline: resolve order → map to item
// kinds → group into sections. Proves a saved tenant default and a
// per-directory override each change the visible section sequence.
const KIND_BY_CORE = {
  show_organization: 'block', show_bio_in_popup: 'block',
  show_events: 'stat', show_articles: 'stat',
  show_awards: 'block', show_linkedin: 'block',
};
function visibleSectionPlan({ directoryOrder, tenantOrder }) {
  const resolved = resolveBackFieldOrder({
    directoryOrder, tenantOrder,
    defaultOrder: MEMBER_BACK_DEFAULT_ORDER,
    customFields,
  });
  const items = [];
  for (const key of resolved) {
    if (key.startsWith('custom:')) items.push({ kind: 'custom', key });
    else if (KIND_BY_CORE[key]) items.push({ kind: KIND_BY_CORE[key], key });
    // photo/job title stay in the fixed header — skipped, like the renderers.
  }
  return groupBackOrderItems(items).map(s => `${s.type}:${s.items.map(i => i.key).join('+')}`);
}

test('detail sequence: no saved order matches the historical layout', () => {
  assert.deepEqual(visibleSectionPlan({ directoryOrder: null, tenantOrder: null }), [
    'block:show_organization',
    'block:show_bio_in_popup',
    'stat:show_events+show_articles',
    'custom:custom:f1+custom:f2+custom:f3',
    'block:show_awards',
    'block:show_linkedin',
  ]);
});

test('detail sequence: a saved tenant default changes the rendered order', () => {
  const plan = visibleSectionPlan({
    directoryOrder: null,
    tenantOrder: ['custom:f2', 'show_awards', 'show_events', 'custom:f1', 'show_articles'],
  });
  assert.deepEqual(plan.slice(0, 5), [
    'custom:custom:f2',
    'block:show_awards',
    'stat:show_events',
    'custom:custom:f1',
    'stat:show_articles',
  ]);
});

test('detail sequence: a per-directory override beats the tenant default', () => {
  const tenantOrder = ['show_organization', 'custom:f1', 'show_awards'];
  const withOverride = visibleSectionPlan({
    directoryOrder: ['show_linkedin', 'custom:f3', 'show_organization'],
    tenantOrder,
  });
  const withoutOverride = visibleSectionPlan({ directoryOrder: null, tenantOrder });
  assert.deepEqual(withOverride.slice(0, 3), ['block:show_linkedin', 'custom:custom:f3', 'block:show_organization']);
  assert.notDeepEqual(withOverride, withoutOverride);
});

test('groupBackOrderItems batches consecutive stats/customs and keeps blocks standalone', () => {
  const sections = groupBackOrderItems([
    { kind: 'block', key: 'a' },
    { kind: 'stat', key: 'b' }, { kind: 'stat', key: 'c' },
    { kind: 'custom', key: 'd' },
    { kind: 'block', key: 'e' },
    { kind: 'custom', key: 'f' }, { kind: 'custom', key: 'g' },
  ]);
  assert.deepEqual(sections.map(s => [s.type, s.items.length]), [
    ['block', 1], ['stat', 2], ['custom', 1], ['block', 1], ['custom', 2],
  ]);
  assert.deepEqual(groupBackOrderItems([]), []);
});

// ---- per-directory core-field visibility overrides -------------------------

test('core visibility: client and server key lists stay in sync', () => {
  assert.deepEqual(CORE_FIELDS.map(f => f.key), SRV_CORE_KEYS);
});

test('applyCoreFieldVisibility: no overrides = untouched settings (both copies)', () => {
  const settings = { show_job_title: { front: true, back: false }, show_awards: false };
  for (const apply of [applyCoreFieldVisibility, srvApplyCoreVis]) {
    assert.equal(apply(settings, null), settings);
    assert.equal(apply(settings, undefined), settings);
    assert.equal(apply(settings, 'not json {'), settings);
    assert.equal(apply(settings, []), settings);
  }
});

test('applyCoreFieldVisibility: override wins per side, missing side inherits', () => {
  const settings = {
    show_job_title: { front: true, back: true },
    show_linkedin: false, // legacy boolean form
  };
  const overrides = {
    show_job_title: { front: false }, // back inherits (true)
    show_linkedin: { back: true },    // front inherits (false)
    show_events: { front: false, back: false }, // absent in settings → default true baseline
    bogus_key: { front: false },      // unknown keys ignored
    show_awards: 'nope',              // malformed override ignored
  };
  for (const apply of [applyCoreFieldVisibility, srvApplyCoreVis]) {
    const merged = apply(settings, overrides);
    assert.notEqual(merged, settings);
    assert.deepEqual(merged.show_job_title, { front: false, back: true });
    assert.deepEqual(merged.show_linkedin, { front: false, back: true });
    assert.deepEqual(merged.show_events, { front: false, back: false });
    assert.equal(merged.show_awards, undefined);
    assert.ok(!('bogus_key' in merged));
    // Original settings object untouched.
    assert.deepEqual(settings.show_job_title, { front: true, back: true });
  }
});

test('applyCoreFieldVisibility: accepts JSON string values (both copies)', () => {
  const overrides = JSON.stringify({ show_profile_photo: { front: false, back: false } });
  for (const apply of [applyCoreFieldVisibility, srvApplyCoreVis]) {
    const merged = apply({}, overrides);
    assert.deepEqual(merged.show_profile_photo, { front: false, back: false });
  }
});

test('client isVisibleOnFront/Back read merged overrides like globals', () => {
  const merged = applyCoreFieldVisibility(
    { show_job_title: { front: true, back: true } },
    { show_job_title: { front: false } }
  );
  assert.equal(isVisibleOnFront(merged, 'show_job_title'), false);
  assert.equal(isVisibleOnBack(merged, 'show_job_title'), true);
});

test('isOrgCoreItemVisible: override → fallback, both copies agree', () => {
  for (const fn of [isOrgCoreItemVisible, srvIsOrgCoreItemVisible]) {
    assert.equal(fn(null, 'org_member_count', true), true);
    assert.equal(fn(null, 'org_member_count', false), false);
    assert.equal(fn({ org_member_count: { back: false } }, 'org_member_count', true), false);
    assert.equal(fn({ org_members_list: { back: true } }, 'org_members_list', false), true);
    assert.equal(fn({ org_members_list: {} }, 'org_members_list', false), false);
    assert.equal(fn(JSON.stringify({ org_member_count: { back: false } }), 'org_member_count', true), false);
    // Hidden overrides never leak across keys.
    assert.equal(fn({ org_member_count: { back: false } }, 'org_members_list', true), true);
  }
});

test('reorderBackFieldOrder moves entries and is bounds-safe', () => {
  assert.deepEqual(reorderBackFieldOrder(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(reorderBackFieldOrder(['a', 'b'], 5, 0), ['a', 'b']);
  assert.equal(reorderBackFieldOrder(null, 0, 1), null);
});
