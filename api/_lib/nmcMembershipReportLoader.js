import { NMC_FIELDS, NMC_TENANT, projectNmcReport } from './nmcMembershipReport.js';
import { MEMBERSHIP_RECOGNITION_TABLES } from './alphaMembershipRecognition.js';

// Keyset pagination handles even a provider cap below the requested page size.
// Exact counts and unique IDs detect incomplete reads rather than exporting them.
export async function nmcReadAll(build, key = 'id') {
  const rows = [], seen = new Set();
  let after = null, total = null;
  for (;;) {
    let query = build().order(key, { ascending: true }).limit(500);
    if (after !== null) query = query.gt(key, after);
    const { data, error, count } = await query;
    if (error || !Array.isArray(data) || !Number.isInteger(count)) throw new Error('Report data could not be loaded completely');
    if (total === null) total = count;
    // count with gt is remaining rows, not the original total.
    if (rows.length + count !== total) throw new Error('Report data changed during loading; retry');
    if (!data.length) {
      if (rows.length !== total) throw new Error('Report pagination incomplete');
      return rows;
    }
    for (const row of data) {
      if (!row[key] || seen.has(row[key])) throw new Error('Report pagination ambiguous');
      seen.add(row[key]); rows.push(row);
    }
    after = data.at(-1)[key];
  }
}

export async function loadNmcReport(db, reportDate) {
  const read = (table, columns = '*', configure = q => q, key = 'id') =>
    nmcReadAll(() => configure(db.from(table).select(columns, { count: 'exact' }).eq('tenant_id', NMC_TENANT)), key);
  const [members, fields, history, organizations, agreements, ...recognitionSets] = await Promise.all([
    read('member', 'id,tenant_id,first_name,last_name,email,mobile,landline,organization_id,status,is_sample,is_guest'),
    read('preference_field', 'id,tenant_id,name,entity_scope,is_active,options', q => q.in('name', NMC_FIELDS).eq('entity_scope', 'member').eq('is_active', true)),
    read('member_membership_history'),
    read('organization', 'id,tenant_id,name'),
    read('membership_billing_agreements', 'id,tenant_id,member_id,organization_id,environment,status,provider'),
    ...MEMBERSHIP_RECOGNITION_TABLES.map(table => read(table, '*', q => q, 'history_id')),
  ]);
  const preferences = [], fieldIds = fields.map(f => f.id);
  for (let index = 0; index < members.length && fieldIds.length; index += 100) {
    const memberIds = members.slice(index, index + 100).map(m => m.id);
    const values = await nmcReadAll(() => db.from('member_preference_value')
      .select('id,member_id,field_id,value', { count: 'exact' }).in('member_id', memberIds).in('field_id', fieldIds));
    if (values.some(v => !memberIds.includes(v.member_id) || !fieldIds.includes(v.field_id))) throw new Error('Preference ownership mismatch');
    preferences.push(...values);
  }
  return projectNmcReport({ members, fields, preferences, history, organizations, agreements,
    recognitions: recognitionSets.flat(), reportDate });
}
