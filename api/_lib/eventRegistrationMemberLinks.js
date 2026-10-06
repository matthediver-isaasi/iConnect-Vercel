// Checkout contact links preserve payer/guest history rather than rewriting
// bookings. Use explicit attendee participation, never an email/name guess.
export async function registrationMemberLinks(db, tenantId, registrations) {
  const links = new Map();
  for (let offset = 0; offset < registrations.length; offset += 100) {
    const batch = registrations.slice(offset, offset + 100);
    const allowed = new Set(batch.map(r => `${r.isComplex ? 'complex' : 'simple'}:${r.id}`));
    const purchases = [];
    for (let start = 0; ;) {
      const page = await db.from('public_ticket_member_purchase')
        .select('id,event_kind').eq('tenant_id', tenantId).eq('state', 'completed')
        .overlaps('booking_ids', batch.map(r => r.id)).order('id').range(start, start + 199);
      if (page.error) throw new Error('Unable to verify existing member links.');
      if (!page.data?.length) break;
      purchases.push(...page.data); start += page.data.length;
    }
    for (let i = 0; i < purchases.length; i += 100) {
      const portion = purchases.slice(i, i + 100);
      const kinds = new Map(portion.map(p => [p.id, p.event_kind]));
      for (let start = 0; ;) {
        const page = await db.from('public_ticket_member_link')
          .select('purchase_id,member_id,participation').in('purchase_id', portion.map(p => p.id))
          .order('purchase_id').order('normalized_email').range(start, start + 199);
        if (page.error) throw new Error('Unable to verify existing member links.');
        if (!page.data?.length) break;
        for (const row of page.data) {
          for (const item of Array.isArray(row.participation) ? row.participation : []) {
            const key = `${kinds.get(row.purchase_id)}:${item.booking_id}`;
            if (item.kind === 'attendee' && allowed.has(key) && row.member_id) links.set(key, row.member_id);
          }
        }
        start += page.data.length;
      }
    }
  }
  return links;
}
