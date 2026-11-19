// Normalize only writable settings; child IDs and ownership always come from the RPC.
export function buildStructureChildren(input, columns = {}) {
  const result = {};
  if (Array.isArray(input.bands)) result.bands = input.bands.map((b, index) => {
    const matched = b.match_value != null && String(b.match_value).trim() !== '';
    const dd = parseFloat(b.dd_monthly_amount);
    return {
      label: b.label || `Tier ${index + 1}`,
      min_value: matched ? null : (b.min_value ?? 0),
      max_value: matched ? null : (b.max_value ?? null),
      annual_cost: b.annual_cost ?? 0, display_order: index,
      ...(columns.vat ? { vat_rate: b.vat_rate || null } : {}),
      ...(columns.match ? { match_value: matched ? String(b.match_value).trim() : null } : {}),
      ...(columns.dd ? { dd_monthly_amount: Number.isFinite(dd) && dd > 0 ? dd : null } : {}),
      ...(columns.nominal ? { nominal_code: typeof b.nominal_code === 'string' ? b.nominal_code.trim() || null : null } : {}),
    };
  });
  for (const key of ['discounts', 'vatOverrides']) {
    if (Array.isArray(input[key])) result[key] = input[key].map((d, index) => ({
      field_id: d.field_id, field_label: d.field_label || null,
      match_value: d.match_value || '', match_condition: d.match_condition || 'equals',
      label: d.label || null, sort_order: index,
      ...(key === 'discounts'
        ? { discount_type: d.discount_type || 'percentage', discount_value: parseFloat(d.discount_value) || 0 }
        : { vat_rate: d.vat_rate || null }),
    }));
  }
  if (Array.isArray(input.reminders)) result.reminders = input.reminders.map((r, index) => ({
    label: r.label || null, offset_value: Math.max(0, parseInt(r.offset_value, 10) || 0),
    offset_unit: r.offset_unit === 'weeks' ? 'weeks' : 'days',
    direction: r.direction === 'after' ? 'after' : 'before',
    email_template_id: r.email_template_id || null,
    recipient_role_ids: Array.isArray(r.recipient_role_ids) ? r.recipient_role_ids : [],
    is_active: r.is_active !== false, sort_order: index,
  }));
  return result;
}
