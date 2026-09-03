/**
 * Public Client for Multi-Tenant SaaS
 * 
 * This client provides access to public API endpoints that don't require authentication.
 * It automatically handles tenant detection from subdomain for proper data isolation.
 * 
 * USE THIS CLIENT when:
 * - Rendering public-facing pages (PublicEvents, PublicArticles, DynamicPage, etc.)
 * - User is not authenticated (no session)
 * - Data should be publicly accessible without login
 * 
 * DO NOT USE when:
 * - User is authenticated and you need to access member-specific data
 * - You need to create, update, or delete records (use base44 client instead)
 */

/**
 * Extract tenant slug from the current hostname's subdomain
 * e.g., "gsf.iconn.app" -> "gsf"
 * e.g., "bnms.iconn.app" -> "bnms"
 * e.g., "gfi.dev.iconn.app" -> "gfi" (Vercel preview branch format)
 * 
 * Returns null if tenant cannot be determined from hostname
 */
function getTenantSlugFromSubdomain(hostname) {
  // Development mode - no subdomain detection possible
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.includes('.repl.')) {
    return null;
  }
  
  // Extract subdomain from hostname
  // Expected formats:
  // - {tenant}.iconn.app (production)
  // - {tenant}.dev.iconn.app (Vercel preview branch)
  // - {tenant}.customdomain.com
  const parts = hostname.split('.');
  
  // Need at least 3 parts for subdomain (e.g., gsf.iconn.app)
  if (parts.length >= 3) {
    const firstPart = parts[0];
    
    // Common non-tenant subdomains that should be skipped
    const nonTenantSubdomains = ['www', 'api', 'app', 'admin', 'staging'];
    
    // Check if first part is 'dev' - this indicates Vercel preview format
    // In this case, we can't determine tenant from subdomain alone
    // as 'dev' is the environment indicator, not the tenant
    if (firstPart.toLowerCase() === 'dev') {
      return null;
    }
    
    // For {tenant}.dev.iconn.app format (4+ parts where second part is 'dev')
    // The tenant is the first part
    if (parts.length >= 4 && parts[1].toLowerCase() === 'dev') {
      if (!nonTenantSubdomains.includes(firstPart.toLowerCase())) {
        return firstPart;
      }
      return null;
    }
    
    // Standard format: {tenant}.iconn.app
    if (!nonTenantSubdomains.includes(firstPart.toLowerCase())) {
      return firstPart;
    }
  }
  
  return null;
}

/**
 * Extract tenant slug from the current hostname's subdomain
 * Tries multiple sources in priority order
 * 
 * Priority order:
 * 1. URL query param (for testing specific tenants)
 * 2. Subdomain detection (authoritative source for production/preview)
 * 3. localStorage (only when subdomain detection fails, e.g., localhost)
 * 4. VITE_DEFAULT_TENANT env var
 * 
 * @returns {string|null} The tenant slug or null if not determinable
 */
export function getTenantSlugFromLocation() {
  const hostname = window.location.hostname;
  
  // Subdomain detection is the authoritative source for production/preview.
  // It deliberately beats the ?tenant= query param on tenant-subdomain hosts
  // (Task #3387): otherwise typo.iconn.app/?tenant=real would quietly serve
  // the real tenant from the wrong host and wrong-domain links would leak.
  // The query param still works for localhost/custom-host testing below.
  const subdomainTenant = getTenantSlugFromSubdomain(hostname);
  const urlParams = new URLSearchParams(window.location.search);
  const queryTenant = urlParams.get('tenant');
  if (queryTenant && !subdomainTenant) {
    console.log('[publicClient] Using tenant from URL query param:', queryTenant);
    return queryTenant;
  }
  if (queryTenant && subdomainTenant && queryTenant !== subdomainTenant) {
    console.warn('[publicClient] Ignoring ?tenant=', queryTenant, '— host subdomain', subdomainTenant, 'is authoritative');
  }
  
  if (subdomainTenant) {
    console.log('[publicClient] Detected tenant from subdomain:', subdomainTenant);
    // Update localStorage to match current subdomain tenant
    // This ensures consistency if user navigates between tenants
    const storedTenant = localStorage.getItem('tenant_slug');
    if (storedTenant && storedTenant !== subdomainTenant) {
      console.log('[publicClient] Updating cached tenant from', storedTenant, 'to', subdomainTenant);
      localStorage.setItem('tenant_slug', subdomainTenant);
    }
    return subdomainTenant;
  }
  
  // Check localStorage for tenant preference (fallback for local development)
  const storedTenant = localStorage.getItem('tenant_slug');
  if (storedTenant) {
    console.log('[publicClient] Using cached tenant from localStorage:', storedTenant);
    return storedTenant;
  }
  
  // Check Vite environment variable (build-time config)
  // Optional-chained so non-Vite runtimes (node:test component tests) don't
  // crash at module load — import.meta.env only exists under Vite.
  const envTenant = import.meta.env?.VITE_DEFAULT_TENANT;
  if (envTenant) {
    console.log('[publicClient] Using VITE_DEFAULT_TENANT:', envTenant);
    return envTenant;
  }
  
  console.warn('[publicClient] Could not determine tenant slug. Public API requests may fail.');
  return null;
}

