// Attendee job-title enrichment (Task #3310).
//
// When a booking attendee's job title comes through empty and the attendee's
// email matches a member profile in the same tenant, we store that member's
// own profile job title on the booking row at creation time. Explicitly
// entered per-attendee titles always win; non-member attendees stay blank.
//
// Best-effort: lookup failures never block booking creation.

const norm = (v) => (v || '').toLowerCase().trim();

// Escape LIKE/ILIKE wildcards so an email is matched literally (case-insensitively).
const escapeLikeLiteral = (v) => v.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Batch-fetch member profile job titles keyed by lowercased email for a tenant.
 * Matching is case-insensitive (member emails are not guaranteed lowercased).
 * Returns a Map of lowercased email -> job title (only entries with a
 * non-blank job title are included).
 */
export async function fetchMemberJobTitlesByEmail(supabase, tenantId, emails) {
  const map = new Map();
  if (!tenantId) return map;
  const list = [...new Set((emails || []).map(norm).filter((e) => e && e.includes('@')))];
  if (list.length === 0) return map;
  try {
    const CONCURRENCY = 5;
    for (let i = 0; i < list.length; i += CONCURRENCY) {
      await Promise.all(
        list.slice(i, i + CONCURRENCY).map(async (email) => {
          const { data, error } = await supabase
            .from('member')
            .select('email, job_title')
            .eq('tenant_id', tenantId)
            .ilike('email', escapeLikeLiteral(email))
            .limit(5);
          if (error) {
            console.error('[attendeeJobTitleEnrichment] member lookup failed:', error.message);
            return;
          }
          for (const m of data || []) {
            const key = norm(m.email);
            const title = (m.job_title || '').trim();
            if (key && title && !map.has(key)) map.set(key, title);
          }
        })
      );
    }
  } catch (e) {
    console.error('[attendeeJobTitleEnrichment] member lookup exception:', e.message);
  }
  return map;
}

/**
 * Resolve the job title to store on a booking row. An explicitly entered
 * title always wins; otherwise fall back to the attendee's own member-profile
 * title (from fetchMemberJobTitlesByEmail); otherwise null.
 */
export function resolveStoredJobTitle(explicitTitle, attendeeEmail, titleByEmail) {
  const explicit = (explicitTitle || '').trim();
  if (explicit) return explicit;
  return (titleByEmail && titleByEmail.get(norm(attendeeEmail))) || null;
}
