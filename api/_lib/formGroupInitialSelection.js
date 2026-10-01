import {
  isRepeatableRowField,
  repeatableRowChildren,
} from '../../shared/formRepeatableRows.js';
import {
  loadTenantOrganisationGroups,
  ORGANISATION_GROUP_DROPDOWN_TYPE,
} from './formOrganisationGroups.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODES = new Set(['none', 'specific', 'url']);
const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/**
 * Initial selections are authoring hints, not answer authorization. URL mode
 * always uses the runtime's fixed group_id parameter; no URL key or value is
 * accepted in the saved configuration.
 */
export async function validateFormGroupInitialSelection({ db, tenantId, form }) {
  const errors = [];
  const selections = [];
  function visit(fields, path = 'fields') {
    for (const [index, field] of fields.entries()) {
      if (!field || typeof field !== 'object') continue;
      const fieldPath = `${path}[${index}]`;
      if (owns(field, 'group_initial_selection')) {
        const configPath = `${fieldPath}.group_initial_selection`;
        const config = field.group_initial_selection;
        if (field.type !== ORGANISATION_GROUP_DROPDOWN_TYPE) {
          errors.push(`${configPath} is only supported on organisation group dropdown fields.`);
        } else if (!config || typeof config !== 'object' || Array.isArray(config)) {
          errors.push(`${configPath} must be an object.`);
        } else if (!MODES.has(config.mode)) {
          errors.push(`${configPath}.mode must be none, specific, or url.`);
        } else {
          const allowedKeys = config.mode === 'specific' ? ['mode', 'group_id'] : ['mode'];
          if (Object.keys(config).some(key => !allowedKeys.includes(key))) {
            errors.push(`${configPath} only supports mode and, in specific mode, group_id. URL mode uses the fixed group_id parameter.`);
          }
          if (config.mode === 'specific') {
            if (typeof config.group_id !== 'string' || !UUID_PATTERN.test(config.group_id)) {
              errors.push(`${configPath}.group_id must be a UUID in specific mode.`);
            } else {
              selections.push({ id: config.group_id.toLowerCase(), path: configPath });
            }
          }
        }
      }
      if (isRepeatableRowField(field)) {
        visit(repeatableRowChildren(field), `${fieldPath}.children`);
      }
    }
  }
  visit(Array.isArray(form?.fields) ? form.fields : []);

  const invalid = () => ({
    ok: false,
    code: 'INVALID_GROUP_INITIAL_SELECTION',
    error: errors[0],
    details: errors,
  });
  if (errors.length) return invalid();
  if (!selections.length) return { ok: true };
  if (!db || !tenantId) {
    throw new Error('Tenant context is required to validate initial organisation group selections.');
  }

  let groups;
  try {
    groups = await loadTenantOrganisationGroups(
      db, tenantId, [...new Set(selections.map(selection => selection.id))],
    );
  } catch (error) {
    throw new Error(`Failed to validate initial organisation group selections: ${error.message}`);
  }
  const allowed = new Set(groups.map(group => String(group.id).toLowerCase()));
  for (const selection of selections) {
    if (!allowed.has(selection.id)) {
      errors.push(`${selection.path}.group_id must reference an organisation group in this tenant.`);
    }
  }
  return errors.length ? invalid() : { ok: true };
}