import { normalizeInternalReturnTo } from './safeReturnTo.js';

export function normalizeMemberLanding(value) {
  if (typeof value !== 'string' || !value.trim()) return '/Preferences';
  const name = value.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(name)) return '/Preferences';
  const path = name.startsWith('/') ? name : `/${name.replace(/ /g, '-')}`;
  return normalizeInternalReturnTo(path, '/Preferences');
}
