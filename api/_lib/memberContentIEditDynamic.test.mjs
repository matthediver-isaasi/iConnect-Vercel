import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveIEditDynamic } from './memberContentIEditDynamic.js';
import { IEDIT_COMPONENT_POLICIES } from './memberContentIEditExtraction.js';

function database(tables, options = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table, filters: [], orders: [] };
      calls.push(call);
      const q = {
        select(columns, opts) { call.columns = columns; call.options = opts; return q; },
        eq(key, value) { call.filters.push([key, value]); return q; },
        in(key, value) { call.filters.push([key, value]); return q; },
        order(key, opts) { call.orders.push([key, opts.ascending]); return q; },
        abortSignal(signal) { call.signal = signal; return q; },
        then(resolve, reject) { return q.range(0, 9999).then(resolve, reject); },
        range(start, end) {
          call.range = [start, end];
          options.onRead?.(call);
          if (options.error === table) return Promise.resolve({ error: { message: 'offline' } });
          let data = (tables[table] || []).map(r => ({ tenant_id: 'tenant', ...r })).filter(r =>
            call.filters.every(([key, val]) => {
              if (key === 'organization.tenant_id') {
                const parent = (tables.organization || []).find(o => o.id === r.organization_id);
                return parent && (parent.tenant_id || 'tenant') === val;
              }
              return Array.isArray(val) ? val.includes(r[key]) : r[key] === val;
            }));
          for (const [key, asc] of [...call.orders].reverse()) data.sort((a, b) =>
            (a[key] === b[key] ? 0 : a[key] > b[key] ? 1 : -1) * (asc ? 1 : -1));
          const count = data.length;
          data = data.slice(start, end + 1);
          if (options.truncate === table) data = data.slice(0, 1);
          return Promise.resolve({ data, count });
        },
      };
      return q;
    },
  };
}
const resolve = (db, type, content = {}, visibilityCtx = null) => resolveIEditDynamic({
  supabase: db, tenantId: 'tenant', element: { id: 'element', element_type: type, content }, visibilityCtx,
});
const allText = result => result.sections.map(s => s.text).join('\n');

test('tenant scoping, exact count, stable bounded pagination and error failure', async () => {
  const db = database({ job_posting: Array.from({ length: 201 }, (_, i) => ({
    id: String(i).padStart(3, '0'), title: `Job ${i}`, status: 'active', created_date: '2020-01-01',
  })) });
  await resolve(db, 'featured_job');
  assert.equal(db.calls.length, 2);
  for (const call of db.calls) {
    assert.ok(call.filters.some(([key, value]) => key === 'tenant_id' && value === 'tenant'));
    assert.deepEqual(call.orders.at(-1), ['id', true]);
    assert.equal(call.options.count, 'exact');
  }
  await assert.rejects(resolve(database({ job_posting: [
    { id: 'a', status: 'active' }, { id: 'b', status: 'active' },
  ] }, { truncate: 'job_posting' }), 'featured_job'), /incomplete page/);
  await assert.rejects(resolve(database({}, { error: 'job_posting' }), 'featured_job'), /offline/);
});

test('featured jobs prefer featured unexpired; specific selection bypasses expiry', async () => {
  const db = database({ job_posting: [
    { id: 'old', title: 'Expired', status: 'active', featured: true, closing_date: '2000-01-01' },
    { id: 'new', title: 'Recent', status: 'active', created_date: '2025-01-01' },
    { id: 'featured', title: 'Featured', status: 'active', featured: true, company_name: 'Employer' },
    { id: 'cross', title: 'Cross tenant', status: 'active', tenant_id: 'other', featured: true },
  ] });
  assert.match(allText(await resolve(db, 'featured_job')), /Featured\nEmployer/);
  assert.equal(allText(await resolve(db, 'featured_job', { specific_job_id: 'old' })), 'Expired\n2000-01-01');
});

