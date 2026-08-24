// Member group role name standardisation helpers.
//
// Roles are free-form strings on member_group.roles, so the same role can be
// typed with different capitalisation. These helpers keep new entries aligned
// with existing spellings (case-insensitively) and default genuinely new names
// to Title Case. The toTitleCase implementation mirrors
// scripts/normalize-member-group-roles.mjs — keep them in sync.

// Collapse repeated whitespace + trim; used as the case-insensitive match key.
export function roleNameKey(name) {
  return (name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Title Case: capitalise the first letter of each word, preserving all-caps
// words (acronyms like "PR", "CEO") and any interior capitalisation.
export function toTitleCase(name) {
  const trimmed = (name || '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  return trimmed
    .split(' ')
    .map((word) => {
      if (!word) return word;
      if (word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word)) return word;
      return word[0].toUpperCase() + word.slice(1);
    })
    .join(' ');
}

// Resolve the spelling a newly entered role should be saved as:
//   1. an existing name (from `existingNames`) that matches case-insensitively
//      keeps its current spelling, so metadata/assignments stay attached;
//   2. otherwise the input is Title Cased.
export function canonicalizeRoleName(input, existingNames = []) {
  const key = roleNameKey(input);
  if (!key) return '';
  for (const name of existingNames) {
    if (roleNameKey(name) === key) return name;
  }
  return toTitleCase(input);
}

// Emptiness predicates for the three role-keyed metadata maps. "Empty" values
// must never win a merge over a value that carries real content.
export function isEmptyRoleHtml(value) {
  const raw = (value == null ? '' : String(value)).trim();
  if (!raw) return true;
  return raw.replace(/<[^>]*>/g, '').replace(/&nbsp;|\u00A0/g, ' ').trim().length === 0;
}

export function isEmptyRoleUrl(value) {
  return !(value != null && String(value).trim());
}

export function isEmptyRoleTermDef(def) {
  if (!def || typeof def !== 'object') return true;
  const value = Number(def.term_value);
  const maxTerms = Number(def.max_terms);
  return !((Number.isFinite(value) && value > 0) || (Number.isFinite(maxTerms) && maxTerms > 0));
}

// Re-key a role-keyed metadata map so every key becomes its canonical
// spelling. When two case-variant keys collapse onto one canonical role:
//   1. a non-empty entry always beats an empty one (no metadata loss);
//   2. if both are non-empty (or both empty), the entry whose ORIGINAL key is
//      the preferred variant for that lowercase key wins;
//   3. otherwise first-seen wins (stable/deterministic).
// `canonicalByKey` / `preferredVariantByKey` are Maps keyed by roleNameKey().
// Keys with no canonical mapping are kept as-is.
export function remapRoleKeyedMap(obj, canonicalByKey, preferredVariantByKey, isEmpty) {
  const src = obj && typeof obj === 'object' ? obj : {};
  const out = {};
  for (const [key, val] of Object.entries(src)) {
    const k = roleNameKey(key);
    const canonical = canonicalByKey.get(k) || key;
    if (!Object.prototype.hasOwnProperty.call(out, canonical)) {
      out[canonical] = val;
      continue;
    }
    const existingEmpty = isEmpty(out[canonical]);
    const newEmpty = isEmpty(val);
    if (existingEmpty && !newEmpty) {
      out[canonical] = val;
      continue;
    }
    if (!existingEmpty && newEmpty) continue;
    const preferred = preferredVariantByKey ? preferredVariantByKey.get(k) : undefined;
    if (preferred !== undefined && key === preferred) out[canonical] = val;
  }
  return out;
}

// Deduplicated, sorted list of role names used across all of a tenant's
// groups. First-seen spelling wins per case-insensitive key.
export function collectTenantRoleNames(groups = []) {
  const byKey = new Map();
  for (const g of groups) {
    for (const r of g?.roles || []) {
      const key = roleNameKey(r);
      if (key && !byKey.has(key)) byKey.set(key, r.trim().replace(/\s+/g, ' '));
    }
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}

// Keep a form access policy's member-group role references aligned with the
// roles that actually survive a group save. Matching is case-insensitive (and
// whitespace-normalised), while values are always rewritten to the surviving
// role's canonical spelling. References with no surviving role are deliberately
// retained so the server treats the policy as stale and denies access safely;
// silently dropping the last role would broaden the rule to any group member.
//
// The rest of the policy and all rules for other groups are left untouched.
// Malformed/non-array role_names are left alone rather than manufacturing role
// restrictions.
export function remapGroupRolePolicy(accessPolicy, groupId, survivingRoleNames = []) {
  if (!accessPolicy || typeof accessPolicy !== 'object' || Array.isArray(accessPolicy)) {
    return accessPolicy;
  }
  if (!Array.isArray(accessPolicy.group_rules)) return accessPolicy;

  const canonicalByKey = new Map();
  for (const roleName of Array.isArray(survivingRoleNames) ? survivingRoleNames : []) {
    if (typeof roleName !== 'string') continue;
    const key = roleNameKey(roleName);
    if (key && !canonicalByKey.has(key)) {
      canonicalByKey.set(key, String(roleName).trim().replace(/\s+/g, ' '));
    }
  }

  let changed = false;
  const groupRules = accessPolicy.group_rules.map((rule) => {
    if (!rule || typeof rule !== 'object' || String(rule.group_id || '') !== String(groupId || '')) {
      return rule;
    }

    if (!Array.isArray(rule.role_names)) return rule;
    const nextRoleNames = [];
    const seen = new Set();
    for (const roleName of rule.role_names) {
      if (typeof roleName !== 'string') continue;
      const canonical = canonicalByKey.get(roleNameKey(roleName))
        || String(roleName).trim().replace(/\s+/g, ' ');
      const key = roleNameKey(canonical);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      nextRoleNames.push(canonical);
    }

    if (JSON.stringify(nextRoleNames) === JSON.stringify(rule.role_names || [])) return rule;
    changed = true;
    return { ...rule, role_names: nextRoleNames };
  });

  return changed ? { ...accessPolicy, group_rules: groupRules } : accessPolicy;
}