/**
 * Make a request to a public API endpoint
 * Includes error handling, automatic JSON parsing, and tenant parameter injection
 */
async function publicFetch(url, options = {}, tenantSlug = null) {
  try {
    // Add tenant parameter to URL if available
    let finalUrl = url;
    if (tenantSlug) {
      const urlObj = new URL(url, window.location.origin);
      urlObj.searchParams.set('tenant', tenantSlug);
      finalUrl = urlObj.pathname + urlObj.search;
    }
    
    const response = await fetch(finalUrl, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      }
    });
    
    if (!response.ok) {
      const errorBody = await response.text();
      let errorMessage;
      let errorData = null;
      try {
        const errorJson = JSON.parse(errorBody);
        errorMessage = errorJson.message || errorJson.error || response.statusText;
        errorData = errorJson;
      } catch {
        errorMessage = errorBody || response.statusText;
      }
      const err = new Error(`Public API Error (${response.status}): ${errorMessage}`);
      err.status = response.status;
      err.errorData = errorData;
      throw err;
    }
    
    return response.json();
  } catch (error) {
    if (error.message && error.message.startsWith('Public API Error')) {
      throw error;
    }
    throw new Error(`Network Error: ${error.message || 'Failed to fetch'}`);
  }
}

/**
 * Public API Client
 * Provides typed methods for accessing public data endpoints
 * Automatically injects tenant parameter for proper multi-tenant isolation
 */
class PublicClient {
  constructor() {
    this.tenantSlug = getTenantSlugFromLocation();
  }
  
  // Get the current tenant slug
  getTenantSlug() {
    return this.tenantSlug;
  }
  
  // Helper to make tenant-aware requests
  _fetch(url, options = {}) {
    return publicFetch(url, options, this.tenantSlug);
  }
  
  // Events
  async listEvents() {
    return this._fetch('/api/public/events');
  }
  
  async getEvent(id) {
    if (!id) return null;
    return this._fetch(`/api/public/event?id=${id}`);
  }
  
  async getEventBySlug(slug) {
    if (!slug) return null;
    return this._fetch(`/api/public/event?slug=${encodeURIComponent(slug)}`);
  }

  // Batched agenda summaries (dates + item type only) for Training event cards
  async listEventAgendaSummaries(eventIds) {
    if (!Array.isArray(eventIds) || eventIds.length === 0) return {};
    return this._fetch(`/api/public/event-agenda-summaries?event_ids=${eventIds.map(encodeURIComponent).join(',')}`);
  }
  
  // Articles / Blog Posts
  async listArticles() {
    return this._fetch('/api/public/articles');
  }
  
  async getArticle(slug, authorHandle = null) {
    if (!slug) return null;
    let url = `/api/public/article?slug=${encodeURIComponent(slug)}`;
    if (authorHandle) {
      url += `&authorHandle=${encodeURIComponent(authorHandle)}`;
    }
    return this._fetch(url);
  }
  