test('showcase reserves manually selected items before assigning automatic cards', async () => {
  const db = database({ news_post: [
    { id: 'a', title: 'Newest', summary: '<p>Summary</p>', status: 'published', published_date: '2024-02-01' },
    { id: 'b', title: 'Older', status: 'published', published_date: '2024-01-01' },
    { id: 'future', title: 'Future', status: 'published', published_date: '2999-01-01' },
  ] });
  const result = await resolve(db, 'showcase', { cardCount: 1, cards: [
    { contentType: 'news', autoLatest: true }, { contentType: 'news', itemId: 'a', showLabel: false },
  ] });
  assert.equal(result.sections.length, 2);
  assert.match(result.sections[0].text, /^Older/);
  assert.equal(result.sections[1].text, 'Newest\nSummary');
  assert.doesNotMatch(allText(result), /Future/);
});

test('resource dependencies enumerate protected authored text but filter it per live audience', async () => {
  const tables = { resource: [
    { id: 'public', title: 'Public', status: 'active', is_public: true },
    { id: 'role', title: 'Role protected', status: 'active', is_public: false, allowed_role_ids: ['editor'] },
    { id: 'draft', title: 'Draft', status: 'draft', is_public: true },
  ] };
  const content = { resourceIds: ['public', 'role', 'draft'] };
  const index = await resolve(database(tables), 'resources_showcase', content);
  assert.deepEqual(index.sections.map(s => s.accessScope), ['public', 'authenticated']);
  assert.deepEqual(index.sections[1].provenance.dependencies.find(d => d.table === 'resource').access.allowed_role_ids, ['editor']);
  const guest = await resolve(database(tables), 'resources_showcase', content, { tenantId: 'tenant', isAuthenticated: false });
  assert.equal(allText(guest), 'Public');
  const wrongRole = await resolve(database(tables), 'resources_showcase', content, { isAuthenticated: true, roleId: 'reader' });
  assert.equal(allText(wrongRole), 'Public');
  const authorized = await resolve(database(tables), 'resources_showcase', content, { isAuthenticated: true, roleId: 'editor' });
  assert.equal(allText(authorized), 'Public\nRole protected');
});

test('resource category restriction does not become public through embedding', async () => {
  const tables = {
    resource_category: [{ id: 'cat', subcategories: ['Secret'], excluded_role_ids: ['reader'] }],
    resource: [{ id: 'r', title: 'Categorized', status: 'active', is_public: true, subcategories: ['Secret'] }],
  };
  const content = { resourceIds: ['r'] };
  assert.equal((await resolve(database(tables), 'resources_showcase', content)).sections[0].accessScope, 'authenticated');
  assert.equal((await resolve(database(tables), 'resources_showcase', content, { isAuthenticated: false })).sections.length, 0);
});

test('wall of fame follows active hierarchy and emits reverse-card copy without private member lookup', async () => {
  const db = database({
    wall_of_fame_section: [{ id: 's', name: 'Honours', is_active: true }],
    wall_of_fame_category: [{ id: 'c', name: 'Winners', section_id: 's', is_active: true }],
    wall_of_fame_person: [
      { id: 'p', category_id: 'c', is_active: true, first_name: 'Ada', last_name: 'Example',
        biography: '<p>Authored biography</p>', secondary_organisation: 'Public affiliation', member_id: 'private' },
      { id: 'inactive', category_id: 'c', is_active: false, first_name: 'Invisible' },
    ],
  });
  const result = await resolve(db, 'wall_of_fame', { section_id: 's', show_bio_snippet: false });
  assert.match(allText(result), /Authored biography/);
  assert.doesNotMatch(allText(result), /Invisible|private/);
  assert.ok(!db.calls.some(c => c.table === 'member'));
  assert.equal(result.sections.at(-1).provenance.dependencies.length, 3);
});

