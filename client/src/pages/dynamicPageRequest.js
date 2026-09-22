// Only a genuine miss may advance to the protected-page/pretty-form lookup.
// Network and server failures must not turn into misleading "not found" pages.
export async function readPublicPage(request) {
  try {
    return { data: (await request()) || null };
  } catch (error) {
    // A tenant/prefix 404 is not evidence that a page is missing in the
    // authenticated tenant. Only the public page endpoint's page-miss
    // contract may advance to the protected page lookup.
    if (error?.status === 404
      && error?.errorData?.error === 'Page not found or not published') {
      return { data: null };
    }
    throw error;
  }
}

export const DYNAMIC_PAGE_PENDING_TIMEOUT_MS = 20_000;