  // News
  async listNews() {
    return this._fetch('/api/public/news');
  }
  
  async getNewsPost(id) {
    if (!id) return null;
    return this._fetch(`/api/public/news-post?id=${id}`);
  }
  
  async getNewsPostBySlug(slug) {
    if (!slug) return null;
    return this._fetch(`/api/public/news-post?slug=${encodeURIComponent(slug)}`);
  }
  
  // Resources
  async listResources() {
    return this._fetch('/api/public/resources');
  }
  
  async getResource(identifier) {
    if (!identifier) return null;
    return this._fetch(`/api/public/resource/${encodeURIComponent(identifier)}`);
  }
  
  // Resource Categories
  async listResourceCategories() {
    return this._fetch('/api/public/resource-categories');
  }
  
  // Navigation
  // Task #2426: pass a microsite path prefix to get that microsite's nav.
  // Without it, only default-site (non-microsite) items are returned.
  async listNavigationItems(micrositePrefix = null) {
    const suffix = micrositePrefix ? `?microsite=${encodeURIComponent(micrositePrefix)}` : '';
    return this._fetch(`/api/public/navigation-items${suffix}`);
  }
  
  // Typography Styles
  async listTypographyStyles() {
    return this._fetch('/api/public/typography-styles');
  }
  
  // Pages (IEdit CMS pages)
  // Task #2426: with micrositePrefix set, resolves the slug within that
  // microsite; without it, microsite-assigned pages 404 at their bare slug.
  async getPage(slug, micrositePrefix = null) {
    if (!slug) return null;
    const suffix = micrositePrefix ? `?microsite=${encodeURIComponent(micrositePrefix)}` : '';
    return this._fetch(`/api/public/page/${encodeURIComponent(slug)}${suffix}`);
  }
  
  // Roles (for ticket pricing display)
  async listRoles() {
    return this._fetch('/api/public/roles');
  }
  
  // Event Sponsors
  async getEventSponsors(eventId, eventType = 'simple') {
    if (!eventId) return { sponsors: [], categories: [], assignments: [] };
    return this._fetch(`/api/public/event-sponsors?event_id=${eventId}&event_type=${eventType}`);
  }

  // Speakers
  async listSpeakers(ids = null) {
    if (ids && Array.isArray(ids) && ids.length > 0) {
      return this._fetch(`/api/public/speakers?ids=${ids.join(',')}`);
    }
    return this._fetch('/api/public/speakers');
  }
  
  async getSpeaker(id) {
    if (!id) return null;
    const speakers = await this.listSpeakers([id]);
    return speakers.length > 0 ? speakers[0] : null;
  }
  
  // Organizations
  async listOrganizations(options = {}) {
    const params = new URLSearchParams();
    if (options.orgFilter && options.orgFilter.type && options.orgFilter.field && options.orgFilter.values?.length > 0) {
      params.set('orgFilter', JSON.stringify(options.orgFilter));
    } else if (options.allowedStatuses && options.allowedStatuses.length > 0) {
      params.set('allowedStatuses', JSON.stringify(options.allowedStatuses));
    }
    if (options.directoryPolicy) {
      params.set('directory', 'true');
    }
    const queryString = params.toString();
    return this._fetch(`/api/public/organisations${queryString ? `?${queryString}` : ''}`);
  }

  // The server resolves persisted conditional rules from the form definition;
  // callers must never send those trusted rules back from the browser.
  async listFormOrganizationOptions(
    formSlug, formId, fieldId, answers = {}, containerFieldId = null, rootSourceAnswers = null,
  ) {
    if ((!formSlug && !formId) || !fieldId) return [];
    return this._fetch('/api/public/organisations', {
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({
        formSlug: formSlug || null,
        formId: formId || null,
        fieldId,
        containerFieldId: containerFieldId || null,
        // Callers of a repeatable child may project just the root values
        // needed by a form-scoped parent. Existing callers retain the
        // historical answer payload when no projection is supplied.
        sourceAnswers: rootSourceAnswers || answers || {},
      }),
    });
  }

