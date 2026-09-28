import { supabase } from './database.js';

const DEFAULT_PERSONA = Object.freeze({ name: 'Dougal', avatarUrl: '', description: '' });
const DEFAULT_OVERRIDES = Object.freeze({
  enabled: true, name: '', avatarUrl: '', description: '', backgroundColor: '',
});

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function safeAvatarUrl(value) {
  if (value === '') return true;
  if (/[\x00-\x20\x7f\\<>]/.test(value)) return false;
  if (value.startsWith('/') && !value.startsWith('//')) return true;
  if (!/^https:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function validateMemberAiAssistant(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('member_ai_assistant must be an object');
  }
  const overrides = {};
  for (const field of Object.keys(DEFAULT_OVERRIDES)) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    const input = value[field];
    if (field === 'enabled') {
      if (typeof input !== 'boolean') throw new Error('member_ai_assistant.enabled must be a boolean');
    } else if (typeof input !== 'string') {
      throw new Error(`member_ai_assistant.${field} must be a string`);
    } else if (field === 'name' && (input.length > 120 || /[\x00-\x1f\x7f]/.test(input))) {
      throw new Error('Invalid member_ai_assistant.name');
    } else if (field === 'description' &&
      (input.length > 500 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(input))) {
      throw new Error('Invalid member_ai_assistant.description');
    } else if (field === 'backgroundColor' && input !== '' && !/^#[0-9a-fA-F]{6}$/.test(input)) {
      throw new Error('member_ai_assistant.backgroundColor must be a six-digit hex colour');
    } else if (field === 'avatarUrl' && !safeAvatarUrl(input)) {
      throw new Error('member_ai_assistant.avatarUrl must be a safe HTTPS or relative URL');
    }
    overrides[field] = field === 'name' || field === 'description' ? input.trim() : input;
  }
  return overrides;
}

export function resolveMemberAiAssistant(tenantId, settings, persona = DEFAULT_PERSONA) {
  const raw = record(record(settings).member_ai_assistant);
  const overrides = { ...DEFAULT_OVERRIDES };
  // Legacy malformed values must never enable the feature or become unsafe URLs.
  for (const field of Object.keys(overrides)) {
    if (!Object.prototype.hasOwnProperty.call(raw, field)) continue;
    try {
      overrides[field] = validateMemberAiAssistant({ [field]: raw[field] })[field];
    } catch {
      // An explicitly malformed enablement value cannot grant access.
      if (field === 'enabled') overrides.enabled = false;
    }
  }
  const platform = record(persona);
  return {
    tenantId,
    enabled: overrides.enabled,
    name: overrides.name || (typeof platform.name === 'string' && platform.name.trim() ? platform.name : DEFAULT_PERSONA.name),
    avatarUrl: overrides.avatarUrl || (typeof platform.avatarUrl === 'string' ? platform.avatarUrl : ''),
    description: overrides.description,
    backgroundColor: overrides.backgroundColor,
    overrides,
  };
}

// Always read the tenant row fresh: disabling an assistant revokes ask and history
// access immediately, including for non-member administrators previewing the portal.
export async function loadTenantAiAssistant(tenantId, db = supabase) {
  if (!db || !tenantId) throw new Error('Tenant settings unavailable');
  const { data: tenant, error } = await db.from('tenant')
    .select('settings').eq('id', tenantId).single();
  if (error || !tenant) throw new Error('Tenant settings unavailable');
  return resolveMemberAiAssistant(tenantId, tenant.settings);
}

export async function loadTenantAiAssistantConfig(tenantId, db = supabase) {
  const config = await loadTenantAiAssistant(tenantId, db);
  const { data, error } = await db.from('platform_preferences')
    .select('value').eq('key', 'ai_help_persona').maybeSingle();
  // The platform persona has a documented default; a missing preference is normal.
  if (error) throw new Error('Assistant persona unavailable');
  const resolved = resolveMemberAiAssistant(tenantId, {
    member_ai_assistant: config.overrides,
  }, data?.value);
  return resolved;
}

export async function requireTenantAiAssistant(tenantId, res, db = supabase) {
  try {
    const config = await loadTenantAiAssistant(tenantId, db);
    if (!config.enabled) {
      res.status(403).json({
        error: 'The AI assistant is disabled for this organisation.',
        code: 'assistant_disabled',
      });
      return false;
    }
    return true;
  } catch (error) {
    console.error('[Member AI] Failed to load tenant settings:', error);
    res.status(503).json({ error: 'Assistant settings are unavailable.' });
    return false;
  }
}