import { isAttestedExpiryOnlyHistory } from './expiryOnlyRenewalPolicy.js';
import { currentMembershipRecognition } from './alphaMembershipRecognition.js';
import { isDeletedRelationshipMember } from './customObjectMemberEligibility.js';

export const NMC_TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const NMC_FEATURE = 'membership.nmc-membership-report';
export const NMC_SHEETS = ['Full and Full Junior', 'Associate Honorary Retired', 'Trainee and LMIC', 'Online-only'];
export const NMC_ADDRESS_FIELDS = ['nmc_address_line_1', 'nmc_address_line_2', 'nmc_address_line_3', 'nmc_address_city', 'nmc_address_zip', 'nmc_address_country'];
export const NMC_FIELDS = ['member_class', 'membership_status', 'ym_date_membership_expires', 'title', ...NMC_ADDRESS_FIELDS];
export const NMC_HEADERS = ['Title', 'First name', 'Last name', 'Organisation', 'NMC address line 1', 'NMC address line 2', 'NMC address line 3', 'NMC address city', 'NMC address post/zip code', 'NMC address country', 'Email address', 'Phone number', 'Membership status', 'Number of months expired', 'Member Class', 'RBAC Role'];
const bases = ['Associate', 'Full', 'Full junior', 'Trainee', 'Student', 'Overseas Full', 'Overseas Full junior', 'Honorary', 'Retired', 'Former', 'Department contact', 'Patient representative', 'LMIC Full', 'LMIC Full junior', 'Overseas associate', 'CPD Guest'];
const text = value => value == null ? '' : String(value);
export function nmcDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value ? value : null;
}
export function completedMonths(expiry, today) {
  const a = new Date(`${expiry}T00:00:00Z`), b = new Date(`${today}T00:00:00Z`);
  const months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth();
  const anniversaryDay = Math.min(a.getUTCDate(), new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth() + 1, 0)).getUTCDate());
  return Math.max(0, months - (b.getUTCDate() < anniversaryDay ? 1 : 0));
}
export function nmcSheet(value, allowed) {
  if (typeof value !== 'string' || !allowed.has(value)) return null;
  const print = value.includes('NMC');
  const base = value.replace(/ with NMC$/, '');
  if (!bases.includes(base)) return null;
  if (!print) return NMC_SHEETS[3];
  if (['Full', 'Full junior', 'Overseas Full', 'Overseas Full junior'].includes(base)) return NMC_SHEETS[0];
  if (['Associate', 'Overseas associate', 'Honorary', 'Retired'].includes(base)) return NMC_SHEETS[1];
  if (['Trainee', 'Student', 'LMIC Full', 'LMIC Full junior'].includes(base)) return NMC_SHEETS[2];
  return null;
}

function membershipEvidence(history, agreements, recognitions, today) {
  if (!history.length) return { review: 'missing_membership_evidence' };
  const candidates = [];
  const unresolved = [];
  let tests = 0, future = 0;
  for (const record of history) {
    const start = nmcDate(record.term_start_date), expiry = nmcDate(record.term_end_date);
    if ((record.term_start_date != null && !start) || (record.term_end_date != null && !expiry)
      || (start && expiry && start > expiry)) {
      unresolved.push({ record, reason: 'invalid_expiry_or_term' }); continue;
    }
    if (start && start > today) { future++; continue; }
    const agreement = agreements.get(record.billing_agreement_id);
    if (record.billing_agreement_id && (!agreement || agreement.member_id !== record.member_id || agreement.organization_id)) {
      unresolved.push({ record, reason: 'ambiguous_membership_evidence' }); continue;
    }
    // Provider test commitments are never proof of genuine membership.
    if (agreement && agreement.environment !== 'live') { tests++; continue; }
    const at = expiry && expiry < today ? expiry : today;
    const observed = { ...record, membership_source: 'personal',
      status: record.status === 'expired' && expiry && expiry < today ? 'active' : record.status };
    const recognition = recognitions.filter(r => r.history_id === record.id)
      .filter(r => currentMembershipRecognition({ ...observed, membershipRecognition: r }, at));
    if (recognition.length > 1) {
      unresolved.push({ record, reason: 'ambiguous_membership_evidence' }); continue;
    }
    const legacy = isAttestedExpiryOnlyHistory(observed, NMC_TENANT);
    const paid = ['active', 'paid', 'expired'].includes(record.status) && record.payment_status === 'paid';
    const instalments = record.status === 'active' && record.payment_status === 'partial'
      && agreement?.environment === 'live' && agreement.status === 'active';
    if (expiry && (legacy || (start && (paid || instalments || recognition.length === 1)))) {
      candidates.push({ record, start, expiry }); continue;
    }
    unresolved.push({ record, reason: !expiry ? 'missing_expiry' : 'unproven_membership_evidence' });
  }
  // A successor which has commenced must not revive a superseded old term
  // just because the successor is unpaid, cancelled or malformed.
  const superseded = (candidate, other) => other.id !== candidate.record.id
    && (!nmcDate(other.term_start_date) || other.term_start_date <= today)
    && (other.previous_term_id === candidate.record.id
      || (nmcDate(other.term_start_date) && other.term_start_date > (candidate.start || candidate.expiry)));
  const retained = candidates.filter(c => !history.some(h => superseded(c, h)));
  const current = retained.filter(c => c.expiry >= today);
  if (current.length > 1) return { review: 'ambiguous_membership_evidence' };
  const chosen = current[0] || retained.sort((a, b) => b.expiry.localeCompare(a.expiry))[0];
  if (chosen) {
    if (unresolved.some(u => !nmcDate(u.record.term_start_date)
      || superseded(chosen, u.record))) return { review: 'ambiguous_membership_evidence' };
    const days = (Date.parse(today) - Date.parse(chosen.expiry)) / 86400000;
    if (days > 90) return { excluded: 'expired_over_90_days' };
    return { status: days > 0 ? 'Expired' : 'Active', months: completedMonths(chosen.expiry, today) };
  }
  if (unresolved.length) return { review: unresolved[0].reason };
  return { excluded: tests && tests + future === history.length ? 'test_membership_only' : 'future_membership_only' };
}