test('gallery captions inherit parent access, including unrestricted private galleries', async () => {
  const tables = {
    gallery: [{ id: 'g', title: 'Private album', is_public: false }],
    gallery_photo: [{ id: 'p', gallery_id: 'g', caption: 'Caption', alt_text: 'Fallback', file_url: 'secret-url' }],
  };
  const result = await resolve(database(tables), 'gallery');
  assert.equal(result.sections[1].text, 'Caption');
  assert.equal(result.sections[1].accessScope, 'authenticated');
  assert.equal(result.sections[1].provenance.dependencies[0].access.is_public, false);
  assert.equal((await resolve(database(tables), 'gallery', {}, { isAuthenticated: false })).sections.length, 0);
});

test('event nested speakers and prices inherit group access and display toggles', async () => {
  const tables = {
    event: [{ id: 'e', title: 'Event', summary: 'Summary', description: 'Hidden description', status: 'published',
      member_group_id: 'group', speaker_ids: ['s'], pricing_config: { ticket_classes: [{ name: 'Standard', price: 20 }] } }],
    speaker: [{ id: 's', full_name: 'Speaker', organization: 'Public organisation', job_title: 'Presenter' }],
  };
  const content = { event_id: 'e', show_description: false };
  const result = await resolve(database(tables), 'event_spotlight', content);
  assert.ok(result.sections.every(s => s.accessScope === 'authenticated'));
  assert.match(allText(result), /Speaker\nPublic organisation\nPresenter/);
  assert.match(allText(result), /Standard\n£20/);
  assert.doesNotMatch(allText(result), /Hidden description/);
  assert.equal((await resolve(database(tables), 'event_spotlight', content,
    { isAuthenticated: false, groupIds: new Set() })).sections.length, 0);
});

test('form indexing only authored visible labels; values, drafts, hidden and CRM options excluded', async () => {
  const db = database({ form: [{ id: 'f', slug: 'test', is_active: true, name: 'Apply', fields: [
    { id: 'a', label: 'Your name', default_value: 'Private applicant', options: ['CRM value'] },
    { id: 'b', label: 'Hidden label', starts_hidden: true },
    { id: 'c', label: 'Section', children: [{ label: 'Nested label', default_value: 'Secret' }] },
    { id: 'd', type: 'instructions', label: 'Read first', content: '<p>Authored instructions</p>' },
  ] }] });
  const result = await resolve(db, 'form', { form_slug: 'test' });
  assert.match(allText(result), /Nested label/);
  assert.match(allText(result), /Apply/);
  assert.match(allText(result), /Authored instructions/);
  assert.doesNotMatch(allText(result), /Private|Hidden|CRM|Secret/);
  assert.deepEqual([...new Set(db.calls.map(c => c.table))], ['form']);
  assert.ok(result.coverage.some(c => c.code === 'authored_form_copy_only'));
});

test('directory publishes only eligible configured names, never preference values or member records', async () => {
  const db = database({
    system_settings: [
      { id: 'setting', setting_key: 'org_directory_allowed_application_statuses', setting_value: '["Approved"]' },
      { id: 'exclude', setting_key: 'org_directory_excluded_orgs', setting_value: '["excluded"]' },
    ],
    organization: [{ id: 'a', name: 'Published Company', email: 'private@example.com' }, { id: 'b', name: 'Unapproved Company' }],
    preference_field: [{ id: 'f', name: 'application_status', entity_scope: 'organization', is_active: true }],
    organization_preference_value: [{ id: 'v', organization_id: 'a', field_id: 'f', value: 'Approved' }],
  });
  const result = await resolve(db, 'organisation_directory', { showMemberCount: true });
  assert.equal(allText(result), 'Published Company');
  assert.doesNotMatch(JSON.stringify(result.sections), /private@example|Approved/);
  assert.ok(!db.calls.some(c => c.table === 'member'));
  const preferenceRead = db.calls.find(c => c.table === 'organization_preference_value');
  assert.match(preferenceRead.columns, /organization!inner\(tenant_id\)/);
  assert.ok(preferenceRead.filters.some(([key, val]) => key === 'organization.tenant_id' && val === 'tenant'));
  assert.ok(!preferenceRead.filters.some(([key]) => key === 'tenant_id'));
});

