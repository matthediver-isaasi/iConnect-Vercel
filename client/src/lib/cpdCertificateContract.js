// Keeps the browser editor's friendly field shape aligned with the API's
// persisted placeholder shape. Values are intentionally separate: render
// accepts only a values map and never persists sample data as certificate data.
export function serializeCertificatePlaceholder(field) {
  return {
    placeholder_key: field.key,
    label: field.label || field.key,
    field_type: field.field_type || 'text',
    sample_value: field.sample || '',
    default_value: field.default_value || null,
    display_order: Number(field.display_order || 0),
    multiline: !!field.multiline,
    shrink_to_fit: field.shrink_to_fit !== false,
    page_number: Number(field.page),
    x: Number(field.x),
    y: Number(field.y),
    width: Number(field.width),
    height: Number(field.height),
    font_family: field.font_family,
    font_size: Number(field.font_size),
    font_style: field.font_style === 'italic' && field.font_weight === 'bold' ? 'bolditalic' : field.font_weight === 'bold' ? 'bold' : field.font_style || 'normal',
    alignment: field.align,
    color: field.color,
    line_height: Number(field.line_height || 1.2),
    overflow_policy: field.multiline ? 'wrap' : field.shrink_to_fit ? 'shrink' : 'clip',
    missing_policy: field.required ? 'error' : 'blank',
    format: field.field_type === 'date' ? field.date_format : field.field_type === 'number' ? field.number_format : field.format || null,
    minimum_font_size: Number(field.minimum_font_size || 4),
    vertical_align: field.vertical_align || 'middle',
  };
}

export function certificateSampleValues(fields) {
  return Object.fromEntries((fields || []).map((field) => [field.key, field.sample || '']));
}

export function formatCertificateValue(value, field = {}) {
  if (value === null || value === undefined) return '';
  const format = field.field_type === 'date'
    ? field.date_format || field.format
    : field.field_type === 'number'
      ? field.number_format || field.format
      : field.format;
  if (!format) return String(value);
  if (format === 'uppercase') return String(value).toUpperCase();
  if (format === 'lowercase') return String(value).toLowerCase();
  if (field.field_type === 'date' || format.startsWith('date') || /[DMY]/.test(format)) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const requested = format.split(':')[1];
    if (requested && ['short', 'medium', 'long', 'full'].includes(requested)) {
      return new Intl.DateTimeFormat('en-GB', { dateStyle: requested, timeZone: 'UTC' }).format(date);
    }
    const day = String(date.getUTCDate());
    const month = new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' }).format(date);
    const monthShort = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' }).format(date);
    return format
      .replace(/YYYY/g, String(date.getUTCFullYear()))
      .replace(/MMMM/g, month)
      .replace(/MMM/g, monthShort)
      .replace(/MM/g, String(date.getUTCMonth() + 1).padStart(2, '0'))
      .replace(/DD/g, day.padStart(2, '0'))
      .replace(/\bD\b/g, day);
  }
  if (field.field_type === 'number' || format.startsWith('number') || /[0#]/.test(format)) {
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value);
    const generic = /^number(?::(\d{1,2}))?$/.exec(format);
    const decimals = generic
      ? (generic[1] === undefined ? 20 : Math.min(20, Number(generic[1])))
      : format.includes('.') ? format.split('.')[1].length : 0;
    const requiredDecimals = generic?.[1] === undefined
      ? 0
      : generic ? Math.min(20, Number(generic[1]))
        : format.includes('.') ? (format.split('.')[1].match(/0/g) || []).length : 0;
    return new Intl.NumberFormat('en-GB', {
      minimumFractionDigits: requiredDecimals,
      maximumFractionDigits: Math.min(20, decimals),
      useGrouping: format.includes(',') || format.startsWith('number'),
    }).format(number);
  }
  return String(value);
}

export function certificateTemplateEndpoints(id) {
  const base = `/api/cpd-certificate-templates/${encodeURIComponent(id)}`;
  return {
    item: base,
    source: `${base}/source`,
    duplicate: `${base}/duplicate`,
    lifecycle: `${base}/lifecycle`,
    preview: `${base}/preview`,
    render: `${base}/render`,
  };
}