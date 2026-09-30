import { publicClient } from '../api/publicClient.js';

// A custom login page is optional. Only the page endpoint's explicit
// missing/unpublished response resolves to the built-in login; a tenant 404,
// network error, or server failure must retain the conservative error layout.
export async function getOptionalLoginPage() {
  try {
    return await publicClient.getPage('login');
  } catch (error) {
    if (
      error.status === 404
      && error.errorData?.error === 'Page not found or not published'
    ) {
      return null;
    }
    throw error;
  }
}