  async listFormOrganisationGroupOptions(formSlug, formId, fieldId, containerFieldId = null) {
    if ((!formSlug && !formId) || !fieldId) return [];
    return this._fetch('/api/public/organisation-groups', {
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({
        formSlug: formSlug || null,
        formId: formId || null,
        fieldId,
        containerFieldId: containerFieldId || null,
      }),
    });
  }

  async getFormDropdownPrefill(formSlug, formId, recordId, sourceAnswers = {}) {
    if ((!formSlug && !formId) || !recordId) return null;
    return this._fetch('/api/public/form/dropdown-prefill', {
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({
        formSlug: formSlug || null,
        formId: formId || null,
        recordId,
        sourceAnswers: sourceAnswers || {},
      }),
    });
  }

  async getFormFieldPrefill(formSlug, formId, sourceFieldId, recordId, sourceAnswers = {}) {
    if ((!formSlug && !formId) || !sourceFieldId || !recordId) return null;
    return this._fetch('/api/public/form/dropdown-prefill', {
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({
        formSlug: formSlug || null,
        formId: formId || null,
        sourceFieldId,
        recordId,
        sourceAnswers: sourceAnswers || {},
      }),
    });
  }
  
  async getOrganization(id) {
    if (!id) return null;
    return this._fetch(`/api/public/organisation/${id}`);
  }

  async listOrganizationFieldValues(fieldType, fieldName) {
    if (!fieldType || !fieldName) return [];
    const params = new URLSearchParams({ fieldType, fieldName });
    return this._fetch(`/api/public/organisation-field-values?${params.toString()}`);
  }

  async getPrefillMember(memberId, formSlug) {
    if (!memberId || !formSlug) return null;
    return this._fetch(`/api/public/form/prefill-member?member_id=${encodeURIComponent(memberId)}&form_slug=${encodeURIComponent(formSlug)}`);
  }

  async getPrefillBooking(bookingId, formSlug) {
    if (!bookingId || !formSlug) return null;
    return this._fetch(`/api/public/form/prefill-booking?booking_id=${encodeURIComponent(bookingId)}&form_slug=${encodeURIComponent(formSlug)}`);
  }

  // Task #3399: resolve the authenticated viewer's own booking for the form's
  // linked event (no booking_id needed). The server resolves the member from
  // the session cookie — credentials: 'include' carries it — and returns the
  // same payload shape as getPrefillBooking, with nulls when there is nothing
  // to prefill.
  async getPrefillBookingForViewer(formSlug) {
    if (!formSlug) return null;
    return this._fetch(`/api/public/form/prefill-booking?resolve=viewer&form_slug=${encodeURIComponent(formSlug)}`, {
      credentials: 'include'
    });
  }
  
  // Categories
  async listCategories() {
    return this._fetch('/api/public/categories');
  }
  
  // Banners
  async listBanners() {
    return this._fetch('/api/public/banners');
  }

  // Card Decks (active cards for the current tenant; used by IEdit Card Deck renderer)
  async listCardDecks() {
    return this._fetch('/api/public/card-decks');
  }
  
  // Button Styles
  async listButtonStyles() {
    return this._fetch('/api/public/button-styles');
  }
  
  // System Settings (whitelisted public settings only)
  async listSystemSettings() {
    return this._fetch('/api/public/system-settings');
  }
  
  async getSystemSetting(key) {
    if (!key) return null;
    const settings = await this._fetch(`/api/public/system-settings?key=${encodeURIComponent(key)}`);
    return settings.length > 0 ? settings[0] : null;
  }

  // Article Settings (public-safe article display settings)
  async getArticleSettings() {
    return this._fetch('/api/public/article-settings');
  }

  // Article Comments (when public comments are enabled)
  async getArticleComments(articleId) {
    if (!articleId) return { comments: [] };
    return this._fetch(`/api/public/article-comments?articleId=${encodeURIComponent(articleId)}`);
  }

