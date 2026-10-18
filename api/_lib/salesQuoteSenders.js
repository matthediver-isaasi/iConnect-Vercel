import { SalesHttpError } from './salesAccess.js';
import { quoteSenderHeaders } from './emailService.js';

export async function quoteSenderOptions(db, quote, actor) {
  const { data: opportunity, error } = await db.from('opportunity')
    .select('owner_kind,owner_id').eq('tenant_id', actor.tenantId)
    .eq('id', quote.opportunity_id).maybeSingle();
  if (error) throw error;
  if (!opportunity) throw new SalesHttpError(404, 'Opportunity not found');
  const principals = [{ kind: opportunity.owner_kind, id: opportunity.owner_id }];
  for (let offset = 0; ; offset += 100) {
    const { data, error: readError } = await db.from('opportunity_collaborator')
      .select('id,principal_kind,principal_id').eq('tenant_id', actor.tenantId)
      .eq('opportunity_id', quote.opportunity_id).order('id').range(offset, offset + 99);
    if (readError) throw readError;
    principals.push(...(data || []).map(row => ({ kind: row.principal_kind, id: row.principal_id })));
    if (data.length < 100) break;
  }
  const { data: org, error: orgError } = await db.from('organization').select('id')
    .eq('tenant_id', actor.tenantId).eq('is_primary', true).maybeSingle();
  if (orgError) throw orgError;
  const items = [];
  const seen = new Set();
  for (const principal of principals) {
    const key = `${principal.kind}:${principal.id}`;
    if (!['member', 'tenant_user'].includes(principal.kind) || !principal.id || seen.has(key)) continue;
    seen.add(key);
    let query = db.from(principal.kind).select('id,first_name,last_name,email')
      .eq('tenant_id', actor.tenantId).eq('id', principal.id);
    if (principal.kind === 'member') {
      if (!org) continue;
      query = query.eq('organization_id', org.id);
    }
    const { data: person, error: personError } = await query.maybeSingle();
    if (personError) throw personError;
    if (!person || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(person.email || '')
      || /@deleted\.local$/i.test(person.email)) continue;
    items.push({ ...principal, key, email: person.email,
      name: [person.first_name, person.last_name].filter(Boolean).join(' ') || person.email });
  }
  const ownKey = `${actor.actorType}:${actor.actorId}`;
  return { items, defaultSenderKey: items.some(item => item.key === ownKey) ? ownKey : null };
}

export async function resolveQuoteSender(db, quote, actor, key, dependencies = {}) {
  const options = await quoteSenderOptions(db, quote, actor);
  const sender = options.items.find(item => item.key === (key === undefined ? options.defaultSenderKey : key));
  if (!sender) throw new SalesHttpError(400, 'Select a current opportunity owner or collaborator with a valid email');
  return { ...sender, ...await quoteSenderHeaders(actor.tenantId, sender, dependencies) };
}
