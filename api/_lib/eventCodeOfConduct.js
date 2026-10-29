export const EVENT_CODE_OF_CONDUCT_KEY = 'event_code_of_conduct';

function fail(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code });
}

/** Check tenant-owned policy before reservations, credit holds or payment calls. */
export async function assertEventCodeOfConduct(db, tenantId, body = {}) {
  if (!tenantId) throw fail('Unable to identify the event tenant.', 404, 'EVENT_TENANT_REQUIRED');
  const {data, error} = await db.from('system_settings').select('setting_value')
    .eq('tenant_id', tenantId).eq('setting_key', EVENT_CODE_OF_CONDUCT_KEY).limit(2);
  if (error || !Array.isArray(data) || data.length > 1) {
    throw fail('The Code of Conduct could not be checked. Please try again.', 503, 'CODE_OF_CONDUCT_UNAVAILABLE');
  }
  if (!data.length) return;
  let policy;
  try {
    policy = typeof data[0].setting_value === 'string'
      ? JSON.parse(data[0].setting_value) : data[0].setting_value;
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)
      || typeof policy.required !== 'boolean' || typeof policy.content !== 'string') throw new Error();
  } catch {
    throw fail('The Code of Conduct settings need attention. Please contact the event organiser.', 503, 'CODE_OF_CONDUCT_UNAVAILABLE');
  }
  if (!policy.required) return;
  const text = policy.content.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]*>/g, '').replace(/&(?:nbsp|#160|#x0*a0|#8203|#x200b);/gi, ' ')
    .replace(/[\s\u200b-\u200d\ufeff]/g, '');
  if (!text) throw fail('The event organiser needs to provide the Code of Conduct before bookings can continue.', 503, 'CODE_OF_CONDUCT_UNAVAILABLE');
  if (body.code_of_conduct_accepted !== true) {
    throw fail('Please accept the Code of Conduct before continuing.', 400, 'CODE_OF_CONDUCT_REQUIRED');
  }
  if (body.code_of_conduct_content !== policy.content) {
    throw fail('The Code of Conduct has changed. Refresh the page, review it and accept it again.', 409, 'CODE_OF_CONDUCT_CHANGED');
  }
}
