// Default-off writes remain compatible before the approved migration rollout.
// Enabling requires the complete schema, not merely the policy columns.
export async function gatePublicTicketMemberPolicy(entity, body, db) {
  const name = String(entity || '').replace(/[-_]/g, '').toLowerCase();
  if (!['event', 'complexeventticketclass'].includes(name)) return body;
  const records = Array.isArray(body) ? body : [body];
  const tickets = records.flatMap(record => name === 'event'
    ? record?.pricing_config?.ticket_classes || [] : [record]);
  if (!tickets.some(ticket => ticket && ('create_member_records' in ticket || 'new_member_role_id' in ticket))) return body;
  const readiness = db ? await db.rpc('public_ticket_member_creation_ready') : { error: { code: 'PGRST202' } };
  if (readiness.data === true && !readiness.error) return body;
  if (readiness.error && !['42883', 'PGRST202'].includes(readiness.error.code)) {
    const error = new Error('Unable to verify ticket member creation readiness. Please retry saving.');
    error.status = 503;
    throw error;
  }
  const sanitizeTicket = ticket => {
    if (!ticket || typeof ticket !== 'object') return ticket;
    if (ticket.create_member_records === true) {
      const error = new Error('Member creation upon ticket purchase is not available yet. The approved ticket member migrations must be applied before enabling it.');
      error.status = 409;
      throw error;
    }
    const copy = { ...ticket };
    delete copy.create_member_records;
    delete copy.new_member_role_id;
    return copy;
  };
  const sanitizeRecord = record => {
    if (!record || typeof record !== 'object') return record;
    if (name === 'complexeventticketclass') return sanitizeTicket(record);
    if (!Array.isArray(record.pricing_config?.ticket_classes)) return record;
    return {
      ...record,
      pricing_config: {
        ...record.pricing_config,
        ticket_classes: record.pricing_config.ticket_classes.map(sanitizeTicket),
      },
    };
  };
  return Array.isArray(body) ? body.map(sanitizeRecord) : sanitizeRecord(body);
}
