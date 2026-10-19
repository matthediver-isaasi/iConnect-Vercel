// Search projections of the *published renderer*, not generic entity JSON.
// CRM is never emitted except names explicitly published by the directory.
// Policy/booking/preference reads are authorization inputs only. Consumers must
// retain section provenance and re-resolve with visibilityCtx before retrieval.
import { isPublicLibraryResource } from './publicResourceProjection.js';
import { computeHiddenSubcategories, isResourceHiddenByCategories } from './resourceCategoryAccess.js';
import { isPublicSimpleEventStatus } from '../../shared/eventTiming.js';
import { isChunkVisibleToMember } from './memberContentVisibility.js';
import { evaluateGalleryAccessPolicy } from './galleryAccessPolicy.js';
import { normalizeFormAccessPolicy, resolveFormAccess } from './formAccessPolicy.js';
import { normalizeOrganizationPreferenceValues } from './organizationEligibility.js';
import { parseJobClosingDate, startOfLocalToday } from '../../client/src/lib/jobDate.js';
import { repeatableRowChildren } from '../../shared/formRepeatableRows.js';
import { readableText } from './memberContentIEditExtraction.js';

const PAGE = 200;
const MAX_ROWS = 10000;
const arr = value => Array.isArray(value) ? value : [];
const text = parts => parts.filter(v => typeof v === 'string' || typeof v === 'number')
  .map(v => readableText(String(v))).filter(Boolean).join('\n');
const time = value => value ? new Date(value).getTime() || 0 : 0;
function readBudgetError(detail) {
  const error = new Error(`iEdit read budget exhausted: ${detail}`);
  error.code = 'IEDIT_READ_BUDGET';
  return error;
}

/**
 * All reads are tenant-scoped and count-checked, with a unique final ordering.
 * Exact count detects server-side caps shorter than our requested page. Repeated
 * IDs/count changes fail closed rather than publishing a partial generation.
 */
async function rows(db, tenantId, table, columns, filters = {}, order = [], readBudget) {
  const result = [];
  const seen = new Set();
  let expected;
  for (let offset = 0; offset <= MAX_ROWS; offset += PAGE) {
    const remainingMs = readBudget?.deadlineMs - Date.now();
    if (!Number.isFinite(readBudget?.remaining) || readBudget.remaining < 1 ||
        !Number.isFinite(remainingMs) || remainingMs <= 0) {
      throw readBudgetError(`before ${table} page ${offset / PAGE}`);
    }
    readBudget.remaining -= 1;
    // Preference values have no tenant_id in the deployed schema. The inner
    // FK join is the authorization boundary, not a client-side ID assumption.
    const parentScoped = table === 'organization_preference_value';
    let query = db.from(table).select(`id,${columns}${parentScoped ? ',organization!inner(tenant_id)' : ''}`, { count: 'exact' })
      .eq(parentScoped ? 'organization.tenant_id' : 'tenant_id', tenantId);
    for (const [key, value] of Object.entries(filters)) {
      query = Array.isArray(value) ? query.in(key, value) : query.eq(key, value);
    }
    for (const [key, ascending] of order) query = query.order(key, { ascending });
    query = query.order('id', { ascending: true });
    if (typeof query.abortSignal === 'function') {
      query = query.abortSignal(AbortSignal.timeout(Math.max(1, Math.min(5000, Math.floor(remainingMs)))));
    }
    let response;
    try {
      response = await query.range(offset, offset + PAGE - 1);
    } catch (error) {
      if (Date.now() >= readBudget.deadlineMs || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        throw readBudgetError(`timeout reading ${table}`);
      }
      throw error;
    }
    if (Date.now() >= readBudget.deadlineMs) throw readBudgetError(`deadline reading ${table}`);
    const { data, error, count } = response;
    if (error && /abort|timeout/i.test(`${error.name || ''} ${error.message || ''}`)) {
      throw readBudgetError(`timeout reading ${table}`);
    }
    if (error) throw new Error(`iEdit ${table}: ${error.message || error}`);
    if (!Array.isArray(data) || !Number.isInteger(count) || count < 0 ||
        count > MAX_ROWS || (expected !== undefined && expected !== count)) {
      throw new Error(`iEdit ${table}: incomplete or unbounded result`);
    }
    expected = count;
    for (const row of data) {
      if (!row.id || seen.has(row.id)) throw new Error(`iEdit ${table}: unstable pagination`);
      seen.add(row.id);
      result.push(row);
    }
    if (result.length === expected) return result;
    if (data.length !== PAGE || result.length > expected) throw new Error(`iEdit ${table}: incomplete page`);
  }
  throw new Error(`iEdit ${table}: row limit exceeded`);
}

