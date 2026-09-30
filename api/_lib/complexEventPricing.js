import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

function getSupabase() {
  if (!supabaseUrl || !supabaseServiceKey) return null;
  return createClient(supabaseUrl, supabaseServiceKey);
}

export function parsePricingConfig(pricingConfig) {
  if (!pricingConfig) return null;
  let parsed = pricingConfig;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  return parsed;
}

export function resolveTicketPrice(pricingConfigOrTicketClasses, ticketClassId) {
  let ticketClasses;
  if (Array.isArray(pricingConfigOrTicketClasses)) {
    ticketClasses = pricingConfigOrTicketClasses;
  } else {
    const parsed = parsePricingConfig(pricingConfigOrTicketClasses);
    ticketClasses = parsed?.ticket_classes || [];
  }

  if (!ticketClasses.length || !ticketClassId) {
    return { price: 0, name: 'Free', currency: 'gbp', found: false };
  }

  const tc = ticketClasses.find(t => String(t.id) === String(ticketClassId));
  if (!tc) {
    return { price: 0, name: null, currency: 'gbp', found: false };
  }

  if (tc.is_free) {
    return { price: 0, name: tc.name || 'Ticket', currency: tc.currency || 'gbp', found: true };
  }

  let price = Number(tc.price) || 0;
  const now = new Date();
  if (tc.early_bird_enabled && tc.early_bird_price != null && tc.early_bird_deadline) {
    const deadline = new Date(tc.early_bird_deadline);
    if (deadline > now && Number(tc.early_bird_price) > 0) {
      price = Number(tc.early_bird_price);
    }
  }

  return { price, name: tc.name || 'Ticket', currency: tc.currency || 'gbp', found: true };
}

export function isTicketVisibleToUser(ticketClass, isMember) {
  const vis = ticketClass.visibility_mode || 'members_only';
  if (!isMember) {
    return vis === 'members_and_public' || vis === 'public_only';
  }
  if (vis === 'public_only') return false;
  return true;
}

export function getTicketClassFromConfig(pricingConfigOrTicketClasses, ticketClassId) {
  let ticketClasses;
  if (Array.isArray(pricingConfigOrTicketClasses)) {
    ticketClasses = pricingConfigOrTicketClasses;
  } else {
    const parsed = parsePricingConfig(pricingConfigOrTicketClasses);
    ticketClasses = parsed?.ticket_classes || [];
  }
  if (!ticketClasses.length || !ticketClassId) return null;
  return ticketClasses.find(t => String(t.id) === String(ticketClassId)) || null;
}

export async function validateDiscountCode({ code, tenantId, eventId, memberId, memberRoleId, orgId, ticketClassId }) {
  const supabase = getSupabase();
  if (!supabase || !code) return { valid: false, reason: 'No discount code provided' };

  const { data: discountCode, error } = await supabase
    .from('discount_code')
    .select('*')
    .ilike('code', code.trim())
    .eq('is_active', true)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (error || !discountCode) {
    return { valid: false, reason: 'Invalid or inactive discount code' };
  }

  if (discountCode.expires_at && new Date(discountCode.expires_at) < new Date()) {
    return { valid: false, reason: 'Discount code has expired' };
  }

  if (discountCode.event_id && discountCode.event_id !== eventId) {
    return { valid: false, reason: 'Discount code is not valid for this event' };
  }

  if (discountCode.ticket_class_id && discountCode.ticket_class_id !== ticketClassId) {
    return { valid: false, reason: 'This discount code is not valid for your selected ticket' };
  }

  const isMemberTargeted = discountCode.member_id || discountCode.role_id || discountCode.member_group_id;

  if (!isMemberTargeted && discountCode.max_usage_count && discountCode.current_usage_count >= discountCode.max_usage_count) {
    return { valid: false, reason: 'Discount code has reached maximum uses' };
  }

  if (discountCode.organization_id && discountCode.organization_id !== orgId) {
    return { valid: false, reason: 'Discount code is not valid for your organization' };
  }

  if (discountCode.member_id) {
    if (!memberId || discountCode.member_id !== memberId) {
      return { valid: false, reason: 'Discount code is not valid for your account' };
    }
  }

  if (discountCode.role_id) {
    if (!memberRoleId || memberRoleId !== discountCode.role_id) {
      return { valid: false, reason: 'Discount code is not valid for your role' };
    }
  }

  if (discountCode.member_group_id && memberId) {
    const { data: grpAssignment } = await supabase
      .from('member_group_assignment')
      .select('id')
      .eq('member_id', memberId)
      .eq('group_id', discountCode.member_group_id)
      .maybeSingle();
    if (!grpAssignment) {
      return { valid: false, reason: 'Discount code is not valid for your group' };
    }
  }

  if (isMemberTargeted && memberId && discountCode.max_usage_count) {
    const { data: perMemberUsage } = await supabase
      .from('discount_code_usage')
      .select('usage_count')
      .eq('discount_code_id', discountCode.id)
      .eq('member_id', memberId)
      .maybeSingle();
    if (perMemberUsage && perMemberUsage.usage_count >= discountCode.max_usage_count) {
      return { valid: false, reason: 'You have reached the maximum uses for this discount code' };
    }
  }

  return { valid: true, discountCode };
}

export function computeDiscountedPrice(basePrice, discountCode) {
  if (!discountCode || basePrice <= 0) return basePrice;

  let discountAmount = 0;
  if (discountCode.type === 'percentage') {
    discountAmount = (basePrice * discountCode.value) / 100;
  } else {
    discountAmount = discountCode.value;
  }

  return Math.max(0, basePrice - Math.min(discountAmount, basePrice));
}

export async function recordDiscountCodeUsage({ discountCodeRecord, tenantId, orgId, memberId }) {
  const supabase = getSupabase();
  if (!supabase || !discountCodeRecord) return;

  const isMemberTargeted = discountCodeRecord.member_id || discountCodeRecord.role_id || discountCodeRecord.member_group_id;

  if (!isMemberTargeted) {
    await supabase
      .from('discount_code')
      .update({ current_usage_count: (discountCodeRecord.current_usage_count || 0) + 1 })
      .eq('id', discountCodeRecord.id)
      .eq('tenant_id', tenantId);
  }

  if (orgId) {
    const { data: existingUsage } = await supabase
      .from('discount_code_usage')
      .select('id, usage_count')
      .eq('discount_code_id', discountCodeRecord.id)
      .eq('organization_id', orgId)
      .is('member_id', null)
      .maybeSingle();

    if (existingUsage) {
      await supabase
        .from('discount_code_usage')
        .update({ usage_count: (existingUsage.usage_count || 0) + 1 })
        .eq('id', existingUsage.id);
    } else {
      await supabase
        .from('discount_code_usage')
        .insert({
          discount_code_id: discountCodeRecord.id,
          organization_id: orgId,
          usage_count: 1,
          tenant_id: tenantId
        });
    }
  }

  if (isMemberTargeted && memberId) {
    const { data: existingMemberUsage } = await supabase
      .from('discount_code_usage')
      .select('id, usage_count')
      .eq('discount_code_id', discountCodeRecord.id)
      .eq('member_id', memberId)
      .maybeSingle();

    if (existingMemberUsage) {
      await supabase
        .from('discount_code_usage')
        .update({ usage_count: (existingMemberUsage.usage_count || 0) + 1 })
        .eq('id', existingMemberUsage.id);
    } else {
      await supabase
        .from('discount_code_usage')
        .insert({
          discount_code_id: discountCodeRecord.id,
          member_id: memberId,
          usage_count: 1,
          tenant_id: tenantId
        });
    }
  }
}
