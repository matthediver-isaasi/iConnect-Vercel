import { createHash } from 'node:crypto';
import { classify, legacyExpiry } from './audit-bnms-non-dd-cohort.mjs';
export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const AS_OF = '2026-10-19';
export const SOURCE = 'bnms_2027_expiry_gap_correction';
export const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function historyId(id) {
  const h = hash(`${SOURCE}:${id}`);
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
export function assess(source, member, invoices, configs, conflicts) {
  const expiry = legacyExpiry(source.preferences.ym_date_membership_expires);
  if (classify(source) !== 'requires_term_and_invoice_review') return {reason: classify(source)};
  if (!expiry || expiry < '2027-01-01' || expiry > '2027-10-19') return {reason:'outside_2027_current_cohort'};
  if (['Student','Former'].includes(source.preferences.member_class)) return {reason:'student_or_former_excluded'};
  if (member.status !== 'active' || member.membership_paused || member.is_guest || conflicts) return {reason:'access_or_existing_billing_conflict'};
  if (invoices.some(i=>/\bDD\b|direct debit/i.test(i.description || ''))) return {reason:'historical_direct_debit_evidence'};
  const matching = configs.filter(c=>c.structure_match_value===source.preferences.member_class
    && c.is_active && c.effective_from <= AS_OF && (!c.effective_to || c.effective_to>=AS_OF));
  if (matching.length!==1) return {reason:'ambiguous_member_class_structure'};
  const evidence = invoices.filter(i=>i.status==='paid' && i.invoice_date >= '2026-01-01' && i.invoice_date<=AS_OF
    && (i.description===source.preferences.ym_membership_type || /1 year['’]s (?:full|trainee|associate|junior) membership/i.test(i.description || ''))
    && !/\(group\)/i.test(i.description || '')
    && !['VOIDED','DELETED'].includes(i.accounting_status)
    && (!i.accounting_payment_status || i.accounting_payment_status.toLowerCase()==='paid'));
  if (!evidence.length) return {reason:'no_unambiguous_imported_paid_membership_evidence'};
  const notes = {source:SOURCE,version:1,approval:'owner_authorised_same_condition_correction_2026_10_19',
    expiryAuthority:'retained_legacy_expiry',startDateAuthority:'unknown_not_inferred',
    paymentAuthority:'imported_paid_membership_invoice_not_provider_reverified',
    historicalInvoiceIds:evidence.map(i=>i.id).sort(),historicalAmountAuthority:'unknown_not_inferred',
    structureAuthority:'current_member_class_mapping_not_historical_purchase',
    sourceHash:hash({source,member,invoices,config:matching[0]}),futureCollectionConsent:false};
  return {record:{id:historyId(source.id),tenant_id:TENANT,member_id:source.id,
    membership_year:'2026/2027',tier_label:matching[0].name,field_value:source.preferences.member_class,
    config_id:null,term_start_date:null,term_end_date:expiry,status:'active',payment_status:'paid',
    payment_method:'upfront',billing_period:'annual',currency:'GBP',final_cost:null,total_with_vat:null,
    notes:JSON.stringify(notes)}};
}
