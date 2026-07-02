export const WALL_OF_FAME_TITLE_FIELD_SETTING_KEY = 'wall_of_fame_title_field';

/**
 * Resolve the "title"/honorific prefix (e.g. "Dr", "Professor") for a set of
 * Wall of Fame people, based on the tenant's `wall_of_fame_title_field` setting.
 *
 * The setting value distinguishes a member core field from a member custom field
 * using a `core:<key>` / `custom:<preference_field_id>` convention. A blank /
 * missing setting means no prefix is applied.
 *
 * Lookups are batched: at most one query against `member` (core) or
 * `member_preference_value` (custom) for the whole set of people.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} tenantId
 * @param {Array<{ id: string, member_id?: string|null }>} people
 * @returns {Promise<Map<string, string>>} Map of person id -> prefix string
 */
export async function resolveWallOfFameTitlePrefixes(supabase, tenantId, people) {
  const result = new Map();

  if (!supabase || !tenantId || !Array.isArray(people) || people.length === 0) {
    return result;
  }

  const { data: settingRow, error: settingError } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('tenant_id', tenantId)
    .eq('setting_key', WALL_OF_FAME_TITLE_FIELD_SETTING_KEY)
    .maybeSingle();

  if (settingError) {
    console.error('[WallOfFame TitlePrefix] Failed to read setting:', settingError);
    return result;
  }

  const raw = (settingRow?.setting_value || '').trim();
  if (!raw) {
    return result;
  }

  const memberIds = [
    ...new Set(people.filter((p) => p && p.member_id).map((p) => p.member_id)),
  ];
  if (memberIds.length === 0) {
    return result;
  }

  const assign = (valueByMemberId) => {
    for (const person of people) {
      if (!person || !person.member_id) continue;
      const value = valueByMemberId.get(person.member_id);
      if (value == null) continue;
      const trimmed = String(value).trim();
      if (trimmed) {
        result.set(person.id, trimmed);
      }
    }
  };

  if (raw.startsWith('core:')) {
    const key = raw.slice('core:'.length);
    // Guard against SQL identifier injection via the select column. Core field
    // keys are simple lowercase snake_case identifiers.
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      return result;
    }

    const { data: members, error } = await supabase
      .from('member')
      .select(`id, ${key}`)
      .eq('tenant_id', tenantId)
      .in('id', memberIds);

    if (error) {
      console.error('[WallOfFame TitlePrefix] Core field lookup failed:', error);
      return result;
    }

    const byMemberId = new Map((members || []).map((m) => [m.id, m[key]]));
    assign(byMemberId);
  } else if (raw.startsWith('custom:')) {
    const fieldId = raw.slice('custom:'.length);
    if (!fieldId) {
      return result;
    }

    const { data: values, error } = await supabase
      .from('member_preference_value')
      .select('member_id, value')
      .eq('field_id', fieldId)
      .in('member_id', memberIds);

    if (error) {
      console.error('[WallOfFame TitlePrefix] Custom field lookup failed:', error);
      return result;
    }

    const byMemberId = new Map((values || []).map((v) => [v.member_id, v.value]));
    assign(byMemberId);
  }

  return result;
}
