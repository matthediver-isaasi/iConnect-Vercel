export const ORGANISATION_DIRECTORY_GUEST_DEFAULTS = Object.freeze({
  heading: 'Organisation Directory',
  description: 'Sign in to view the organisation directory.',
});

const SETTING_DEFINITIONS = Object.freeze({
  heading: {
    key: 'org_directory_guest_heading',
    description: 'Heading shown to signed-out visitors on the organisation directory',
  },
  description: {
    key: 'org_directory_guest_description',
    description: 'Description shown to signed-out visitors on the organisation directory',
  },
  joinLink: {
    key: 'org_directory_guest_join_link',
    description: 'Link shown to signed-out visitors on the organisation directory (blank = hidden)',
  },
});

export function normalizeOrganisationDirectoryGuestLink(value) {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/[\u0000-\u001f\u007f\\]/.test(trimmed) || /%(?![0-9a-f]{2})/i.test(trimmed)) {
    return null;
  }

  if (trimmed.startsWith('/')) {
    if (trimmed.startsWith('//')) return null;
    try {
      new URL(trimmed, 'https://example.invalid');
      return trimmed;
    } catch {
      return null;
    }
  }

  if (!/^https?:\/\/[^/?#\s]/i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return null;
    if (parsed.username || parsed.password) return null;
    return trimmed;
  } catch {
    return null;
  }
}

async function saveSetting(entity, row, definition, settingValue) {
  if (row) {
    await entity.update(row.id, { setting_value: settingValue });
    return;
  }
  await entity.create({
    setting_key: definition.key,
    setting_value: settingValue,
    description: definition.description,
  });
}

export async function saveOrganisationDirectoryGuestSettings({
  entity,
  existingSettings,
  heading,
  description,
  joinLink,
}) {
  const normalizedJoinLink = normalizeOrganisationDirectoryGuestLink(joinLink);
  if (normalizedJoinLink === null) {
    throw new Error('Join link must be a root-relative path or an http(s) URL');
  }

  const values = {
    heading: String(heading || '').trim() || ORGANISATION_DIRECTORY_GUEST_DEFAULTS.heading,
    description: String(description || '').trim() || ORGANISATION_DIRECTORY_GUEST_DEFAULTS.description,
    joinLink: normalizedJoinLink,
  };

  await saveSetting(entity, existingSettings.heading, SETTING_DEFINITIONS.heading, values.heading);
  await saveSetting(
    entity,
    existingSettings.description,
    SETTING_DEFINITIONS.description,
    values.description
  );
  await saveSetting(
    entity,
    existingSettings.joinLink,
    SETTING_DEFINITIONS.joinLink,
    values.joinLink
  );
}