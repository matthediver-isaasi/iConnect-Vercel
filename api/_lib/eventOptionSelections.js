// Task #1250: Dietary, accessibility & allergy option selections.
//
// Admin-defined option lists live on the event / complex_event row
// (dietary_options, allergy_options, accessibility_options — each a string[]).
// Registrants pick from those lists per attendee. This helper validates the
// per-attendee selections submitted at booking time against the authoritative
// option lists so only admin-defined values are ever persisted.

const SEVERITIES = new Set(['mild', 'moderate', 'severe']);

/**
 * Tenant-wide toggle (Event Settings -> "Collect dietary & accessibility
 * needs", system_settings key `collect_attendee_options`, default enabled).
 * When disabled, booking paths must not persist any attendee option
 * selections even if the client submits them (defense in depth against
 * stale/crafted payloads).
 *
 * Fail-open to enabled on lookup errors so bookings never break.
 *
 * @param {object} supabase - a supabase client
 * @param {string|null} tenantId
 * @returns {Promise<boolean>}
 */
export async function isAttendeeOptionsCollectionEnabled(supabase, tenantId) {
  if (!tenantId) return true;
  try {
    const { data } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'collect_attendee_options')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    return data?.setting_value !== 'false';
  } catch {
    return true;
  }
}

// Sanitized "no selections" shape used when collection is disabled.
export const EMPTY_OPTION_SELECTIONS = Object.freeze({
  dietary_selections: null,
  allergy_selections: null,
  accessibility_selections: null,
});

const asArray = (v) => (Array.isArray(v) ? v : []);

/**
 * Validate a single attendee's option selections against the event's
 * admin-defined option lists.
 *
 * @param {object} attendee - the attendee object from the booking payload.
 *   May carry dietary_selections (string[]), accessibility_selections
 *   (string[]) and allergy_selections ([{name, severity}] or string[]).
 * @param {object} eventOptions - the event/complex_event row carrying
 *   dietary_options / allergy_options / accessibility_options.
 * @returns {{dietary_selections: (string[]|null), allergy_selections: (object[]|null), accessibility_selections: (string[]|null)}}
 */
export function sanitizeOptionSelections(attendee, eventOptions) {
  const opts = eventOptions || {};
  const dietaryAllowed = asArray(opts.dietary_options);
  const allergyAllowed = asArray(opts.allergy_options);
  const accessibilityAllowed = asArray(opts.accessibility_options);

  const dietary = asArray(attendee?.dietary_selections).filter(
    (v) => typeof v === 'string' && dietaryAllowed.includes(v)
  );

  const accessibility = asArray(attendee?.accessibility_selections).filter(
    (v) => typeof v === 'string' && accessibilityAllowed.includes(v)
  );

  const seen = new Set();
  const allergies = [];
  for (const entry of asArray(attendee?.allergy_selections)) {
    const name = typeof entry === 'string' ? entry : entry?.name;
    if (!name || typeof name !== 'string') continue;
    if (!allergyAllowed.includes(name) || seen.has(name)) continue;
    let severity =
      typeof entry === 'object' && entry?.severity
        ? String(entry.severity).toLowerCase()
        : 'mild';
    if (!SEVERITIES.has(severity)) severity = 'mild';
    seen.add(name);
    allergies.push({ name, severity });
  }

  return {
    dietary_selections: dietary.length ? dietary : null,
    allergy_selections: allergies.length ? allergies : null,
    accessibility_selections: accessibility.length ? accessibility : null,
  };
}
