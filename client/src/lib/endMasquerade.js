import { normalizeInternalReturnTo } from '../../../shared/safeReturnTo.js';

export async function returnToAdmin({
  queryClient, fetchImpl = fetch, storage = localStorage,
  navigate = href => { window.location.href = href; },
}) {
  const response = await fetchImpl('/api/auth/end-masquerade', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success !== true) {
    throw new Error(data.error || 'Unable to return to admin. Please try again.');
  }
  // Once the server has changed identity, cache cleanup must not strand the
  // browser on the previous persona, even if storage is unavailable.
  try {
    await queryClient.cancelQueries();
  } finally {
    try {
      queryClient.clear();
      storage.removeItem('agcas_member');
      storage.removeItem('agcas_organization');
    } finally {
      navigate(normalizeInternalReturnTo(data.returnUrl, '/members'));
    }
  }
}
