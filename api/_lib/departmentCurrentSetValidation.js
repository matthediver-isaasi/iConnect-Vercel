import { isRepeatableValueEmpty } from '../../shared/formRepeatableRows.js';

/**
 * These callbacks accept only a fresh server-authorized prefill, never a
 * browser-supplied baseline. The transactional version check binds that
 * baseline to the eventual write.
 */
export function departmentCurrentSetValidationOptions(configuration, loaded) {
  const workforceId = configuration.workforce_container_field_id;
  const equipmentId = configuration.equipment_container_field_id;
  const sections = [workforceId, equipmentId];
  const baseline = new Map();
  for (const section of sections) {
    const rows = loaded?.form_values?.[section];
    if (!Array.isArray(rows) || !loaded?.complete_sections?.includes(section)) {
      throw new Error('Current Department validation requires complete authorized source rows');
    }
    baseline.set(section, new Map(rows.map(row => [row._row_id, row])));
  }
  const requiredExceptions = new Set(Object.entries(configuration.equipment_fields)
    .filter(([, key]) => ['serial_number', 'year_installed'].includes(key))
    .map(([fieldId]) => fieldId));
  const workforceChoices = new Set(Object.entries(configuration.workforce_fields)
    .filter(([, key]) => ['staff_group', 'grade'].includes(key))
    .map(([fieldId]) => fieldId));
  return {
    allowRequiredBlank({ child, row, field }) {
      if (field.id !== equipmentId || !requiredExceptions.has(child.id)) return false;
      const original = baseline.get(equipmentId)?.get(row._row_id);
      return !!original && isRepeatableValueEmpty(original[child.id])
        && isRepeatableValueEmpty(row[child.id]);
    },
    isAllowedSpecialSelection({ child, value, row, field }) {
      if (field.id !== workforceId || !workforceChoices.has(child.id)) return false;
      const original = baseline.get(workforceId)?.get(row._row_id);
      return !!original && typeof original[child.id] === 'string'
        && original[child.id] === value;
    },
  };
}