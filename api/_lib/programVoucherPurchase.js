import { createHash } from 'node:crypto';
import { loadBookingVouchers, calculateComplexEventCreditQuote, assertCreditRoleAllowed } from './complexEventCreditQuote.js';

export function programPurchasePrice(program, quantity) {
  const qty = Number(quantity);
  if (!Number.isSafeInteger(qty) || qty < 1 || qty > 10000) throw new Error('Invalid ticket quantity');
  let payable = qty, tickets = qty;
  const offer = program.offer_type || (program.bogo_buy_quantity && program.bogo_get_free_quantity
    ? 'bogo' : program.bulk_discount_threshold && program.bulk_discount_percentage ? 'bulk_discount' : 'none');
  const buy = Number(program.bogo_buy_quantity), free = Number(program.bogo_get_free_quantity);
  if (offer === 'bogo' && buy > 0 && free > 0) {
    if (program.bogo_logic_type === 'enter_total_pay_less') payable -= Math.floor(qty / (buy + free)) * free;
    else tickets += Math.floor(qty / buy) * free;
  }
  let pounds = Number(program.program_ticket_price) * payable;
  if (offer === 'bulk_discount' && qty >= Number(program.bulk_discount_threshold)) {
    pounds *= 1 - Math.min(100, Math.max(0, Number(program.bulk_discount_percentage) || 0)) / 100;
  }
  const totalMinor = Math.round(pounds * 100);
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 0) throw new Error('Invalid programme price');
  return { totalMinor, tickets };
}

export async function quoteProgramPurchase(db, { tenantId, memberId, params }) {
  if (!tenantId || !memberId) throw new Error('Sign in to purchase programme tickets');
  const memberResult = await db.from('member').select('*').eq('tenant_id', tenantId).eq('id', memberId).single();
  if (memberResult.error || !memberResult.data) throw new Error('Purchasing member unavailable');
  const member = memberResult.data;
  let organization = null;
  if (member.organization_id) {
    const orgResult = await db.from('organization').select('*').eq('tenant_id', tenantId)
      .eq('id', member.organization_id).single();
    if (orgResult.error || !orgResult.data) throw new Error('Purchasing organization unavailable');
    organization = orgResult.data;
  }
  let programQuery = db.from('program').select('*').eq('tenant_id', tenantId);
  programQuery = params.programId ? programQuery.eq('id', params.programId) : programQuery.eq('name', params.programName);
  const programResult = await programQuery.single();
  if (programResult.error || !programResult.data || programResult.data.is_active === false) throw new Error('Programme unavailable');
  const program = programResult.data;
  const price = programPurchasePrice(program, params.quantity);
  let discountMinor = 0;
  if (params.appliedDiscountId) {
    const { data: discount, error } = await db.from('discount_code').select('*')
      .eq('tenant_id', tenantId).eq('id', params.appliedDiscountId).single();
    if (error || !discount || !discount.is_active
      || (discount.expires_at && Date.parse(discount.expires_at) <= Date.now())
      || (discount.program_tag && discount.program_tag !== program.program_tag)
      || discount.event_id || discount.ticket_class_id
       || (discount.organization_id && discount.organization_id !== organization?.id)
      || (discount.member_id && discount.member_id !== member.id)
      || (discount.role_id && discount.role_id !== member.role_id)
      || Number(discount.min_purchase_amount || 0) * 100 > price.totalMinor) throw new Error('Discount is not eligible');
    if (discount.member_group_id) {
      const group = await db.from('member_group_assignment').select('id')
        .eq('member_id', member.id).eq('group_id', discount.member_group_id).maybeSingle();
      if (group.error || !group.data) throw new Error('Discount is not eligible');
    }
    let usageCount = Number(discount.current_usage_count || 0);
    if (discount.organization_id || discount.member_id || discount.role_id || discount.member_group_id) {
      let usageQuery = db.from('discount_code_usage').select('usage_count').eq('discount_code_id', discount.id);
      usageQuery = discount.organization_id
        ? usageQuery.eq('organization_id', organization.id)
        : usageQuery.eq('member_id', member.id);
      const usage = await usageQuery.maybeSingle();
      if (usage.error) throw new Error('Unable to verify discount usage');
      usageCount = Number(usage.data?.usage_count || 0);
    }
    if (discount.max_usage_count && usageCount >= discount.max_usage_count) throw new Error('Discount usage limit reached');
    discountMinor = Math.min(price.totalMinor, Math.max(0, Math.round(
      discount.type === 'percentage' ? price.totalMinor * Number(discount.value) / 100 : Number(discount.value) * 100)));
  }
  const trainingFundAmount = Number(params.trainingFundAmount || 0);
  if (trainingFundAmount > 0 && !organization) throw new Error('Training funds require an organization');
  if (trainingFundAmount > 0) assertCreditRoleAllowed(organization.training_fund_allowed_role_ids, member.role_id, 'the training fund');
  let eventStart = null;
  if (params.selectedVoucherIds?.length) {
    const earliest = await db.from('event').select('start_date').eq('tenant_id', tenantId)
      .eq('program_tag', program.program_tag).gte('start_date', new Date().toISOString())
      .order('start_date', { ascending: true }).limit(1).maybeSingle();
    if (earliest.error) throw new Error('Unable to verify programme credit expiry');
    eventStart = earliest.data?.start_date || null;
  }
  const vouchers = await loadBookingVouchers(db, { tenantId, member, organization,
    voucherIds: params.selectedVoucherIds, eventStart });
  const totalMinor = price.totalMinor - discountMinor;
  const credit = totalMinor > 0 ? calculateComplexEventCreditQuote({
    totalMinor, requestedTrainingFundAmount: trainingFundAmount,
    trainingFundBalance: organization?.training_fund_balance || 0,
    requestedVoucherIds: params.selectedVoucherIds || [], vouchers,
    voucherOrderManual: params.voucherOrderManual,
  }) : { remainingMinor: 0, voucherMinor: 0, trainingFundMinor: 0 };
  const quote = { tenantId, memberId: member.id, organizationId: organization?.id || null,
    programId: program.id, programName: program.name, programTag: program.program_tag,
    quantity: Number(params.quantity), tickets: price.tickets, grossMinor: price.totalMinor,
    totalMinor, discountMinor, discountId: params.appliedDiscountId || null,
    voucherIds: params.selectedVoucherIds || [], manualOrder: params.voucherOrderManual === true,
    ...credit, memberEmail: member.email };
  quote.binding = createHash('sha256').update(JSON.stringify(quote)).digest('hex');
  return quote;
}
