// Navigation only. This record is never payment or membership evidence.
const prefix = 'form-voucher-return:';
export function formVoucherConfirmationPath(token) {
  if (!/^[a-f0-9]{64}$/.test(token || '')) throw new Error('Invalid credit checkout token');
  return `/membership-fees/${token}`;
}
export function formVoucherReturnPath(value) {
  if (typeof value !== 'string' || /[\\\r\n]/.test(value) || !value.startsWith('/FormView?')) return null;
  try {
    const url = new URL(value, 'https://return.invalid');
    if (url.origin !== 'https://return.invalid' || url.pathname !== '/FormView'
        || !(url.searchParams.get('slug') || url.searchParams.get('id') || url.searchParams.get('formId'))) return null;
    return url.pathname + url.search + url.hash;
  } catch { return null; }
}
export function saveFormVoucherReturn(storage, token, path) {
  const safe = formVoucherReturnPath(path);
  if (!safe || !/^[a-f0-9]{64}$/.test(token || '')) return false;
  try { storage.setItem(prefix + token, safe); return true; } catch { return false; }
}
export function readFormVoucherReturn(storage, token) {
  if (!/^[a-f0-9]{64}$/.test(token || '')) return null;
  try { return formVoucherReturnPath(storage.getItem(prefix + token)); } catch { return null; }
}
