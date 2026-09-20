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
  joinAction: {
    key: 'org_directory_guest_join_action_id',
    description: 'Public header navigation action used for the organisation directory Join button (blank = automatic)',
  },
});

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
  joinActionId,
}) {
  const values = {
    heading: String(heading || '').trim() || ORGANISATION_DIRECTORY_GUEST_DEFAULTS.heading,
    description: String(description || '').trim() || ORGANISATION_DIRECTORY_GUEST_DEFAULTS.description,
    joinAction: String(joinActionId || ''),
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
    existingSettings.joinAction,
    SETTING_DEFINITIONS.joinAction,
    values.joinAction
  );
}