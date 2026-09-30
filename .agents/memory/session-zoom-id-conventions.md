---
name: Complex-event session Zoom ID conventions
description: External vs local Zoom IDs and why saved-session Zoom changes must go through change-zoom
---

- `complex_event_session.zoom_meeting_id/zoom_webinar_id` store the EXTERNAL numeric Zoom ID (string). The single `event` table uses the OPPOSITE convention (local zoom_* table PK).
- The session change-zoom endpoint (`/api/complex-event-sessions/:id/change-zoom`) takes LOCAL zoom_meeting/zoom_webinar row PKs; resolve external→local via `/api/zoom/meetings|webinars` before calling it.
- The complex-event save loop strips all Zoom columns from the bypass PATCH for existing sessions (task-692 decision) so registrants are re-routed safely. **Why:** direct PATCHes would swap the Zoom link without cancelling/re-registering confirmed attendees.
- **How to apply:** any UI that lets an admin change a saved session's Zoom link must call change-zoom (see `client/src/lib/sessionZoomLink.js`), never rely on the session PATCH. New (unsaved) sessions may pass the external ID directly in the POST payload. Bulk-save paths should send `resendConfirmations: false` to avoid silent mass emails.