test('carousels explicitly audited as static; unknown dynamic type fails closed', async () => {
  assert.equal((await resolve(database({}), 'hero_carousel')).coverage[0].code, 'static_renderer');
  assert.equal((await resolve(database({}), 'banner_carousel')).coverage[0].code, 'static_renderer');
  await assert.rejects(resolve(database({}), 'new_dynamic'), /Unsupported iEdit dynamic renderer/);
});

test('every dynamic extraction policy has a real resolver, including empty configurations', async () => {
  for (const [type, policy] of Object.entries(IEDIT_COMPONENT_POLICIES)) {
    if (!policy.dynamic) continue;
    const result = await resolve(database({}), type);
    assert.ok(Array.isArray(result.sections), type);
    assert.ok(result.coverage.length, type);
  }
});

test('card decks resolve active tenant cards in selected order, dropping absent cards before count', async () => {
  const db = database({ card_deck: [
    { id: 'a', status: 'active', title: 'Card A', description: '<p>Description A</p>',
      links: [{ text: 'Read label', url: 'https://example.test' }, { text: 'Hidden link' }],
      target_url: 'https://example.test/button', button_text: 'Card action' },
    { id: 'b', status: 'active', title: 'Card B', description: 'Description B', target_url: 'https://example.test' },
    { id: 'inactive', status: 'inactive', title: 'Hidden inactive' },
    { id: 'foreign', status: 'active', tenant_id: 'other', title: 'Hidden foreign' },
    { id: 'unselected', status: 'active', title: 'Hidden unselected' },
  ] });
  const config = { cardIds: ['missing', 'inactive', 'foreign', 'b', 'a', 'unselected'], cardCount: 2 };
  const result = await resolve(db, 'card_deck', config);
  assert.deepEqual(result.sections.map(s => s.text), [
    'Card B\nDescription B\nLearn More', 'Card A\nDescription A\nRead label\nCard action',
  ]);
  assert.deepEqual(result.dependencies, ['b', 'a'].map(id => ({ table: 'card_deck', id, tenantId: 'tenant' })));
  assert.doesNotMatch(allText(result), /Hidden|https:/);
  assert.ok(db.calls.every(call => call.filters.some(([key, value]) => key === 'tenant_id' && value === 'tenant')));
  assert.deepEqual((await resolve(db, 'card_deck', { ...config, showCardDescription: false, showCardButton: false })).sections.map(s => s.text),
    ['Card B', 'Card A\nRead label']);
  assert.deepEqual((await resolve(db, 'card_deck', { ...config, cardCount: 0 })).sections, []);
  assert.equal(allText(await resolve(db, 'card_deck', { cardIds: ['b'], cardButtonText: 'Configured label' })),
    'Card B\nDescription B\nConfigured label');
});

test('card decks use bounded ID batches and reject partial/provider failures rather than publishing wrapper-only', async () => {
  const cards = Array.from({ length: 201 }, (_, i) => ({ id: `card-${i}`, status: 'active', title: `Title ${i}` }));
  const db = database({ card_deck: cards });
  const result = await resolve(db, 'card_deck', { cardIds: cards.map(c => c.id).reverse(), cardCount: 3 });
  assert.deepEqual(result.sections.map(s => s.text), ['Title 200', 'Title 199', 'Title 198']);
  assert.equal(db.calls.length, 3);
  assert.ok(db.calls.every(call => call.filters.find(([key]) => key === 'id')[1].length <= 100));
  await assert.rejects(resolve(database({ card_deck: cards }, { truncate: 'card_deck' }),
    'card_deck', { cardIds: cards.map(c => c.id) }), /incomplete page/);
  await assert.rejects(resolve(database({}, { error: 'card_deck' }),
    'card_deck', { cardIds: ['card'] }), /offline/);
});