export async function resolveIEditDynamic({
  supabase, tenantId, element, visibilityCtx = null,
  readBudget = { remaining: 200, deadlineMs: Date.now() + 25000 },
}) {
  if (!supabase || !tenantId || !element) throw new Error('iEdit dynamic resolution requires tenant context');
  if (visibilityCtx?.tenantId && visibilityCtx.tenantId !== tenantId) throw new Error('iEdit tenant mismatch');
  const type = element.element_type || element.type;
  const c = element.content || {};
  const sections = [], dependencies = [], coverage = [];
  const scopes = new Map();
  const read = (table, columns, filters, order) => rows(supabase, tenantId, table, columns, filters, order, readBudget);
  const note = (code, detail) => coverage.push({ elementId: element.id, elementType: type, code, detail });
  const dependency = (table, row, extra = {}) => {
    const dep = { table, id: row.id, tenantId, ...extra };
    const existing = dependencies.find(d => d.table === table && d.id === row.id);
    if (existing) return existing;
    dependencies.push(dep);
    return dep;
  };
  const add = (parts, deps = [], scope = 'public') => {
    if (deps.some(d => scopes.get(`${d.table}:${d.id}`) === 'authenticated')) scope = 'authenticated';
    if (scope === 'authenticated' && visibilityCtx && visibilityCtx.isAuthenticated !== true) return;
    const value = text(parts);
    if (value) sections.push({ text: value, accessScope: scope,
      provenance: { elementId: element.id, elementType: type, dependencies: deps, projection: scope === 'public' ? 'public-eligible' : 'audience-gated' } });
  };
  const source = (table, row, parts, parents = []) => add(parts, [...parents, dependency(table, row)]);
  const resourceColumns = 'title,description,status,is_public,member_group_id,allowed_role_ids,linked_events,subcategories,release_date';
  let resourceCache;
  async function publicResources(specific = false) {
    if (resourceCache?.[specific]) return resourceCache[specific];
    const cats = await read('resource_category', 'subcategories,excluded_role_ids,subcategory_excluded_role_ids');
    const hidden = computeHiddenSubcategories(cats, { isGuest: true });
    const all = await read('resource', resourceColumns, { status: 'active' }, [['release_date', false]]);
    const publicEligible = r => r.is_public === true &&
      !arr(r.allowed_role_ids).length && isPublicLibraryResource(r) &&
      !isResourceHiddenByCategories(r, hidden);
    const viewerHidden = visibilityCtx ? computeHiddenSubcategories(cats, {
      roleId: visibilityCtx.roleId, isGuest: visibilityCtx.isAuthenticated === false,
      isPrivileged: visibilityCtx.isAdmin,
    }) : new Set();
    // Collection renderers use the public list even for signed-in users.
    // Specific resource cards use the individually authorized detail endpoint.
    const eligible = all.filter(r => specific || (isPublicLibraryResource(r) && !isResourceHiddenByCategories(r, hidden)));
    let eventIds, sessionIds;
    const selected = [];
    for (const r of eligible) {
      const isPublic = publicEligible(r);
      if (!isPublic && visibilityCtx) {
        if (visibilityCtx.isAuthenticated !== true ||
            !isChunkVisibleToMember({ ...r, content_type: 'resource', tenant_id: tenantId, feature_key: 'content.resources' }, visibilityCtx) ||
            isResourceHiddenByCategories(r, viewerHidden)) continue;
        if (arr(r.linked_events).length && !visibilityCtx.isAdmin) {
          // Access imports the page adapter for live revalidation. Load these
          // entitlement helpers only at runtime to avoid a module-init cycle.
          const { linkedResourceIsEntitled, resolveAccessibleEventIds, resolveAccessibleSessionIds } =
            await import('./memberContentAccess.js');
          eventIds ||= await resolveAccessibleEventIds({ supabase, tenantId, member: visibilityCtx.member });
          sessionIds ||= await resolveAccessibleSessionIds({ supabase, tenantId, member: visibilityCtx.member });
          if (!linkedResourceIsEntitled(r.linked_events, eventIds, sessionIds)) continue;
        }
      }
      if (!isChunkVisibleToMember({ ...r, content_type: 'resource' }, { isAdmin: true })) continue;
      scopes.set(`resource:${r.id}`, isPublic ? 'public' : 'authenticated');
      dependency('resource', r, { access: { contentType: 'resource', feature_key: 'content.resources', status: r.status, is_public: r.is_public,
        member_group_id: r.member_group_id, allowed_role_ids: r.allowed_role_ids, linked_events: r.linked_events,
        subcategories: r.subcategories, release_date: r.release_date, categoryIds: cats.map(cat => cat.id) } });
      selected.push(r);
    }
    for (const cat of cats) dependency('resource_category', cat);
    resourceCache ||= {};
    resourceCache[specific] = selected;
    return selected;
  }
  if (type === 'card_deck') {
    // Public card-decks exposes only this tenant's active cards. Selection order
    // comes from cardIds, not the cards' administrative display_order. Missing
    // cards are removed BEFORE applying cardCount, just as in the renderer.
    const selectedIds = arr(c.cardIds).filter(id => typeof id === 'string' && id);
    const ids = [...new Set(selectedIds)];
    if (ids.length > MAX_ROWS) throw new Error('iEdit card_deck: selection limit exceeded');
    const cards = new Map();
    for (let offset = 0; offset < ids.length; offset += 100) {
      const loaded = await read('card_deck', 'title,description,links,target_url,button_text,status',
        { status: 'active', id: ids.slice(offset, offset + 100) });
      for (const card of loaded) cards.set(card.id, card);
    }
    const selected = selectedIds.map(id => cards.get(id)).filter(Boolean)
      .slice(0, c.cardCount === undefined ? 3 : c.cardCount);
    for (const card of selected) {
      source('card_deck', card, [
        card.title, // Also the renderer's image alt; emit once.
        (c.showCardDescription === undefined || c.showCardDescription) && card.description,
        ...arr(card.links).filter(link => link?.url && link?.text).map(link => link.text),
        (c.showCardButton === undefined || c.showCardButton) && card.target_url &&
          (card.button_text || (c.cardButtonText === undefined ? 'Learn More' : c.cardButtonText)),
      ]);
    }
    note('selected_active_cards', 'Selected active cards in configured order, with count and description/button toggles. Card titles also supply image alt. Link destinations, image URLs and external target content excluded.');
  } else if (type === 'wall_of_fame') {
    if (!c.section_id) {
      note('unconfigured_source', 'No Wall of Fame section selected.');
      return { sections, dependencies, coverage };
    }
    const section = (await read('wall_of_fame_section', 'name,is_active', { id: c.section_id, is_active: true }))[0];
    if (!section) { note('unavailable_source', 'Wall of Fame section inactive or absent.'); return { sections, dependencies, coverage }; }
    const parent = dependency('wall_of_fame_section', section);
    const categories = await read('wall_of_fame_category', 'name,description,section_id,is_active,display_order',
      { section_id: section.id, is_active: true }, [['display_order', true]]);
    // Unlike the canvas block, the iEdit wrapper never passes categoryId.
    // Stale/foreign category_id configuration must not suppress categories.
    const selected = categories;
    const navigation = categories.length > 1;
    const personDetails = [];
    if (c.show_category_name !== false) add([c.custom_title || (navigation ? section.name : selected[0]?.name)], [parent]);
    for (const category of selected) {
      const cat = dependency('wall_of_fame_category', category);
      source('wall_of_fame_category', category, [
        (navigation || c.show_category_name !== false) && (c.custom_title || category.name),
        navigation && category.description,
      ], [parent]);
      const people = await read('wall_of_fame_person',
        'first_name,last_name,job_title,secondary_job_title,secondary_organisation,biography,is_active,category_id,display_order',
        { category_id: category.id, is_active: true }, [['display_order', true]]);
      if (people.length) {
        // Keep every category's compact roster before any long biography.
        // A source-wide chunk cap must not let early biographies consume the
        // budget before the board/team membership list is represented.
        add([section.name, category.name, ...people.map(p => [
          [p.first_name, p.last_name].filter(Boolean).join(' '),
          p.job_title, p.secondary_job_title, p.secondary_organisation,
        ].filter(Boolean).join(' — '))],
        [parent, cat, ...people.map(p => dependency('wall_of_fame_person', p))]);
        sections.at(-1).provenance.presentation = 'category-roster';
      }
      // Biography and job title are visible on the reverse even if hidden on front.
      for (const p of people) personDetails.push({ p, category, cat });
    }
    for (const { p, category, cat } of personDetails) {
      source('wall_of_fame_person', p,
        [section.name, category.name, [p.first_name, p.last_name].filter(Boolean).join(' '),
          p.job_title, p.secondary_job_title, p.secondary_organisation, p.biography], [parent, cat]);
      sections.at(-1).provenance.presentation = 'person-detail';
    }
    note('interactive_content', 'Includes category navigation and card reverse copy. CRM-derived title prefixes excluded.');
  } else if (type === 'resources_showcase') {
    const resources = await publicResources(c.resourceSourceMode !== 'latest');
    const chosen = c.resourceSourceMode === 'latest'
      ? [...resources].sort((a, b) => time(b.release_date) - time(a.release_date)).slice(0, 4)
      : arr(c.resourceIds).map(id => resources.find(r => r.id === id)).filter(Boolean);
    for (const r of chosen) source('resource', r, [r.title, c.showResourceDescription !== false && r.description],
      dependencies.filter(d => d.table === 'resource_category'));
    note('audience_projection', 'Resource publication, release, category, role, group and linked-event gates retained per section; latest limit four.');
  } else if (type === 'showcase') {
    const cards = arr(c.cards);
    let articleLabel = 'Article';
    if (cards.some(card => card.contentType === 'articles' && card.showLabel !== false && !card.labelText)) {
      const settings = await read('system_settings', 'setting_key,setting_value', { setting_key: 'article_display_name' });
      articleLabel = (settings[0]?.setting_value || 'Articles').slice(0, -1) || 'Article';
      for (const setting of settings) dependency('system_settings', setting);
    }
    const lists = {};
    for (const kind of new Set(cards.map(card => card.contentType))) {
      if (kind === 'resources') lists[kind] = await publicResources();
      if (kind === 'news') lists[kind] = (await read('news_post', 'title,summary,status,published_date',
        { status: 'published' }, [['published_date', false]])).filter(r => r.published_date && time(r.published_date) <= Date.now());
      if (kind === 'articles') lists[kind] = await read('blog_post', 'title,summary,status,published_date,author_id,guest_writer_id',
        { status: 'published' }, [['published_date', false]]);
      if (kind === 'articles') lists[kind] = lists[kind].filter(r => !r.published_date || time(r.published_date) <= Date.now());
      if (kind === 'jobs') lists[kind] = await read('job_posting', 'title,description,status,created_date',
        { status: 'active' }, [['created_date', false]]);
    }
    const claimed = new Set(cards.filter(card => !card.autoLatest && card.itemId).map(card => `${card.contentType}:${card.itemId}`));
    const tables = { news: 'news_post', articles: 'blog_post', resources: 'resource', jobs: 'job_posting' };
    for (const card of cards) {
      const list = lists[card.contentType] || [];
      const item = card.autoLatest ? [...list].sort((a, b) =>
        time(b.published_date || b.created_date) - time(a.published_date || a.created_date))
        .find(r => !claimed.has(`${card.contentType}:${r.id}`)) : list.find(r => r.id === card.itemId);
      if (!item) continue;
      claimed.add(`${card.contentType}:${item.id}`);
      const parents = card.contentType === 'resources' ? dependencies.filter(d => d.table === 'resource_category') : [];
      let authorText = '';
      if (card.contentType === 'articles') {
        let links = await read('blog_post_author', 'blog_post_id,author_id,guest_writer_id,display_order',
          { blog_post_id: item.id }, [['display_order', true]]);
        for (const link of links) parents.push(dependency('blog_post_author', link));
        if (!links.length) links = item.author_id ? [{ author_id: item.author_id }]
          : item.guest_writer_id ? [{ guest_writer_id: item.guest_writer_id }] : [];
        const names = [];
        for (const link of links) {
          // Explicitly published byline ONLY, never the broader author/CRM
          // object returned by the endpoint (email, biography, organisation...).
          const table = link.author_id ? 'member' : 'guest_writer';
          const id = link.author_id || link.guest_writer_id;
          if (!id) continue;
          const row = (await read(table, table === 'member' ? 'first_name,last_name' : 'full_name', { id }))[0];
          if (!row) continue;
          parents.push(dependency(table, row, { publication: 'article-byline-name-only' }));
          const name = table === 'member' ? [row.first_name, row.last_name].filter(Boolean).join(' ') : row.full_name;
          if (name) names.push(name);
        }
        authorText = names.reduce((value, name, i) => value + (i === 0 ? '' : i === 1 ? ' & ' : ', ') + name, '');
      }
      source(tables[card.contentType], item, [item.title, item.summary || item.description,
        c.showPublishedDate && item.published_date, authorText,
        card.showLabel !== false && (card.labelText || ({ news: 'News', articles: articleLabel, resources: 'Resource', jobs: 'Job' }[card.contentType]))],
      parents);
    }
    if (cards.some(card => card.contentType === 'articles')) note('published_byline_projection', 'Ordered published co-author names only; private author/CRM fields excluded.');
    note('public_projection', 'Manual reservations precede autoLatest allocation; configured card order retained (cardCount is layout only).');
  } else if (type === 'featured_job') {
    const jobs = await read('job_posting', 'title,company_name,job_type,salary_range,closing_date,status,created_date,featured',
      { status: 'active' }, [['created_date', false]]);
    const job = c.specific_job_id ? jobs.find(j => j.id === c.specific_job_id) : jobs
      .filter(j => !j.closing_date || parseJobClosingDate(j.closing_date) >= startOfLocalToday())
      .sort((a, b) => Number(!!b.featured) - Number(!!a.featured) || time(b.created_date) - time(a.created_date))[0];
    if (job) source('job_posting', job, [job.title, job.company_name, job.job_type, job.salary_range, job.closing_date]);
  } else if (type === 'event_spotlight') {
    if (c.event_id) {
      const event = (await read('event', 'title,summary,description,status,event_state,member_group_id,group_event_public,start_date,end_date,location,speaker_ids,pricing_config', { id: c.event_id }))[0];
      if (event && isPublicSimpleEventStatus(event.status) && event.event_state !== 'draft' &&
          (!visibilityCtx || isChunkVisibleToMember({ ...event, content_type: 'event',
            feature_key: event.member_group_id && event.group_event_public !== true ? 'events.browse-events' : null }, visibilityCtx))) {
        const eventPublic = !event.member_group_id || event.group_event_public === true;
        scopes.set(`event:${event.id}`, eventPublic ? 'public' : 'authenticated');
        const dep = dependency('event', event, { access: { contentType: 'event', member_group_id: event.member_group_id,
          group_event_public: event.group_event_public, status: event.status, event_state: event.event_state } });
        source('event', event, [event.title, event.summary, c.show_description !== false && event.description,
          c.show_date !== false && event.start_date, c.show_time !== false && event.end_date,
          c.show_location !== false && event.location]);
        if (c.show_speakers !== false && arr(event.speaker_ids).length) {
          for (const s of await read('speaker', 'full_name,organization,job_title', { id: event.speaker_ids })) {
            source('speaker', s, [s.full_name, s.organization, s.job_title], [dep]);
          }
        }
        if (c.show_ticket_prices !== false) {
          let pricing = event.pricing_config;
          if (typeof pricing === 'string') {
            try { pricing = JSON.parse(pricing); } catch { throw new Error('iEdit event: invalid pricing configuration'); }
          }
          const tickets = arr(pricing?.ticket_classes);
          const roles = tickets.some(t => arr(t.role_ids).length) ? await read('role', 'name') : [];
          for (const ticket of tickets) add([ticket.name || 'Ticket', `£${Number(ticket.price) || 0}`,
            arr(ticket.role_ids).map(id => roles.find(r => r.id === id)?.name).filter(Boolean).join(', ') || 'All Members'],
          [dep, ...roles.filter(r => arr(ticket.role_ids).includes(r.id)).map(r => dependency('role', r))]);
          if (!tickets.length && pricing?.ticket_price) add(['Standard Ticket', `£${Number(pricing.ticket_price) || 0}`, 'All Members'], [dep]);
        }
      } else note('restricted_or_unavailable_source', 'Event is absent, unpublished, draft or group protected.');
    }
  } else if (type === 'gallery') {
    const galleries = await read('gallery', 'title,description,is_public,access_policy,display_order,created_at',
      {}, [['display_order', true], ['created_at', false]]);
    for (const g of galleries.filter(g => !arr(c.gallery_ids).length || c.gallery_ids.includes(g.id))) {
      if (!g.is_public && visibilityCtx) {
        if (visibilityCtx.isAuthenticated !== true) continue;
        const result = await evaluateGalleryAccessPolicy({ supabase, tenantId, memberId: visibilityCtx.member?.id,
          roleId: visibilityCtx.roleId, policy: g.access_policy, isManager: visibilityCtx.isAdmin === true });
        if (result.code === 'ACCESS_LOOKUP_FAILED') throw new Error('iEdit gallery: access lookup failed');
        if (!result.allowed) continue;
      }
      scopes.set(`gallery:${g.id}`, g.is_public ? 'public' : 'authenticated');
      dependency('gallery', g, { access: { is_public: g.is_public, access_policy: g.access_policy } });
      const parent = dependency('gallery', g);
      const photos = await read('gallery_photo', 'caption,alt_text,gallery_id,display_order,created_at',
        { gallery_id: g.id }, [['display_order', true], ['created_at', true]]);
      source('gallery', g, [g.title, g.description, `${photos.length} photo${photos.length === 1 ? '' : 's'}`]);
      for (const p of photos) {
        source('gallery_photo', p, [p.caption || p.alt_text], [parent]);
      }
    }
    note('interactive_content', 'Gallery cards/lightbox captions; private galleries require current gallery access-policy evaluation.');
  } else if (type === 'form') {
    if (c.form_slug) {
      const form = (await read('form',
        'name,description,slug,is_active,deactivate_at,require_authentication,access_policy,form_type,survey_settings,fields,pages,visibility_rules,submit_button_text',
        { slug: c.form_slug, is_active: true }))[0];
      if (form && (!form.deactivate_at || time(form.deactivate_at) > Date.now())) {
        const policy = normalizeFormAccessPolicy(form.access_policy);
        if (!policy.ok) throw new Error('iEdit form: invalid access policy');
        const dep = dependency('form', form, { access: {
          require_authentication: form.require_authentication, access_policy: form.access_policy,
        } });
        let allowed = true;
        if (policy.restricted && visibilityCtx) {
          const access = await resolveFormAccess({ supabase, tenantId, policy: form.access_policy,
            session: visibilityCtx.isAuthenticated === false ? null : { data: { tenantId } },
            member: visibilityCtx.member || null });
          if (access.code === 'ACCESS_LOOKUP_FAILED') throw new Error('iEdit form: access lookup failed');
          allowed = access.allowed;
        }
        if (form.form_type === 'survey') {
          const assignments = await read('event_survey_assignment', 'form_id,status', { form_id: form.id, status: 'active' });
          if (assignments.length || form.survey_settings?.status !== 'published') {
            allowed = false;
            note('personalized_survey_excluded', 'Assignment-linked surveys and unpublished survey versions are not direct-page content.');
          } else {
            const version = (await read('survey_version', 'fields,pages,visibility_rules,form_id,version_number',
              { form_id: form.id, version_number: form.survey_settings.current_version }))[0];
            if (!version) throw new Error('iEdit form: published survey snapshot missing');
            Object.assign(form, { fields: version.fields, pages: version.pages, visibility_rules: version.visibility_rules });
            dependency('survey_version', version);
          }
        }
        if (allowed) {
          const scope = form.require_authentication || policy.restricted ? 'authenticated' : 'public';
          add([c.show_form_title !== false && form.name, c.show_form_description !== false && form.description,
            form.submit_button_text || 'Submit'], [dep], scope);
          // Conditional branches depend on answers; do not evaluate or index them.
          const conditional = arr(form.visibility_rules).length > 0;
          {
            const conditionalIds = new Set();
            for (const rule of arr(form.visibility_rules)) {
              for (const action of [rule, ...arr(rule.actions)]) {
                for (const id of arr(action.target_field_ids)) conditionalIds.add(id);
                if (action.target_field_id) conditionalIds.add(action.target_field_id);
                if (action.field_id) conditionalIds.add(action.field_id);
                for (const id of Object.keys(action.field_states || {})) conditionalIds.add(id);
              }
            }
            const hiddenPages = new Set(arr(form.pages).filter(p => p.starts_hidden === true || p.starts_hidden === 'true').map(p => p.id));
            for (const id of conditionalIds) hiddenPages.add(id);
            for (const page of arr(form.pages).filter(p => !hiddenPages.has(p.id))) add([page.title, page.description], [dep], scope);
            const visit = (fields, depth = 0) => {
              if (depth > 12) throw new Error('iEdit form: nested field limit exceeded');
              for (const f of arr(fields)) {
                if (f.starts_hidden || conditionalIds.has(f.id) || hiddenPages.has(f.page_id) || f.type === 'hidden' ||
                    f.visibility_rules?.length || f.conditions?.length) continue;
                add([f.label, f.description, f.help_text, f.placeholder,
                  f.type === 'instructions' && f.content,
                  f.type === 'image' && f.image_alt,
                  f.type === 'terms_conditions' && 'I accept the Terms & Conditions',
                  f.type === 'terms_conditions' && f.terms_url && (f.terms_link_text || 'View Terms & Conditions')],
                [dep], scope);
                if (['dropdown', 'select', 'radio', 'checkbox'].includes(f.type) && !f.conditional_filters) {
                  add(arr(f.options).map(option => typeof option === 'string' ? option : option?.label), [dep], scope);
                }
                // Only authored labels: never options, default values, URLs,
                // applicant data, relationship values, or arbitrary object text.
                visit(f.type === 'repeatable_rows' ? repeatableRowChildren(f) : f.children, depth + 1);
              }
            };
            visit(form.fields);
          }
          note('authored_form_copy_only', conditional
            ? 'Rule-targeted fields/pages omitted; unaffected authored labels retained. Answer-dependent visibility is not evaluated offline.'
            : 'Authored visible field/page labels only; no values, CRM options, submission/draft/success or personalized branches.');
        }
      } else note('unavailable_source', 'Form inactive, absent or scheduled deactivation reached.');
    }
  } else if (type === 'organisation_directory') {
    // Mirrors IEditOrganisationDirectoryElement, not the distinct dynamic
    // directory carousel. It publishes names only; showDomains is not rendered.
    const settingRows = await read('system_settings', 'setting_key,setting_value', { setting_key: [
      'org_directory_excluded_orgs', 'org_directory_show_name_tooltip', 'org_directory_show_title',
      'org_directory_allowed_application_statuses', 'org_directory_visible_org_types',
    ] });
    const settings = Object.fromEntries(settingRows.map(s => [s.setting_key, s.setting_value]));
    const savedArray = key => {
      const raw = settings[key];
      if (!raw) return [];
      let parsed = raw;
      if (typeof raw === 'string') {
        try { parsed = JSON.parse(raw); } catch { throw new Error(`iEdit directory: invalid ${key}`); }
      }
      if (!Array.isArray(parsed)) throw new Error(`iEdit directory: invalid ${key}`);
      return parsed.map(String);
    };
    const parents = settingRows.map(s => dependency('system_settings', s));
    const excluded = savedArray('org_directory_excluded_orgs');
    const statuses = savedArray('org_directory_allowed_application_statuses');
    const types = savedArray('org_directory_visible_org_types');
    const tooltip = c.showNameTooltip === true || settings.org_directory_show_name_tooltip === 'true';
    const titleVisible = c.showTitle !== false && settings.org_directory_show_title !== 'false' && !tooltip;
    const logoVisible = c.showLogo !== false;
    if (titleVisible || logoVisible) {
      let organizations = (await read('organization', 'name,logo_url', {}, [['name', true]])).filter(o => !excluded.includes(o.id));
      const fields = statuses.length || types.length ? await read('preference_field',
        'name,entity_scope,is_active', { entity_scope: 'organization', is_active: true,
          name: ['application_status', 'org_type', 'organisation_type', 'organization_type'] }) : [];
      const filters = [];
      if (statuses.length) {
        const field = fields.find(f => f.name === 'application_status');
        // Endpoint legacy behavior: missing status field imposes no restriction.
        if (field) filters.push({ field, values: statuses });
      }
      if (types.length) {
        const field = ['org_type', 'organisation_type', 'organization_type'].map(name => fields.find(f => f.name === name)).find(Boolean);
        if (!field) organizations = [];
        else filters.push({ field, values: types });
      }
      for (const { field, values } of filters) {
        parents.push(dependency('preference_field', field));
        const prefs = await read('organization_preference_value', 'organization_id,field_id,value', { field_id: field.id });
        const eligible = new Set(prefs.filter(p => (normalizeOrganizationPreferenceValues(p.value) || [])
          .some(v => values.includes(v))).map(p => p.organization_id));
        organizations = organizations.filter(o => eligible.has(o.id));
        // Values are authorization-only; neither provenance nor text carries them.
      }
      organizations.sort((a, b) => (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase()));
      // The renderer always slices, even when pagination controls are disabled.
      if (c.showPagination === false) organizations = organizations.slice(0,
        (parseInt(c.columns, 10) || 3) * (parseInt(c.rowsPerPage, 10) || 4));
      for (const org of organizations) {
        if (titleVisible || (logoVisible && (tooltip || org.logo_url))) source('organization', org, [org.name], parents);
      }
    }
    note('published_directory_projection', 'Only public configured organisation names, exclusion/status/type filters and alphabetical order; columns × rowsPerPage controls paging. showDomains is stored but never rendered by this iEdit component; no description/contact/custom-field details render. Paginated navigation included when enabled.');
    if (c.showMemberCount) note('private_aggregate_excluded', 'Authenticated CRM-derived member counts are not indexed.');
  } else if (type === 'hero_carousel' || type === 'banner_carousel') {
    note('static_renderer', 'Audited renderer uses authored slides/banners only, with no dynamic source queries.');
  } else {
    throw new Error(`Unsupported iEdit dynamic renderer: ${type}`);
  }
  if (!coverage.length) note('renderer_projection', `Resolved ${sections.length} visible-text sections with source access provenance.`);
  return { sections, dependencies, coverage };
}
