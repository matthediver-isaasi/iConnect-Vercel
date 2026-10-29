import { isProvisionableRole } from "@/utils/publicTicketMembers";

export function normalizeRegistrationAssociationConfig(value) {
  let config = value;
  if (typeof config === "string") {
    try { config = JSON.parse(config); } catch { config = null; }
  }
  const scope = key => ({
    enabled: config?.[key]?.enabled === true,
    field_id: config?.[key]?.field_id || null,
    value: String(config?.[key]?.value ?? ""),
  });
  return { organizations: scope("organizations"), groups: scope("groups"), role_id: config?.role_id || null };
}

export function validateRegistrationAssociationConfig(value, roles = []) {
  const config = normalizeRegistrationAssociationConfig(value);
  if (!config.organizations.enabled && !config.groups.enabled) return [];
  const errors = [];
  if (!roles.some(role => String(role.id) === String(config.role_id) && isProvisionableRole(role))) {
    errors.push("Select an eligible role for registration organisations and groups.");
  }
  for (const [key, label] of [["organizations", "organisations"], ["groups", "organisation groups"]]) {
    if (config[key].enabled && config[key].field_id && !config[key].value.trim()) {
      errors.push(`Enter a custom field filter value for ${label}, or choose all records.`);
    }
  }
  return errors;
}