test('private gallery role policy is enforced again for each live viewer', async () => {
  const tables = {
    gallery: [{ id: 'g', title: 'Role album', is_public: false,
      access_policy: { version: 1, groups: [{ conditions: [{ type: 'role', id: 'r' }] }] } }],
    role: [{ id: 'r', name: 'Member' }],
  };
  const ctx = { isAuthenticated: true, roleId: 'r', member: { id: 'member' } };
  assert.equal(allText(await resolve(database(tables), 'gallery', {}, ctx)), 'Role album\n0 photos');
  assert.equal((await resolve(database(tables), 'gallery', {}, { ...ctx, roleId: 'wrong' })).sections.length, 0);
  await assert.rejects(resolve(database(tables, { error: 'role' }), 'gallery', {}, ctx), /access lookup failed/);
});

test('conditional form labels do not discard unaffected copy or index targeted personalized instructions', async () => {
  const tables = { form: [{ id: 'f', slug: 'f', is_active: true, name: 'Form',
    visibility_rules: [{ actions: [{ action_type: 'set_value', target_field_id: 'private' }] }],
    fields: [
      { id: 'public', label: 'Static question' },
      { id: 'private', type: 'instructions', content: 'Personalized branch' },
    ],
  }] };
  const result = await resolve(database(tables), 'form', { form_slug: 'f' });
  assert.match(allText(result), /Static question/);
  assert.doesNotMatch(allText(result), /Personalized branch/);
});

test('article published bylines read only names and preserve co-author display order', async () => {
  const db = database({
    blog_post: [{ id: 'article', title: 'Article', status: 'published' }],
    blog_post_author: [
      { id: 'b', blog_post_id: 'article', guest_writer_id: 'guest', display_order: 1 },
      { id: 'a', blog_post_id: 'article', author_id: 'member', display_order: 0 },
    ],
    member: [{ id: 'member', first_name: 'Public', last_name: 'Author', email: 'secret@example.com' }],
    guest_writer: [{ id: 'guest', full_name: 'Guest Author', biography: 'Private biography' }],
  });
  const result = await resolve(db, 'showcase', { cards: [{ contentType: 'articles', itemId: 'article' }] });
  assert.match(allText(result), /Public Author & Guest Author/);
  assert.doesNotMatch(allText(result), /secret@|Private biography/);
  assert.equal(db.calls.find(c => c.table === 'member').columns, 'id,first_name,last_name');
});

test('latest resources use release-date order, four-card limit and release gate', async () => {
  const db = database({ resource: [
    ...Array.from({ length: 6 }, (_, i) => ({ id: String(i), title: `Resource ${i}`, status: 'active',
      is_public: true, release_date: `2020-01-0${i + 1}` })),
    { id: 'future', title: 'Unreleased', status: 'active', is_public: true, release_date: '2999-01-01' },
  ] });
  const result = await resolve(db, 'resources_showcase', { resourceSourceMode: 'latest' });
  assert.deepEqual(result.sections.map(s => s.text), ['Resource 5', 'Resource 4', 'Resource 3', 'Resource 2']);
});

test('page ceilings reject oversized results rather than silently accepting first pages', async () => {
  const db = database({ job_posting: Array.from({ length: 10001 }, (_, i) => ({ id: String(i), status: 'active' })) });
  await assert.rejects(resolve(db, 'featured_job'), /unbounded result/);
});

test('authenticated form authored copy is not emitted for a live guest', async () => {
  const db = database({ form: [{ id: 'f', slug: 'f', is_active: true, name: 'Member form',
    require_authentication: true, fields: [{ label: 'Member question' }] }] });
  const index = await resolve(db, 'form', { form_slug: 'f' });
  assert.ok(index.sections.every(s => s.accessScope === 'authenticated'));
  assert.equal((await resolve(db, 'form', { form_slug: 'f' }, { isAuthenticated: false })).sections.length, 0);
});