/** Read-only projection. No login, role, DD history or pricing is membership authority. */
export function projectNmcReport({ members, fields, preferences, history, organizations, roles = [], agreements = [], recognitions = [], reportDate }) {
  if (!nmcDate(reportDate)) throw new Error('Invalid report date');
  const fieldMap = new Map();
  for (const name of NMC_FIELDS) {
    const matches = fields.filter(f => f.tenant_id === NMC_TENANT && f.entity_scope === 'member' && f.is_active === true && f.name === name);
    if (matches.length !== 1) throw new Error('Required report field is missing or ambiguous');
    fieldMap.set(name, matches[0]);
  }
  const options = fieldMap.get('member_class').options;
  if (!Array.isArray(options) || !options.length) throw new Error('Class definitions unavailable');
  const allowed = new Set(options.map(o => typeof o === 'string' ? o : o.value));
  const classLabels = new Map(options.map(o => typeof o === 'string' ? [o, o] : [o.value, text(o.label || o.value)]));
  const roleNames = new Map(roles.filter(r => r.tenant_id === NMC_TENANT).map(r => [r.id, text(r.name)]));
  const prefs = new Map(), histories = new Map();
  for (const p of preferences) {
    const key = `${p.member_id}|${p.field_id}`;
    if (!prefs.has(key)) prefs.set(key, []);
    prefs.get(key).push(p.value);
  }
  for (const h of history.filter(h => h.tenant_id === NMC_TENANT && !h.organization_id)) {
    if (!histories.has(h.member_id)) histories.set(h.member_id, []);
    histories.get(h.member_id).push(h);
  }
  const orgs = new Map(organizations.filter(o => o.tenant_id === NMC_TENANT).map(o => [o.id, o]));
  const agreementMap = new Map(agreements.filter(a => a.tenant_id === NMC_TENANT).map(a => [a.id, a]));
  const rows = [], reviewCounts = {}, excludedCounts = {}, seen = new Set();
  const count = (target, key) => { target[key] = (target[key] || 0) + 1; };
  for (const member of members) {
    if (member.tenant_id !== NMC_TENANT || seen.has(member.id)) throw new Error('Member scope or uniqueness mismatch');
    seen.add(member.id);
    if (isDeletedRelationshipMember(member) || member.status === 'deleted' || member.deleted_at || member.anonymized_at) {
      count(excludedCounts, 'deleted'); continue;
    }
    if (member.is_sample || member.is_test) { count(excludedCounts, 'test_record'); continue; }
    if (member.is_guest) { count(excludedCounts, 'nonmember_contact'); continue; }
    const values = name => prefs.get(`${member.id}|${fieldMap.get(name).id}`) || [];
    if (NMC_FIELDS.some(name => values(name).length > 1)) { count(reviewCounts, 'duplicate_custom_values'); continue; }
    const value = name => text(values(name)[0]);
    const klass = value('member_class'), sheet = nmcSheet(klass, allowed);
    if (!sheet) { count(reviewCounts, klass ? 'unknown_class' : 'missing_class'); continue; }
    const records = histories.get(member.id) || [];
    if (['Department contact', 'CPD Guest'].includes(klass) && !records.length) {
      count(excludedCounts, 'nonmember_contact'); continue;
    }
    const honorary = klass === 'Honorary' && value('membership_status') === 'Active'
      && !value('ym_date_membership_expires').trim() && !records.length;
    const evidence = honorary ? { status: 'Active', months: 0 }
      : membershipEvidence(records, agreementMap, recognitions, reportDate);
    if (evidence.review) {
      const reason = !records.length && ['Initial enquiry', 'Full application received'].includes(value('membership_status'))
        ? 'applicant_only' : evidence.review;
      count(reason === 'applicant_only' ? excludedCounts : reviewCounts, reason); continue;
    }
    if (evidence.excluded) { count(excludedCounts, evidence.excluded); continue; }
    if (member.organization_id && !orgs.has(member.organization_id)) {
      count(reviewCounts, 'unresolved_organisation'); continue;
    }
    rows.push({ memberId: member.id, sheet, cells: [
      value('title'), text(member.first_name), text(member.last_name),
      text(orgs.get(member.organization_id)?.name), ...NMC_ADDRESS_FIELDS.map(value),
      text(member.email), text(member.mobile || member.landline), evidence.status, evidence.months,
      classLabels.get(klass) || klass,
      member.role_id ? (roleNames.get(member.role_id) || 'Role unavailable') : 'No role assigned',
    ] });
  }
  rows.sort((a, b) => a.cells[2].localeCompare(b.cells[2], 'en-GB')
    || a.cells[1].localeCompare(b.cells[1], 'en-GB') || a.memberId.localeCompare(b.memberId));
  return { reportDate, sheets: NMC_SHEETS.map(name => ({ name, count: rows.filter(r => r.sheet === name).length })),
    total: rows.length, reviewCounts, excludedCounts, rows };
}
