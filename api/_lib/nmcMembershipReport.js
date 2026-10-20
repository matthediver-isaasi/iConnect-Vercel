import { isAttestedExpiryOnlyHistory } from './expiryOnlyRenewalPolicy.js';
import { isBnmsExpiryGapEvidence } from './bnmsExpiryGapEvidence.js';
import { isBnmsUnexpiredAttestation } from './bnmsUnexpiredAttestation.js';
import { isBnmsCorrectedExpiryAttestation } from './bnmsCorrectedExpiryAttestation.js';
import { isBnmsIndividualHistoricalAttestation } from './bnmsIndividualHistoricalAttestation.js';
import { isBnmsHistoricalEntitlement } from './bnmsHistoricalEntitlement.js';
import { currentMembershipRecognition } from './alphaMembershipRecognition.js';
import { isDeletedRelationshipMember } from './customObjectMemberEligibility.js';
import { defaultNmcJournalSettings, nmcClassOptions } from './nmcJournalSettings.js';

// BNMS (bnms.org.uk); this report and its staff exclusion are tenant-specific.
export const NMC_TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const NMC_FEATURE = 'membership.nmc-membership-report';
export const NMC_SHEETS = ['Full and Full Junior', 'Online-only'];
export const NMC_ADDRESS_FIELDS = ['nmc_address_line_1', 'nmc_address_line_2', 'nmc_address_line_3', 'nmc_address_city', 'nmc_address_zip', 'nmc_address_country'];
export const NMC_FIELDS = ['member_class', 'membership_status', 'ym_date_membership_expires', 'title', ...NMC_ADDRESS_FIELDS, 'nmc_customer_number'];
export const NMC_HEADERS = ['Title', 'First name', 'Last name', 'Organisation', 'NMC address line 1', 'NMC address line 2', 'NMC address line 3', 'NMC address city', 'NMC address post/zip code', 'NMC address country', 'Email address', 'Phone number', 'Membership status', 'Number of months expired', 'Member Class', 'RBAC Role', 'NMC Customer Number'];
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
export function nmcSheet(value, allowed, settings = defaultNmcJournalSettings([...allowed].map(v => ({ value: v, label: v })))) {
  if (typeof value !== 'string' || !allowed.has(value)) return null;
  if (settings.printedClasses.includes(value)) return NMC_SHEETS[0];
  if (settings.onlineClasses.includes(value)) return NMC_SHEETS[1];
  return null;
}

function awaitingFirstPayment(history, agreements, plans, today) {
  // Only a new, unambiguous term qualifies. Never disguise historical
  // uncertainty or a renewal of an earlier term as healthy initial setup.
  if (history.length !== 1) return false;
  const h = history[0], a = agreements.get(h.billing_agreement_id);
  const start = nmcDate(h.term_start_date), end = nmcDate(h.term_end_date);
  if (!start || !end || start > end || end < today || h.previous_term_id
    || h.status !== 'pending_payment_setup' || h.payment_status !== 'unpaid'
    || !a || a.member_id !== h.member_id || a.organization_id
    || a.environment !== 'live' || a.status !== 'first_payment_pending') return false;
  const snapshot = a.provider === 'stripe' ? a.metadata?.card
    : a.provider === 'gocardless' ? a.metadata?.dd : null;
  if (snapshot?.activation_rule !== 'first_payment') return false;
  const linked = plans.filter(p => p.billing_agreement_id === a.id);
  if (linked.length !== 1) return false;
  const p = linked[0];
  return p.member_id === h.member_id && !p.organization_id
    && p.environment === 'live' && p.provider === a.provider
    && p.status === 'first_payment_pending' && p.interval_unit === 'monthly'
    && p.instalments_paid === 0 && Number.isInteger(p.instalments_total) && p.instalments_total > 0
    && Number.isInteger(p.amount_minor) && p.amount_minor > 0
    && p.membership_year === h.membership_year && !!h.membership_year
    && [null, undefined, 'pending_submission', 'submitted'].includes(p.last_payment_status)
    // GoCardless timestamps every mirrored event, including submission.
    // A timestamp without a known pre-confirmation status remains uncertain.
    && (!p.last_payment_at || ['pending_submission', 'submitted'].includes(p.last_payment_status))
    && [a, p].every(row => row.needs_attention === false && !row.attention_reason)
    && !p.grace_expires_at && !p.arrears_policy_applied && !p.arrears_policy_applied_at
    && (p.retry_count == null || p.retry_count === 0)
    && (p.auto_retry_attempts == null || p.auto_retry_attempts === 0);
}
function firstCollectionDiagnostic(history, agreements, plans, today) {
  // Diagnostic only: these states never establish paid journal entitlement.
  if (history.length !== 1) return null;
  const h = history[0], a = agreements.get(h.billing_agreement_id);
  const start = nmcDate(h.term_start_date), end = nmcDate(h.term_end_date);
  if (!start || !end || start > today || start > end || end < today || h.previous_term_id
    || h.payment_status !== 'unpaid' || !a || a.member_id !== h.member_id || a.organization_id
    || a.environment !== 'live' || a.provider !== 'gocardless'
    || !['mandate_pending', 'first_payment_pending'].includes(a.status)) return null;
  const rule = a.metadata?.dd?.activation_rule;
  if (!['mandate', 'first_payment'].includes(rule)
    || !(h.status === 'pending_payment_setup' || (h.status === 'active' && rule === 'mandate'))) return null;
  const linked = plans.filter(p => p.billing_agreement_id === a.id);
  if (!linked.length && a.status === 'mandate_pending' && h.status === 'pending_payment_setup'
    && a.needs_attention === false && !a.attention_reason) return { pending: 'awaiting_mandate_setup' };
  if (linked.length !== 1) return null;
  const p = linked[0];
  if (p.member_id !== h.member_id || p.organization_id || p.environment !== 'live' || p.provider !== a.provider
    || p.interval_unit !== 'monthly' || p.instalments_paid !== 0
    || !Number.isInteger(p.instalments_total) || p.instalments_total <= 0
    || !Number.isInteger(p.amount_minor) || p.amount_minor <= 0
    || !h.membership_year || p.membership_year !== h.membership_year) return null;
  if (p.last_payment_status === 'failed' && ['first_payment_pending', 'mandate_pending', 'payment_grace_period'].includes(p.status)) {
    return { review: 'first_collection_failed' };
  }
  if (![a, p].every(row => row.needs_attention === false && !row.attention_reason)
    || p.grace_expires_at || p.arrears_policy_applied || p.arrears_policy_applied_at
    || (p.retry_count != null && p.retry_count !== 0)
    || (p.auto_retry_attempts != null && p.auto_retry_attempts !== 0)
    || !['first_payment_pending', 'mandate_pending'].includes(p.status)) return null;
  if (p.last_payment_status === 'submitted') return { pending: 'first_collection_submitted' };
  if (p.last_payment_status === 'pending_submission') return { pending: 'awaiting_first_payment' };
  if (p.last_payment_status == null && !p.last_payment_at && a.status === 'mandate_pending'
    && p.status === 'mandate_pending') return { pending: 'awaiting_mandate_setup' };
  return null;
}