  async postArticleComment(articleId, data) {
    if (!articleId) throw new Error('Article ID is required');
    return this._fetch(`/api/public/article-comments?articleId=${encodeURIComponent(articleId)}`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  // Article Reactions (for public users)
  async getArticleReactions(articleId) {
    if (!articleId) return { reactions: [] };
    return this._fetch(`/api/public/article-reactions?articleId=${encodeURIComponent(articleId)}`);
  }

  async postArticleReaction(articleId, data) {
    if (!articleId) throw new Error('Article ID is required');
    return this._fetch(`/api/public/article-reactions?articleId=${encodeURIComponent(articleId)}`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  // Comment Reactions (for public users)
  async getCommentReactionsByUser(userIdentifier) {
    if (!userIdentifier) return { reactions: [] };
    return this._fetch(`/api/public/comment-reactions?userIdentifier=${encodeURIComponent(userIdentifier)}`);
  }

  async postCommentReaction(data) {
    if (!data.comment_id) throw new Error('Comment ID is required');
    return this._fetch('/api/public/comment-reactions', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }
  
  // Tenant Branding
  // Task #2426: with micrositePrefix set, header/footer/logo come back
  // merged with the microsite's overrides and `branding.microsite` is set.
  async getTenantBranding(micrositePrefix = null) {
    const suffix = micrositePrefix ? `?microsite=${encodeURIComponent(micrositePrefix)}` : '';
    return this._fetch(`/api/public/tenant-branding${suffix}`);
  }

  // Microsites (task #2426)
  async listMicrosites() {
    return this._fetch('/api/public/microsites');
  }
  
  async getPortalBranding() {
    return this._fetch('/api/public/portal-branding');
  }
  
  // Search
  //
  // Optional microsite scoping (Task #2550): when called from a microsite page,
  // pass `micrositePrefix` plus `micrositeScope` ('only' = just that microsite's
  // pages, 'all' = tenant-wide but resolve the microsite's own pages to their
  // prefixed URLs). Callers that omit the options keep the tenant-wide default.
  async search(query, { micrositePrefix = null, micrositeScope = null } = {}) {
    if (!query) return { results: [] };
    const params = new URLSearchParams({ q: query });
    if (micrositePrefix) params.set('microsite', micrositePrefix);
    if (micrositeScope) params.set('micrositeScope', micrositeScope);
    return this._fetch(`/api/public/search?${params.toString()}`);
  }
  
  // Forms
  async listForms() {
    return this._fetch('/api/public/forms', { credentials: 'include' });
  }
  
  async getForm(slug, { authenticated = false } = {}) {
    if (!slug) return null;
    const authQuery = authenticated ? '?authenticated=1' : '';
    // Access-policy evaluation is session-derived. Always carry cookies; the
    // query flag only asks the endpoint for the authenticated form shape.
    return this._fetch(`/api/public/form/${encodeURIComponent(slug)}${authQuery}`, {
      credentials: 'include'
    });
  }
  
  // Task #3331: survey opened via an event-assignment link. Returns
  // { assignment, event, form? , closed_message?, require_authentication? } —
  // the server resolves tenant, version snapshot, event and window state.
  async getSurveyAssignment(token) {
    if (!token) return null;
    return this._fetch(`/api/public/survey-assignment/${encodeURIComponent(token)}`, { credentials: 'include' });
  }

  async getFormDraft(token) {
    if (!token) return null;
    return this._fetch(`/api/public/form-draft?token=${encodeURIComponent(token)}`, { credentials: 'include' });
  }
  
  async saveFormDraft(data) {
    return this._fetch('/api/public/form-draft', {
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify(data)
    });
  }
  
  async submitForm(data) {
    // Include tenant in body for backend compatibility, but respect caller-provided values
    // This allows cross-tenant embedding to work correctly when tenantParam is specified
    // Normalize by removing legacy tenantParam field after extracting its value
    const { tenantParam, ...restData } = data;
    const submissionData = {
      ...restData,
      tenant: data.tenant || tenantParam || this.tenantSlug
    };
    // credentials: 'include' so auth-required surveys submitted from the
    // embed/iEdit surfaces carry the browser session to the endpoint (the
    // endpoint accepts a verified same-tenant session as authentication and
    // uses it for respondent dedupe).
    return this._fetch('/api/public/form-submission', {
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify(submissionData)
    });
  }

  async listEligibleFormRelationships(formId) {
    if (!formId) return [];
    return this._fetch(`/api/forms/${encodeURIComponent(formId)}/relationship-definitions`, {
      credentials: 'include'
    });
  }

  async listFormRelationshipOptions(formSlug, fieldId, parentRecordId, containerFieldId = null) {
    if (!formSlug || !fieldId || !parentRecordId) return [];
    const params = new URLSearchParams({
      fieldId,
      // organizationId is retained for older servers; parentRecordId names
      // the scoped relationship parent used by newer endpoints.
      organizationId: parentRecordId,
      parentRecordId,
      page: '1',
      pageSize: '100',
    });
    if (containerFieldId) params.set('containerFieldId', containerFieldId);
    const path = `/api/public/form/${encodeURIComponent(formSlug)}/relationship-options`;
    const requestOptions = {
      credentials: 'include'
    };
    const first = await this._fetch(`${path}?${params.toString()}`, requestOptions);
    const firstItems = Array.isArray(first) ? first : first?.data || [];
    const total = Number(first?.total) || firstItems.length;
    const pages = Math.ceil(total / 100);
    if (pages > 100) throw new Error('Too many related records are available to display.');
    const remaining = [];
    for (let page = 2; page <= pages; page += 1) {
      params.set('page', String(page));
      remaining.push(await this._fetch(`${path}?${params.toString()}`, requestOptions));
    }
    return {
      ...first,
      data: [first, ...remaining].flatMap((result) => (
        Array.isArray(result) ? result : result?.data || []
      )),
    };
  }
  
  // Public Booking
  async getBookingInfo(slug) {
    if (!slug) return null;
    return this._fetch(`/api/public/book/${encodeURIComponent(slug)}`);
  }
  
  async getBookingSlots(slug, params = {}) {
    if (!slug) return null;
    const queryParams = new URLSearchParams(params).toString();
    return this._fetch(`/api/public/book/${encodeURIComponent(slug)}/slots${queryParams ? `?${queryParams}` : ''}`);
  }
  
  // Favicon
  async getFaviconUrl() {
    return this._fetch('/api/public/favicon-url');
  }
  
  // Communication Categories
  async listCommunicationCategories() {
    return this._fetch('/api/public/communication-categories');
  }
  
  // Custom Field
  // formId is optional but recommended for embedded forms to ensure correct tenant resolution
  async getCustomField(id, formId = null) {
    if (!id) return null;
    const url = formId 
      ? `/api/public/custom-field/${id}?form_id=${formId}`
      : `/api/public/custom-field/${id}`;
    return this._fetch(url);
  }
  
  // Role Capacity
  async getRoleCapacity(roleId) {
    if (!roleId) return null;
    return this._fetch(`/api/public/role/${roleId}/capacity`);
  }
  
  // Form Consent Message
  async getFormConsentMessage() {
    return this._fetch('/api/public/form-consent-message');
  }
  
  // Job Postings
  async listJobPostings() {
    return this._fetch('/api/public/job-postings');
  }
  
  // Organization Domains
  async getOrganizationDomains(orgId) {
    if (!orgId) return { verified_domains: [] };
    return this._fetch(`/api/public/organisation/${orgId}/domains`);
  }
  
  // Organization Preference Values (for form prefill)
  async getOrganizationPreferenceValues(orgId) {
    if (!orgId) return [];
    return this._fetch(`/api/public/organisation/${orgId}/preference-values`);
  }
  
  // Submit booking
  async submitBooking(slug, data) {
    if (!slug) {
      throw new Error('Booking slug is required');
    }
    return this._fetch(`/api/public/book/${encodeURIComponent(slug)}`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }
  
  // Wall of Fame
  async listWallOfFameSections() {
    return this._fetch('/api/public/wall-of-fame?type=sections');
  }
  
  async listWallOfFameCategories(sectionId = null) {
    const url = sectionId 
      ? `/api/public/wall-of-fame?type=categories&section_id=${sectionId}`
      : '/api/public/wall-of-fame?type=categories';
    return this._fetch(url);
  }
  
  async listWallOfFamePeople(categoryId = null) {
    const url = categoryId 
      ? `/api/public/wall-of-fame?type=people&category_id=${categoryId}`
      : '/api/public/wall-of-fame?type=people';
    return this._fetch(url);
  }
  
  // Resource Author Settings (display settings for resources page)
  async getResourceAuthorSettings() {
    return this._fetch('/api/public/resource-author-settings');
  }

  async checkMemberEmail(email) {
    if (!email) return { isMember: false };
    return this._fetch('/api/public/check-member-email', {
      method: 'POST',
      body: JSON.stringify({ email })
    });
  }

  // Signed Event allocation context. The server is authoritative for Event,
  // ticket and Organisation; callers should not infer these from query params.
  async getEventAllocationContext(token) {
    if (!token) return null;
    return this._fetch(`/api/public/event-allocation/context/${encodeURIComponent(token)}`, {
      credentials: 'include'
    });
  }

  // Photo Galleries (task #681) - returns public galleries with their photos
  async listGalleries() {
    return this._fetch('/api/public/galleries');
  }

  // Authorized gallery-directory feed. Access (including nested gallery
  // audience rules) is decided by the server from the current session, never
  // by a client-side filter.
  async listGalleryDirectory(search = '') {
    const params = new URLSearchParams();
    if (typeof search === 'string' && search.trim()) params.set('search', search.trim());
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return this._fetch(`/api/public/gallery-directory${suffix}`, {
      credentials: 'include',
    });
  }

  // Single shareable gallery by URL handle (task #1456). Public galleries
  // return their photos plus a resolved `cover_photo` (from cover_photo_id,
  // falling back to the first photo by display order); private galleries
  // return a locked response with a login_redirect_url for anonymous viewers.
  async getGallery(slug, page = 1, limit = 24) {
    if (!slug) return null;
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    return this._fetch(`/api/public/gallery/${encodeURIComponent(slug)}?${params.toString()}`, {
      credentials: 'include',
    });
  }

  async listComplexEvents() {
    return this._fetch('/api/public/complex-events');
  }

  async getComplexEvent(id) {
    if (!id) return null;
    return this._fetch(`/api/public/complex-event?id=${id}`);
  }

  async getComplexEventBySlug(slug) {
    if (!slug) return null;
    return this._fetch(`/api/public/complex-event?slug=${encodeURIComponent(slug)}`);
  }

  async getComplexEventSessions(eventId) {
    if (!eventId) return [];
    return this._fetch(`/api/complex-event-sessions/public?event_id=${eventId}`);
  }

  async submitComplexEventBooking(data) {
    return this._fetch('/api/public/complex-event-booking', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  async createComplexEventPaymentIntent(data) {
    return this._fetch('/api/public/complex-event-payment-intent', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  async validateComplexEventDiscount(data) {
    return this._fetch('/api/public/complex-event-validate-discount', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  // Member Groups (self-join feed by default; explicitly selected active cards
  // may be loaded with a bounded group ID list).
  async listMemberGroups({ groupIds } = {}) {
    const ids = Array.isArray(groupIds)
      ? [...new Set(groupIds.map((id) => String(id || '').trim()).filter(Boolean))].slice(0, 24)
      : [];
    const query = ids.length > 0
      ? `?groupIds=${encodeURIComponent(ids.join(','))}`
      : '';
    return this._fetch(`/api/public/member-groups${query}`);
  }

  async listMemberGroupMembers({
    groupId,
    roles = [],
    page = 1,
    limit = 12,
    presentation,
  } = {}) {
    const id = String(groupId || '').trim();
    if (!id) return null;
    const params = new URLSearchParams({
      groupId: id,
      page: String(page),
      limit: String(limit),
    });
    for (const role of [...new Set(
      (Array.isArray(roles) ? roles : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean),
    )]) {
      params.append('roles', role);
    }
    if (presentation) params.set('presentation', presentation);
    return this._fetch(`/api/public/member-group-members?${params.toString()}`);
  }
}

// Export singleton instance
export const publicClient = new PublicClient();

// Export class for testing or custom instances
export { PublicClient };
