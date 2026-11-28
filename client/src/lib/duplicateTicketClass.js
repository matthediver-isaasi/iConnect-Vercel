// Copy a ticket's settings into a new, unsaved ticket. The copy never inherits
// the original's identity (saved record id, editor-only state) or its
// "default ticket" flag, so saving creates a separate ticket.
export function duplicateTicketName(name, existingNames = []) {
  const base = String(name || '').trim() || 'Ticket';
  const taken = new Set(existingNames.map(value => String(value || '').trim().toLowerCase()));
  let candidate = `${base} (copy)`;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base} (copy ${n})`;
  return candidate;
}

export function duplicateTicketClass(ticket, { idKey, newId, existingTickets = [] }) {
  if (!ticket || !idKey || !newId) throw new Error('Ticket duplication needs a ticket and a new id');
  const copy = structuredClone(ticket);
  for (const key of Object.keys(copy)) {
    if (key.startsWith('_') || key === 'id') delete copy[key];
  }
  copy[idKey] = newId;
  copy.is_default = false;
  copy.name = duplicateTicketName(ticket.name, existingTickets.map(t => t?.name));
  return copy;
}

// Insert the copy straight after its original.
export function insertDuplicateTicket(tickets, sourceId, idKey, copy) {
  const index = tickets.findIndex(t => t[idKey] === sourceId);
  if (index < 0) return [...tickets, copy];
  return [...tickets.slice(0, index + 1), copy, ...tickets.slice(index + 1)];
}
