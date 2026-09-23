const MAILBOX_RE = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i;

export function normalizeMemberEmailAddress(value) {
  if (typeof value !== 'string') throw new Error('Email address must be a string');
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid email address');
  const address = value.trim();
  const at = address.lastIndexOf('@');
  const local = at > 0 ? address.slice(0, at) : '';
  if (
    !address
    || address.length > 254
    || local.length > 64
    || local.startsWith('.')
    || local.endsWith('.')
    || local.includes('..')
    || !MAILBOX_RE.test(address)
  ) {
    throw new Error('Invalid email address');
  }
  return address;
}

export function parseMemberEmailCc(value) {
  if (value == null || value === '') return [];
  if (typeof value !== 'string') throw new Error('CC must be a comma or semicolon separated string');
  if (/[\r\n]/.test(value)) throw new Error('CC contains an invalid email address');
  if (!value.trim()) return [];
  const parts = value.split(/[;,]/);
  if (parts.some(part => !part.trim())) throw new Error('CC contains an empty email address');
  return parts.map(part => {
    try {
      return normalizeMemberEmailAddress(part);
    } catch {
      throw new Error('CC contains an invalid email address');
    }
  });
}