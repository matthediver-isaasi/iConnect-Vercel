import {
  fetchOrgDisplaySettings,
  isVisibleInDirectory, enrichField, sortFieldsForDirectory,
  publicDirectoryBackOrder,
} from './directoryConfig.js';
import { readDirectoryPages, projectDirectoryInclusion } from './directoryExpression.js';
import { projectOrganisationCoreValues } from '../../shared/organisationDirectoryCore.js';

// Called only after carousel eligibility has admitted the selected ID. The
// caller compares two complete projections and revalidates authority before
// returning either. This endpoint always uses the guest-safe dialog contract.
export async function loadCarouselDetails(db, tenantId, directory, recordId, memberSettings) {
  const organization = directory.entity_type === 'organization';
  const table = organization ? 'organization' : 'member';
  const columns = organization
    ? 'id,name,logo_url,website_url,phone,description'
    : 'id,first_name,last_name,profile_photo_url,job_title,role_id,linkedin_url,organization_id';
  const { data: rows, error } = await db.from(table).select(columns)
    .eq('tenant_id', tenantId).eq('id', recordId).limit(1);
  if (error || !Array.isArray(rows)) throw new Error('Unable to read directory details');
  if (!rows.length) return null;
  const row = rows[0];
  const settings = organization
    ? await fetchOrgDisplaySettings(db, tenantId)
    : memberSettings;
  if (!settings) throw new Error('Directory display settings unavailable');
  const fieldRows = await readDirectoryPages(() => db.from('preference_field').select('*')
    .eq('tenant_id', tenantId).eq('entity_scope', organization ? 'organization' : 'member')
    .eq('is_active', true).order('display_order').order('id'));
  const fields = sortFieldsForDirectory(fieldRows.filter(field => isVisibleInDirectory(field, directory.id))
    .map(field => enrichField(field, directory.id)));
  const allowedFields = new Set(fields.map(field => field.id));
  const idColumn = organization ? 'organization_id' : 'member_id';
  const values = allowedFields.size ? await readDirectoryPages(() => db
    .from(organization ? 'organization_preference_value' : 'member_preference_value')
    .select(`${idColumn},field_id,value`).eq(idColumn, recordId).order('id')) : [];
  const customValues = Object.fromEntries(values.filter(value => allowedFields.has(value.field_id))
    .map(value => [value.field_id, value.value]));
  const projectedDirectory = projectDirectoryInclusion(directory);
  const safeDirectory = Object.fromEntries([
    'id', 'slug', 'name', 'entity_type', 'custom_fields_label', 'back_field_order',
    'show_members_on_card_back', 'core_field_visibility', 'inclusion_revision',
  ].filter(key => projectedDirectory[key] !== undefined).map(key => [key, projectedDirectory[key]]));
  safeDirectory.back_field_order = publicDirectoryBackOrder(safeDirectory.back_field_order);
  if (organization) {
    settings.backFieldOrder = publicDirectoryBackOrder(settings.backFieldOrder);
    return {
      entityType: 'organization',
      record: {
        id: row.id, name: row.name,
        ...(settings.showLogo ? { logo_url: row.logo_url } : {}),
        ...projectOrganisationCoreValues(row, settings.corePublication, directory.core_field_visibility),
        customValues,
      },
      config: { directory: safeDirectory, displaySettings: settings, orgCustomFields: fields },
    };
  }
  const visible = key => {
    const value = settings[key];
    return typeof value === 'object' && value !== null ? value.back !== false : value !== false;
  };
  let organizationName = null;
  if (row.organization_id && visible('show_organization')) {
    const result = await db.from('organization').select('id,name').eq('tenant_id', tenantId)
      .eq('id', row.organization_id).limit(1);
    if (result.error) throw new Error('Unable to read directory organization');
    organizationName = result.data?.[0]?.name || null;
  }
  const roleResult = await db.from('role').select('id,name,badge_background_colour,badge_text_colour')
    .eq('tenant_id', tenantId);
  if (roleResult.error) throw new Error('Directory roles unavailable');
  return {
    entityType: 'member',
    record: {
      id: row.id, first_name: row.first_name, last_name: row.last_name, role_id: row.role_id,
      profile_photo_url: visible('show_profile_photo') ? row.profile_photo_url : null,
      job_title: visible('show_job_title') ? row.job_title : null,
      linkedin_url: visible('show_linkedin') ? row.linkedin_url : null,
      organization_name: organizationName, customValues,
    },
    config: { directory: safeDirectory, displaySettings: settings,
      directoryCustomFields: fields, roles: roleResult.data || [] },
  };
}
