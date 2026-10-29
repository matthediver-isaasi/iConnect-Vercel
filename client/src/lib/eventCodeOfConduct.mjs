export const EVENT_CODE_OF_CONDUCT_KEY = 'event_code_of_conduct';

export function parseEventCodeOfConduct(settings) {
  const raw = Array.isArray(settings)
    ? settings.find(row => row.setting_key === EVENT_CODE_OF_CONDUCT_KEY)?.setting_value
    : settings;
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { content: typeof value?.content === 'string' ? value.content : '', required: value?.required === true };
  } catch {
    return { content: '', required: false };
  }
}

export function hasCodeOfConductContent(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (entity, value) => {
      const point = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
      return point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    })
    .replace(/&(?:nbsp|ensp|emsp|thinsp|hairsp|ZeroWidthSpace|zwnj|zwj);/gi, ' ')
    .replace(/[\s\u200b-\u200d\ufeff]/g, '').length > 0;
}

export function codeOfConductScope(eventId, policy) {
  return JSON.stringify([eventId, policy.content, policy.required]);
}

export function codeOfConductPayload(policy, accepted) {
  return accepted ? { code_of_conduct_accepted: true, code_of_conduct_content: policy.content } : {};
}