test('iEdit wall ignores category_id and repeats hierarchy context on every person section', async () => {
  const db = database({
    wall_of_fame_section: [{ id: 's', name: 'Leadership', is_active: true }],
    wall_of_fame_category: [
      { id: 'board', section_id: 's', name: 'Board Chairs', is_active: true },
      { id: 'team', section_id: 's', name: 'Operations Team', is_active: true },
    ],
    wall_of_fame_person: [
      { id: 'p1', category_id: 'board', first_name: 'Board Person', job_title: 'External Employer CEO', is_active: true },
      { id: 'p2', category_id: 'team', first_name: 'Team Person', job_title: 'External Employer Manager', is_active: true },
    ],
  });
  const result = await resolve(db, 'wall_of_fame', { section_id: 's', category_id: 'board' });
  const people = result.sections.filter(s => s.provenance.presentation === 'person-detail');
  assert.equal(people.length, 2);
  assert.match(people[0].text, /Leadership\nBoard Chairs\nBoard Person/);
  assert.match(people[1].text, /Leadership\nOperations Team\nTeam Person/);
});

test('future article publication is withheld even if public list endpoint is permissive', async () => {
  const db = database({ blog_post: [
    { id: 'future', title: 'Scheduled private copy', status: 'published', published_date: '2999-01-01' },
    { id: 'current', title: 'Current article', status: 'published', published_date: '2020-01-01' },
  ] });
  const result = await resolve(db, 'showcase', { cards: [
    { contentType: 'articles', itemId: 'future' }, { contentType: 'articles', autoLatest: true },
  ] });
  assert.match(allText(result), /Current article/);
  assert.doesNotMatch(allText(result), /Scheduled private copy/);
});

test('dynamic HTML uses shared readable text: hidden branches removed, alt and full entities preserved', async () => {
  const db = database({ resource: [{ id: 'r', title: 'Visible', status: 'active', is_public: true,
    description: '<p>A &copy; &#x1F600;</p><span hidden>Hidden</span><span aria-hidden="true">Aria hidden</span>' +
      '<span style="display: none">CSS hidden</span><img alt="Useful alternative"><img role="presentation" alt="Decorative">' +
      '<script>secret()</script><input value="Private value"><template>Template secret</template>',
  }] });
  const result = await resolve(db, 'resources_showcase', { resourceIds: ['r'] });
  assert.match(allText(result), /A © 😀/);
  assert.match(allText(result), /Useful alternative/);
  assert.doesNotMatch(allText(result), /Hidden|hidden|Decorative|secret|Private/);
});

test('form success copy is post-submit only and empty hidden HTML never produces a section', async () => {
  const db = database({ form: [{ id: 'f', slug: 'f', name: 'Form', is_active: true,
    success_message: 'Post-submit confidential copy',
    fields: [
      { id: 'i', type: 'instructions', content: '<div hidden>Hidden instructions</div>' },
      { id: 'empty', label: '', description: '  ' },
    ],
  }] });
  const result = await resolve(db, 'form', { form_slug: 'f' });
  assert.equal(result.sections.length, 1);
  assert.equal(allText(result), 'Form\nSubmit');
  assert.ok(!db.calls[0].columns.includes('success_message'));
});

test('directory details flags do not fabricate unrendered domains or expose hidden tooltip names', async () => {
  const db = database({ organization: [{ id: 'o', name: 'Published Name', domain: 'private.example', description: 'Private description' }] });
  const visible = await resolve(db, 'organisation_directory', { showDomains: true });
  assert.equal(allText(visible), 'Published Name');
  assert.ok(visible.coverage.some(c => c.detail.includes('showDomains')));
  const hidden = await resolve(db, 'organisation_directory', { showNameTooltip: true, showLogo: false });
  assert.equal(hidden.sections.length, 0);
});

