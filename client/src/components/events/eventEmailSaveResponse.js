export async function readEventEmailSaveResponse(response) {
  try {
    return await response.json();
  } catch {
    // Hosting timeouts can return plain text/HTML instead of the API's JSON.
    // Do not expose that body or imply the database write was rolled back.
    if ([502, 503, 504].includes(response.status)) {
      throw new Error('The server did not finish responding. Your email changes may already have been saved. Reload the event and check before saving again.');
    }
    throw new Error(`The server returned an unreadable response (HTTP ${response.status}). Your email changes may already have been saved. Reload the event and check before saving again.`);
  }
}
