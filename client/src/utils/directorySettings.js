const CORE_FIELDS = [
  { key: 'show_profile_photo', label: 'Profile Photos', description: 'Display member profile photos', backOnly: false },
  { key: 'show_organization', label: 'Organization', description: "Display the member's organization name", backOnly: false },
  { key: 'show_job_title', label: 'Job Title', description: "Display the member's job title", backOnly: false },
  { key: 'show_linkedin', label: 'LinkedIn Profile', description: 'Display LinkedIn profile link if available', backOnly: false },
  { key: 'show_events', label: 'Events Attended', description: 'Display count of events attended', backOnly: false },
  { key: 'show_articles', label: 'Articles Published', description: 'Display count of published articles', backOnly: false },
  { key: 'show_awards', label: 'Awards', description: "Display member's earned awards", backOnly: false },
  { key: 'show_bio_in_popup', label: 'Biography', description: 'Display member biography in the detail view', backOnly: true },
];

export { CORE_FIELDS };

export function normalizeFieldVisibility(value) {
  if (value === undefined || value === null) return { front: true, back: true };
  if (typeof value === 'boolean') return { front: value, back: value };
  if (typeof value === 'object' && value !== null) {
    return {
      front: value.front !== false,
      back: value.back !== false,
    };
  }
  return { front: true, back: true };
}

export function isVisibleOnFront(settings, key) {
  const vis = normalizeFieldVisibility(settings?.[key]);
  return vis.front;
}

export function isVisibleOnBack(settings, key) {
  const vis = normalizeFieldVisibility(settings?.[key]);
  return vis.back;
}

export function isCustomFieldVisibleOnFront(settings, fieldId) {
  const cfSettings = settings?.custom_fields?.[fieldId];
  const vis = normalizeFieldVisibility(cfSettings);
  return vis.front;
}

export function isCustomFieldVisibleOnBack(settings, fieldId) {
  const cfSettings = settings?.custom_fields?.[fieldId];
  const vis = normalizeFieldVisibility(cfSettings);
  return vis.back;
}

export function hasDirectoryFieldValue(field, rawValue) {
  if (rawValue === undefined || rawValue === null) return false;

  if (Array.isArray(rawValue)) {
    return rawValue.length > 0;
  }

  if (typeof rawValue === 'string') {
    if (rawValue.trim() === '') return false;
    if (field?.field_type === 'picklist') {
      try {
        const parsed = JSON.parse(rawValue);
        if (Array.isArray(parsed)) return parsed.length > 0;
      } catch {
        // Not JSON; non-empty string is a value
      }
    }
    return true;
  }

  return true;
}

export function getOrderedCustomFields(fields, settings) {
  const fieldOrder = settings?.field_order;
  if (!fieldOrder || !Array.isArray(fieldOrder) || fieldOrder.length === 0) {
    return fields;
  }
  const customOrder = fieldOrder
    .filter(k => k.startsWith('custom:'))
    .map(k => k.replace('custom:', ''));

  const fieldMap = new Map(fields.map(f => [f.id, f]));
  const ordered = [];
  for (const id of customOrder) {
    const field = fieldMap.get(id);
    if (field) {
      ordered.push(field);
      fieldMap.delete(id);
    }
  }
  for (const field of fieldMap.values()) {
    ordered.push(field);
  }
  return ordered;
}
