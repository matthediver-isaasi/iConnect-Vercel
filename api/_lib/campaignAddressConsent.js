const normalize = value => String(value || '').trim().toLowerCase();
const literal = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// An external audience row is not authority to ignore a tenant member sharing
// its address. This checks consent only; it never creates inbox membership.
export async function campaignAddressConsent(db, tenantId, addresses, categoryId) {
  const emails = [...new Set(addresses.map(normalize).filter(Boolean))];
  const global = new Set(), category = new Set();
  for (let start = 0; start < emails.length; start += 20) {
    const { data: members, error } = await db.from('member')
      .select('id,email,login_enabled,communications_opted_out_all')
      .eq('tenant_id', tenantId)
      .filter('email', 'imatch', `^\\s*(${emails.slice(start, start + 20).map(literal).join('|')})\\s*$`)
      .limit(201);
    if (error || !Array.isArray(members) || members.length >= 201) {
      throw new Error('Address-level member consent could not be verified');
    }
    const subscribed = new Set();
    if (categoryId) for (let offset = 0; offset < members.length; offset += 100) {
      const { data, error } = await db.from('member_communication_preference').select('member_id')
        .eq('tenant_id', tenantId).eq('category_id', categoryId).eq('is_subscribed', true)
        .in('member_id', members.slice(offset, offset + 100).map(m => m.id)).limit(101);
      if (error || !Array.isArray(data) || data.length >= 101) throw new Error('Address-level category consent could not be verified');
      data.forEach(row => subscribed.add(row.member_id));
    }
    for (const member of members) {
      const email = normalize(member.email);
      if (member.communications_opted_out_all === true) global.add(email);
      if (categoryId && (member.login_enabled === false || !subscribed.has(member.id))) category.add(email);
    }
  }
  return { global, category };
}
