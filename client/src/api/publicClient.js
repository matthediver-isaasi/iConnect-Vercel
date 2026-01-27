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
 * Get tenant slug from various sources
 * Priority: URL query param > localStorage > subdomain > VITE env var
 */
function getTenantSlugFromSources() {
  // Check URL query parameter first (for testing specific tenants)
  const urlParams = new URLSearchParams(window.location.search);
  const queryTenant = urlParams.get('tenant');
  if (queryTenant) {
    return queryTenant;
  }
  
  // Check localStorage for tenant preference
  const storedTenant = localStorage.getItem('tenant_slug');
  if (storedTenant) {
    return storedTenant;
  }
  
  return null;
}

/**
 * Extract tenant slug from the current hostname's subdomain
 * e.g., "gsf.iconn.app" -> "gsf"
 * e.g., "bnms.iconn.app" -> "bnms"
 * 
 * Returns null if tenant cannot be determined from hostname
 */
function getTenantSlugFromSubdomain(hostname) {
  // Development mode - no subdomain detection possible
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.includes('.repl.')) {
    return null;
  }
  
  // Extract subdomain from hostname
  // Expected format: {tenant}.iconn.app or {tenant}.customdomain.com
  const parts = hostname.split('.');
  
  // Need at least 3 parts for subdomain (e.g., gsf.iconn.app)
  if (parts.length >= 3) {
    const subdomain = parts[0];
    // Exclude common non-tenant subdomains
    if (['www', 'api', 'app', 'admin', 'staging', 'dev'].includes(subdomain.toLowerCase())) {
      return null;
    }
    return subdomain;
  }
  
  return null;
}

/**
 * Extract tenant slug from the current hostname's subdomain
 * Tries multiple sources in priority order
 * 
 * @returns {string|null} The tenant slug or null if not determinable
 */
export function getTenantSlugFromLocation() {
  const hostname = window.location.hostname;
  
  // Try query param or localStorage first
  const configuredTenant = getTenantSlugFromSources();
  if (configuredTenant) {
    console.log('[publicClient] Using configured tenant:', configuredTenant);
    return configuredTenant;
  }
  
  // Try subdomain detection
  const subdomainTenant = getTenantSlugFromSubdomain(hostname);
  if (subdomainTenant) {
    console.log('[publicClient] Detected tenant from subdomain:', subdomainTenant);
    return subdomainTenant;
  }
  
  // Check Vite environment variable (build-time config)
  const envTenant = import.meta.env.VITE_DEFAULT_TENANT;
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
      try {
        const errorJson = JSON.parse(errorBody);
        errorMessage = errorJson.message || errorJson.error || response.statusText;
      } catch {
        errorMessage = errorBody || response.statusText;
      }
      throw new Error(`Public API Error (${response.status}): ${errorMessage}`);
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
  async listNavigationItems() {
    return this._fetch('/api/public/navigation-items');
  }
  
  // Pages (IEdit CMS pages)
  async getPage(slug) {
    if (!slug) return null;
    return this._fetch(`/api/public/page?slug=${encodeURIComponent(slug)}`);
  }
  
  // Roles (for ticket pricing display)
  async listRoles() {
    return this._fetch('/api/public/roles');
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
  async listOrganizations() {
    return this._fetch('/api/public/organisations');
  }
  
  async getOrganization(id) {
    if (!id) return null;
    return this._fetch(`/api/public/organisation/${id}`);
  }
  
  // Categories
  async listCategories() {
    return this._fetch('/api/public/categories');
  }
  
  // Banners
  async listBanners() {
    return this._fetch('/api/public/banners');
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
  async getTenantBranding() {
    return this._fetch('/api/public/tenant-branding');
  }
  
  async getPortalBranding() {
    return this._fetch('/api/public/portal-branding');
  }
  
  // Search
  async search(query) {
    if (!query) return { results: [] };
    return this._fetch(`/api/public/search?q=${encodeURIComponent(query)}`);
  }
  
  // Forms
  async getForm(slug) {
    if (!slug) return null;
    return this._fetch(`/api/public/form/${encodeURIComponent(slug)}`);
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
    return this._fetch('/api/public/form-submission', {
      method: 'POST',
      body: JSON.stringify(submissionData)
    });
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
}

// Export singleton instance
export const publicClient = new PublicClient();

// Export class for testing or custom instances
export { PublicClient };
