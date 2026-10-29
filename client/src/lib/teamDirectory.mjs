import { format, isValid, parseISO } from 'date-fns';

export const TEAM_COLUMNS = [
  { key: 'first_name', label: 'First name', type: 'text' },
  { key: 'last_name', label: 'Last name', type: 'text' },
  { key: 'email', label: 'Email', type: 'text' },
  { key: 'created_on', label: 'Date joined', type: 'date' },
  { key: 'role', label: 'Role', type: 'text' },
  { key: 'last_activity', label: 'Last activity', type: 'date' },
];

function timestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = parseISO(value);
  return isValid(date) ? date.getTime() : null;
}

export function formatTeamDate(value) {
  const time = timestamp(value);
  return time === null ? '—' : format(new Date(time), 'd MMM yyyy');
}

export function activityState(member) {
  // A missing projection is not proof of no activity.
  if (!Object.hasOwn(member, 'last_activity')) return 'unknown';
  if (member.last_activity === null) return 'never';
  return timestamp(member.last_activity) === null ? 'unknown' : 'recorded';
}

export function sortTeamMembers(members, roles, key, direction) {
  const roleNames = new Map(roles.map(role => [role.id, role.name]));
  const isDate = TEAM_COLUMNS.find(column => column.key === key)?.type === 'date';
  const value = member => {
    const raw = key === 'role' ? roleNames.get(member.role_id) : member[key];
    return isDate ? timestamp(raw) : (typeof raw === 'string' && raw.trim() ? raw.trim().toLocaleLowerCase('en') : null);
  };
  const compare = (a, b) => typeof a === 'number' ? a - b : a.localeCompare(b, 'en');
  return [...members].sort((a, b) => {
    const av = value(a), bv = value(b);
    const order = av === null ? (bv === null ? 0 : 1)
      : bv === null ? -1 : compare(av, bv) * (direction === 'desc' ? -1 : 1);
    return order || String(a.id).localeCompare(String(b.id), 'en');
  });
}

export function paginateTeamMembers(members, requestedPage, pageSize) {
  const size = pageSize === 'all' ? Math.max(1, members.length) : Number(pageSize);
  if (![9, 25, 50, 100].includes(size) && pageSize !== 'all') throw new Error('Invalid team page size');
  const totalPages = Math.max(1, Math.ceil(members.length / size));
  const page = Math.max(1, Math.min(totalPages, requestedPage));
  const offset = (page - 1) * size;
  return {
    members: members.slice(offset, offset + size), page, totalPages,
    start: members.length ? offset + 1 : 0,
    end: Math.min(offset + size, members.length), total: members.length,
  };
}

// The authorised Member endpoint selects the persisted member row, including
// created_on (original creation, NOT role_effective_from) and last_activity.
// Exact counts avoid mistaking a provider's shorter row cap for completion.
export async function loadTeamMembers(entity, organizationId, signal) {
  if (!organizationId) return [];
  const members = [], seen = new Set();
  let expectedCount;
  do {
    const response = await entity.list({
      filter: { organization_id: organizationId },
      sort: { id: 'asc' }, limit: 1000, offset: members.length,
      queryParams: { count: 'exact' }, signal,
    });
    if (!Array.isArray(response?.data) || !Number.isInteger(response.count) || response.count < 0) {
      throw new Error('Unable to verify the complete team response');
    }
    if (expectedCount !== undefined && response.count !== expectedCount) {
      throw new Error('The team changed while loading. Please retry.');
    }
    expectedCount = response.count;
    for (const member of response.data) {
      if (!member?.id || seen.has(member.id) || member.organization_id !== organizationId
        || !Object.hasOwn(member, 'last_activity')) {
        throw new Error('Incomplete or inconsistent team response. Please retry.');
      }
      seen.add(member.id);
      members.push(member);
    }
    if (members.length > expectedCount || (!response.data.length && members.length < expectedCount)) {
      throw new Error('Unable to load the complete team. Please retry.');
    }
  } while (members.length < expectedCount);
  return members;
}
