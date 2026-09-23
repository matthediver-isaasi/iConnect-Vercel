import { canIssueApplicantContinuation, issueApplicantContinuation } from './formApplicantContinuation.js';
import { classifyFormMutationContract, FORM_RECORD_ACCESS } from '../../shared/formMutationContract.js';

const LINK_ATTRIBUTE = /(\bhref\s*=\s*)(["'])(.*?)\2/gi;
const SAFE_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/i;

function normalizedHost(value) {
  return String(value || '').trim().toLowerCase().replace(/\.$/, '');
}

function tenantHosts(tenant) {
  const hosts = new Set();
  const custom = normalizedHost(tenant?.domain);
  if (custom) {
    hosts.add(custom);
    hosts.add(custom.startsWith('www.') ? custom.slice(4) : `www.${custom}`);
  }
  const slug = String(tenant?.slug || '').trim().toLowerCase();
  if (SAFE_SLUG.test(slug)) hosts.add(`${slug}.iconn.app`);
  return hosts;
}

function parseCandidate(rawHref, allowedHosts) {
  const decoded = String(rawHref || '').replace(/&amp;/gi, '&');
  if (!decoded || decoded.startsWith('//')) return null;
  let url;
  let relative = false;
  try {
    relative = decoded.startsWith('/');
    url = new URL(decoded, 'https://workflow-link.invalid');
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (!relative && (url.protocol !== 'https:' || url.port
    || !allowedHosts.has(normalizedHost(url.hostname)))) {
    return null;
  }
  if (relative && url.hostname !== 'workflow-link.invalid') return null;

  let slug = null;
  if (url.pathname.toLowerCase() === '/formview') {
    if (url.searchParams.getAll('slug').length !== 1) return null;
    slug = url.searchParams.get('slug');
  } else {
    const pathParts = url.pathname.split('/').filter(Boolean);
    if (pathParts.length === 1) {
      try {
        slug = decodeURIComponent(pathParts[0]);
      } catch {
        return null;
      }
    }
  }
  if (url.searchParams.getAll('organization_id').length !== 1
    || url.searchParams.has('applicant_continuation_token')) return null;
  if (!slug || !SAFE_SLUG.test(slug)) return null;
  return { decoded, url, slug };
}

function formRequiresOrganizationContinuation(form, tenantId) {
  if (!form || String(form.tenant_id) !== String(tenantId)
    || form.is_active === false || form.require_authentication === true
    || !canIssueApplicantContinuation(form)) return false;
  const classification = classifyFormMutationContract(form);
  return classification.targets.organization.classification
    === FORM_RECORD_ACCESS.MAY_MUTATE_EXISTING;
}

/**
 * Mint applicant authority only for links embedded by a trusted organisation
 * workflow. Bare organisation IDs are useful prefill context, but never the
 * authority: the issued grant is tenant/form/organisation/configuration bound.
 */
export async function issueWorkflowApplicantContinuationLinks({
  html,
  tenantId,
  entityType,
  organizationId,
  db,
  issueContinuation = issueApplicantContinuation,
  issuedBy = 'trusted_workflow',
}) {
  if (typeof html !== 'string' || !html || entityType !== 'organization'
    || !tenantId || !organizationId || !db) return html;

  const { data: tenant, error: tenantError } = await db.from('tenant')
    .select('id, slug, domain').eq('id', tenantId).maybeSingle();
  if (tenantError) throw tenantError;
  if (!tenant || String(tenant.id) !== String(tenantId)) return html;
  const allowedHosts = tenantHosts(tenant);

  const matches = [...html.matchAll(LINK_ATTRIBUTE)];
  if (!matches.length) return html;
  const replacements = new Map();
  const grants = new Map();

  for (const match of matches) {
    const href = match[3];
    const candidate = parseCandidate(href, allowedHosts);
    if (!candidate || candidate.url.searchParams.get('organization_id') !== String(organizationId)) {
      continue;
    }
    // Load the complete persisted form contract. The continuation digest is
    // deliberately configuration-sensitive and must be computed from exactly
    // the same persisted values later reloaded by submission processing.
    const { data: form, error: formError } = await db.from('form').select('*')
      .eq('tenant_id', tenantId).eq('slug', candidate.slug)
      .eq('is_active', true).maybeSingle();
    if (formError) throw formError;
    if (!formRequiresOrganizationContinuation(form, tenantId)) continue;

    let grant = grants.get(form.id);
    if (!grant) {
      grant = await issueContinuation({ db, form, organizationId, issuedBy });
      grants.set(form.id, grant);
    }
    candidate.url.searchParams.set(
      'applicant_continuation_token',
      grant.applicant_continuation_token,
    );
    let nextHref = candidate.url.toString();
    if (candidate.decoded.startsWith('/')) {
      nextHref = `${candidate.url.pathname}${candidate.url.search}${candidate.url.hash}`;
    }
    if (/&amp;/i.test(href)) nextHref = nextHref.replace(/&/g, '&amp;');
    replacements.set(href, nextHref);
  }

  if (!replacements.size) return html;
  return html.replace(LINK_ATTRIBUTE, (whole, prefix, quote, href) => (
    replacements.has(href) ? `${prefix}${quote}${replacements.get(href)}${quote}` : whole
  ));
}