test('compact complete category rosters precede all long biographies with every person dependency', async () => {
  const db = database({
    wall_of_fame_section: [{ id: 's', name: 'Leadership', is_active: true }],
    wall_of_fame_category: [
      { id: 'board', section_id: 's', name: 'Board', is_active: true, display_order: 1 },
      { id: 'team', section_id: 's', name: 'Team', is_active: true, display_order: 2 },
    ],
    wall_of_fame_person: [
      ...Array.from({ length: 8 }, (_, i) => ({
        id: `p${i}`, category_id: 'board', first_name: `Person ${i}`, is_active: true, display_order: i,
        job_title: i === 0 ? 'Chair' : 'Director', secondary_job_title: 'Trustee', secondary_organisation: 'Foundation',
        biography: 'Long biography '.repeat(1000),
      })),
      { id: 't', category_id: 'team', first_name: 'Team Member', job_title: 'Manager', is_active: true },
      { id: 'inactive', category_id: 'board', first_name: 'Inactive Member', is_active: false },
    ],
  });
  const result = await resolve(db, 'wall_of_fame', { section_id: 's' });
  const rosters = result.sections.filter(s => s.provenance.presentation === 'category-roster');
  assert.equal(rosters.length, 2);
  assert.ok(rosters[0].text.length < 1500);
  assert.match(rosters[0].text, /^Leadership\nBoard\nPerson 0 — Chair — Trustee — Foundation/);
  assert.match(rosters[0].text, /Person 7/);
  assert.doesNotMatch(rosters[0].text, /Long biography|Inactive Member/);
  assert.deepEqual(rosters[0].provenance.dependencies.filter(d => d.table === 'wall_of_fame_person').map(d => d.id),
    Array.from({ length: 8 }, (_, i) => `p${i}`));
  const firstDetail = result.sections.findIndex(s => s.provenance.presentation === 'person-detail');
  assert.ok(result.sections.indexOf(rosters[1]) < firstDetail);
  assert.match(result.sections[firstDetail].text, /^Leadership\nBoard\nPerson 0/);
  assert.match(result.sections[firstDetail].text, /Long biography/);
});

test('shared read budget rejects exhausted and expired calls explicitly before querying', async () => {
  const db = database({});
  const run = readBudget => resolveIEditDynamic({ supabase: db, tenantId: 'tenant',
    element: { element_type: 'featured_job', content: {} }, readBudget });
  const shared = { remaining: 1, deadlineMs: Date.now() + 25000 };
  await run(shared);
  assert.equal(shared.remaining, 0);
  assert.ok(db.calls[0].signal instanceof AbortSignal);
  await assert.rejects(run(shared), { code: 'IEDIT_READ_BUDGET' });
  assert.equal(db.calls.length, 1);
  await assert.rejects(run({ remaining: 200, deadlineMs: Date.now() - 1 }), { code: 'IEDIT_READ_BUDGET' });
  assert.equal(db.calls.length, 1);
});

test('page-query budget exhaustion fails the resolution instead of returning partial rows', async () => {
  const db = database({ job_posting: Array.from({ length: 201 }, (_, i) => ({
    id: String(i), status: 'active', title: `Job ${i}`,
  })) });
  await assert.rejects(resolveIEditDynamic({ supabase: db, tenantId: 'tenant',
    element: { element_type: 'featured_job', content: {} },
    readBudget: { remaining: 1, deadlineMs: Date.now() + 25000 } }), { code: 'IEDIT_READ_BUDGET' });
  assert.equal(db.calls.length, 1);
});

test('a query finishing after the deadline rejects rather than publishing its response', async () => {
  const budget = { remaining: 5, deadlineMs: Date.now() + 25000 };
  const db = database({ job_posting: [{ id: 'j', status: 'active', title: 'Late result' }] },
    { onRead: () => { budget.deadlineMs = Date.now() - 1; } });
  await assert.rejects(resolveIEditDynamic({ supabase: db, tenantId: 'tenant',
    element: { element_type: 'featured_job', content: {} }, readBudget: budget }),
  { code: 'IEDIT_READ_BUDGET' });
  assert.equal(budget.remaining, 4);
});
