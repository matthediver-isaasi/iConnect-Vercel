import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { INVOICING_ADDRESS_KEYS as keys, invoicingAddressError } from '../../shared/invoicingAddress.js';

export { keys };
export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const COMPANY = '3d57dce6-2205-462f-abf6-9c7cbf00be23';
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const normalize = value => typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ').toLowerCase() : '';
export const email = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
export const pick = row => Object.fromEntries(keys.map(k => [k, row?.[k] ?? null]));
export const blank = row => keys.every(k => row?.[k] == null || (typeof row[k] === 'string' && !row[k].trim()));
export function excluded(member, roleId, secondary = []) {
  return member.role_id === roleId || secondary.some(r => r.member_id === member.id && r.role_id === roleId);
}
export function mapAddress(contact) {
  const addresses = contact?.Addresses;
  if (!Array.isArray(addresses)) return { reason: 'Missing Xero invoice address' };
  const boxes = addresses.filter(a => a.AddressType === 'POBOX');
  if (!boxes.length) return { reason: 'Missing Xero invoice address' };
  if (boxes.length !== 1) return { reason: 'Multiple POBOX addresses', review: true, source: boxes };
  const source = boxes[0];
  // AddressID identifies the provider address record; it is not address text.
  // Retain it in raw evidence, but it needs no destination address component.
  const supported = new Set(['AddressID','AddressType','AddressLine1','AddressLine2','City','Region','PostalCode','Country']);
  const unsupported = Object.keys(source).filter(k => !supported.has(k) && source[k] != null && source[k] !== '');
  if (unsupported.length) return { source, review: true, reason: `Unsupported source components: ${unsupported.join(', ')}` };
  const sourceKeys = ['AddressLine1','AddressLine2','City','Region','PostalCode','Country'];
  if (sourceKeys.some(k => source[k] != null && typeof source[k] !== 'string')) {
    return { source, review: true, reason: 'Non-text source component' };
  }
  // Preserve exact source text, including internal and outer whitespace.
  const address = Object.fromEntries(keys.map((k,i) => [k, source[sourceKeys[i]] ?? null]));
  if (!address[keys[0]]?.trim()) return { source, reason: 'Missing Xero invoice address first line' };
  const error = invoicingAddressError(address);
  if (error) return { source, review: true, reason: error };
  return { source, address };
}
export function planAudit(snapshot, discovery) {
  assert.equal(snapshot.tenant.id, TENANT);
  assert.equal(snapshot.total, snapshot.members.length);
  assert.equal(new Set(snapshot.members.map(m => m.id)).size, snapshot.total);
  const targets = new Map(snapshot.addresses.filter(a => a.owner_type === 'member').map(a => [a.owner_id,a]));
  const contacts = new Map(discovery.contacts.map(c => [c.ContactID,c]));
  assert.equal(contacts.size, discovery.contacts.length);
  const sharedEmails = new Map();
  for (const m of snapshot.members) if (email(m.email)) sharedEmails.set(email(m.email), (sharedEmails.get(email(m.email)) || 0) + 1);
  const bindings = new Map();
  const bindingErrors = new Set();
  for (const r of snapshot.links) {
    if (!bindings.has(r.member_id)) bindings.set(r.member_id,new Set());
    if (r.tenant_id !== TENANT || r.xero_tenant_id !== COMPANY || !r.xero_contact_id ||
      r.evidence?.contact?.ContactID !== r.xero_contact_id || r.evidence?.invoice?.Contact?.ContactID !== r.xero_contact_id) {
      bindingErrors.add(r.member_id);
    } else bindings.get(r.member_id).add(r.xero_contact_id);
  }
  const owners = new Map();
  for (const [id, ids] of bindings) for (const cid of ids) {
    if (!owners.has(cid)) owners.set(cid,new Set());
    owners.get(cid).add(id);
  }
  const rows = snapshot.members.filter(m => !excluded(m,snapshot.guestRole.id,snapshot.secondary)).map(member => {
    const before = pick(targets.get(member.id));
    const row = { member, before, after: before, outcome: 'lookup error/incomplete', comparison: 'not compared',
      basis: '', reason: '', candidates: [], contact: null, candidate: false, differences: [] };
    const finish = (outcome, reason) => Object.assign(row,{outcome,reason});
    if (!discovery.complete) return finish('lookup error/incomplete', discovery.error || 'Contact discovery incomplete');
    const ids = bindings.get(member.id) || new Set();
    if (member.xero_contact_id) {
      if (member.xero_tenant_id !== COMPANY) return finish('ambiguous','Unbound or inconsistent legacy company link');
      ids.add(member.xero_contact_id);
    }
    const exact = discovery.contacts.filter(c => email(member.email) && email(c.EmailAddress) === email(member.email));
    row.candidates = [...new Set([...ids,...exact.map(c => c.ContactID)])];
    if (bindingErrors.has(member.id) || ids.size > 1 || row.candidates.length > 1) return finish('ambiguous','Conflicting or multiple contact identities');
    if (email(member.email) && sharedEmails.get(email(member.email)) > 1) return finish('ambiguous','Email shared by multiple BNMS members (including excluded members)');
    const id = row.candidates[0];
    if (!id) return finish('no contact','Complete contact scan: no verified binding or exact normalized email match');
    row.contact = contacts.get(id) || null;
    row.basis = ids.has(id) ? 'verified tenant/member/company binding' : 'unique exact normalized email';
    if (!row.contact) return finish('ambiguous','Bound contact absent from completed company scan');
    if (owners.get(id)?.size > 1 || snapshot.members.some(m => m.id !== member.id && email(m.email) && email(m.email) === email(row.contact.EmailAddress))) {
      return finish('ambiguous','Contact identity shared with another BNMS member');
    }
    if (row.contact.ContactStatus !== 'ACTIVE') return finish('ambiguous',`Contact is ${row.contact.ContactStatus || 'unknown status'}`);
    if (row.contact.HasErrors || row.contact.HasValidationErrors || row.contact.ValidationErrors?.length) return finish('lookup error/incomplete','Provider contact validation errors');
    const mapped = mapAddress(row.contact);
    row.source = mapped.source ?? null;
    if (!mapped.address) return finish(mapped.review ? 'ambiguous' : 'missing Xero invoice address',mapped.reason);
    row.proposed = mapped.address;
    row.differences = keys.filter(k => normalize(before[k]) !== normalize(mapped.address[k]));
    row.comparison = row.differences.length ? 'different' : 'same';
    if (!blank(before)) {
      if (keys.some(k => !normalize(before[k]))) return finish('partial iConnect address','Existing address has blank components; protected from overwrite');
      return finish(row.comparison, 'Existing address protected from overwrite');
    }
    if (member.tenant_id !== TENANT) return finish('ambiguous','Inherited tenant ownership is not write authority');
    row.candidate = true;
    return finish('different','Wholly blank target; verified lossless POBOX mapping is eligible for empty-only copy');
  });
  // A contact can never be a write source for two separate member owners.
  const selected = new Map();
  for (const r of rows) if (r.contact) selected.set(r.contact.ContactID,(selected.get(r.contact.ContactID)||0)+1);
  for (const r of rows) if (r.contact && selected.get(r.contact.ContactID)>1) Object.assign(r,{
    outcome:'ambiguous',reason:'Contact selected for multiple members',candidate:false,
  });
  return rows;
}

export async function scanContacts(get, maxPages = 200) {
  const contacts = [], seen = new Set(), pages = [];
  try {
  for (let page=1;page<=maxPages;page++) {
    const body = await get(`Contacts?includeArchived=true&page=${page}&pageSize=100&order=ContactID`);
    assert.ok(Array.isArray(body?.Contacts) && body.Contacts.length<=100,'Malformed contact page');
    pages.push({page,count:body.Contacts.length,hash:hash(body.Contacts)});
    for (const contact of body.Contacts) {
      assert.ok(contact.ContactID && !seen.has(contact.ContactID),'Repeated contact or pagination drift');
      seen.add(contact.ContactID); contacts.push(contact);
    }
    // Demand an empty terminal page, even when the prior page was short.
    if (!body.Contacts.length) return {contacts,pages,complete:true,completedAt:new Date().toISOString()};
  }
  throw Error('Contact scan reached its page bound without completion');
  } catch (error) {
    return {contacts,pages,complete:false,error:error.message,stoppedAt:new Date().toISOString()};
  }
}