function membershipEvidence(history, agreements, plans, recognitions, today) {
  if (!history.length) return { review: 'missing_membership_evidence' };
  const candidates = [];
  const unresolved = [];
  let tests = 0, future = 0;
  for (const record of history) {
    if (record.payment_status === 'unverified') continue;
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
    const legacy = isAttestedExpiryOnlyHistory(observed, NMC_TENANT) || isBnmsExpiryGapEvidence(observed)
      || isBnmsUnexpiredAttestation(observed) || isBnmsCorrectedExpiryAttestation(observed)
      || isBnmsIndividualHistoricalAttestation(observed) || isBnmsHistoricalEntitlement(observed);
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
  const diagnostic = firstCollectionDiagnostic(history, agreements, plans, today);
  if (diagnostic) return diagnostic;
  if (awaitingFirstPayment(history, agreements, plans, today)) return { pending: plans.find(p => p.billing_agreement_id === history[0].billing_agreement_id)?.last_payment_status === 'submitted'
    ? 'first_collection_submitted' : 'awaiting_first_payment' };
  if (unresolved.length) return { review: unresolved[0].reason };
  return { excluded: tests && tests + future === history.length ? 'test_membership_only' : 'future_membership_only' };
}

/** Read-only projection. No login, role, DD history or pricing is membership authority. */
export function projectNmcReport({ members, fields, preferences, history, organizations, roles = [], agreements = [], plans = [], recognitions = [], reportDate, settings: savedSettings = null }) {
  if (!nmcDate(reportDate)) throw new Error('Invalid report date');
  const fieldMap = new Map();
  for (const name of NMC_FIELDS) {
    const matches = fields.filter(f => f.tenant_id === NMC_TENANT && f.entity_scope === 'member' && f.is_active === true && f.name === name);
    if (matches.length !== 1) throw new Error('Required report field is missing or ambiguous');
    fieldMap.set(name, matches[0]);
  }
  const options = fieldMap.get('member_class').options;
  const classOptions = nmcClassOptions(options);
  const settings = savedSettings || defaultNmcJournalSettings(classOptions);
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
  const primaryOrganizations = [...orgs.values()].filter(o => o.is_primary === true);
  if (primaryOrganizations.length !== 1) throw new Error('Primary report organisation is missing or ambiguous');
  const primaryOrganizationId = primaryOrganizations[0].id;
  const agreementMap = new Map(agreements.filter(a => a.tenant_id === NMC_TENANT).map(a => [a.id, a]));
  const scopedPlans = plans.filter(p => p.tenant_id === NMC_TENANT);
  const rows = [], excludedCounts = {}, seen = new Set();
  const diagnostics = { review: {}, pending: {} };
  const count = (target, key) => { target[key] = (target[key] || 0) + 1; };
  for (const member of members) {
    if (member.tenant_id !== NMC_TENANT || seen.has(member.id)) throw new Error('Member scope or uniqueness mismatch');
    seen.add(member.id);
    // Owner-approved staff exclusion applies to EVERY count, including exclusions
    // and review reasons. Email domains and organisation names are not authority.
    if (member.organization_id === primaryOrganizationId) continue;
    if (isDeletedRelationshipMember(member) || member.status === 'deleted' || member.deleted_at || member.anonymized_at) {
      count(excludedCounts, 'deleted'); continue;
    }
    if (member.is_sample || member.is_test) { count(excludedCounts, 'test_record'); continue; }
    if (member.is_guest) { count(excludedCounts, 'nonmember_contact'); continue; }
    const values = name => prefs.get(`${member.id}|${fieldMap.get(name).id}`) || [];
    // Capture identity at the classification branch, never re-evaluate eligibility
    // in a separate list query. Counts below are derived from these exact lists.
    const diagnose = (group, reason) => {
      const classes = values('member_class');
      const displayText = value => typeof value === 'string' && value.trim() ? value.trim() : null;
      (diagnostics[group][reason] ||= []).push({
        memberId: member.id,
        firstName: displayText(member.first_name),
        lastName: displayText(member.last_name),
        email: displayText(member.email),
        memberClass: classes.length === 1 && allowed.has(classes[0]) ? classLabels.get(classes[0]) : null,
      });
    };
    if (NMC_FIELDS.some(name => values(name).length > 1)) { diagnose('review', 'duplicate_custom_values'); continue; }
    const value = name => text(values(name)[0]);
    const klass = value('member_class'), sheet = nmcSheet(klass, allowed, settings);
    if (!allowed.has(klass)) { diagnose('review', klass ? 'unknown_class' : 'missing_class'); continue; }
    if (!sheet) { count(excludedCounts, 'class_not_selected_for_journal'); continue; }
    const records = histories.get(member.id) || [];
    if (['Department contact', 'CPD Guest'].includes(klass) && !records.length) {
      count(excludedCounts, 'nonmember_contact'); continue;
    }
    const honorary = klass === 'Honorary' && value('membership_status') === 'Active'
      && !value('ym_date_membership_expires').trim() && !records.length;
    const evidence = honorary ? { status: 'Active', months: 0 }
      : membershipEvidence(records, agreementMap, scopedPlans, recognitions, reportDate);
    if (evidence.pending) {
      if (member.organization_id && !orgs.has(member.organization_id)) diagnose('review', 'unresolved_organisation');
      else diagnose('pending', evidence.pending);
      continue;
    }
    if (evidence.review) {
      const reason = !records.length && ['Initial enquiry', 'Full application received'].includes(value('membership_status'))
        ? 'applicant_only' : evidence.review;
      if (reason === 'applicant_only') count(excludedCounts, reason);
      else diagnose('review', reason);
      continue;
    }
    if (evidence.excluded) { count(excludedCounts, evidence.excluded); continue; }
    if (member.organization_id && !orgs.has(member.organization_id)) {
      diagnose('review', 'unresolved_organisation'); continue;
    }
    rows.push({ memberId: member.id, memberClass: klass, sheet, cells: [
      value('title'), text(member.first_name), text(member.last_name),
      text(orgs.get(member.organization_id)?.name), ...NMC_ADDRESS_FIELDS.map(value),
      text(member.email), text(member.mobile || member.landline), evidence.status, evidence.months,
      classLabels.get(klass) || klass,
      member.role_id ? (roleNames.get(member.role_id) || 'Role unavailable') : 'No role assigned',
      value('nmc_customer_number'),
    ] });
  }
  rows.sort((a, b) => a.cells[2].localeCompare(b.cells[2], 'en-GB')
    || a.cells[1].localeCompare(b.cells[1], 'en-GB') || a.memberId.localeCompare(b.memberId));
  for (const group of Object.values(diagnostics)) {
    for (const members of Object.values(group)) members.sort((a, b) =>
      (a.lastName || '').localeCompare(b.lastName || '', 'en-GB')
      || (a.firstName || '').localeCompare(b.firstName || '', 'en-GB')
      || a.memberId.localeCompare(b.memberId));
  }
  const diagnosticCounts = group => Object.fromEntries(Object.entries(group).map(([reason, members]) => [reason, members.length]));
  const reviewCounts = diagnosticCounts(diagnostics.review), pendingCounts = diagnosticCounts(diagnostics.pending);
  const classCounts = Object.fromEntries([['printed', 'printedClasses', NMC_SHEETS[0]], ['online', 'onlineClasses', NMC_SHEETS[1]]]
    .map(([group, key, sheet]) => [group, settings[key].map(value => ({
      value, label: classLabels.get(value) || value, count: rows.filter(r => r.sheet === sheet && r.memberClass === value).length,
    }))]));
  return { reportDate, settings, classOptions, classCounts, sheets: NMC_SHEETS.map(name => ({ name, count: rows.filter(r => r.sheet === name).length })),
    total: rows.length, reviewCounts, excludedCounts, pendingCounts, diagnostics, rows };
}
