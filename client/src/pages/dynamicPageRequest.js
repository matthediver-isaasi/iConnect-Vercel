// Only a genuine miss may advance to the protected-page/pretty-form lookup.
// Network and server failures must not turn into misleading "not found" pages.
export async function readPublicPage(request) {
  try {
    return { data: (await request()) || null };
  } catch (error) {
    if (error?.status === 404) return { data: null };
    throw error;
  }
}

export const DYNAMIC_PAGE_PENDING_TIMEOUT_MS = 20_000;