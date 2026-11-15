---
name: Project board responsiveness
description: User-confirmed expectations for card saves, uploads and cover feedback.
---
Show saved changes when the completion indicator finishes, without requiring a further visible wait for the board or modal to reload.

**Why:** The user confirmed the card-creation improvement worked and requested the same response for attachment uploads and cover changes. They can tolerate the saving spinner, but not an additional delay after completion.

**How to apply:** Keep the board and open card detail consistent after confirmed writes, while preserving error feedback and any unsaved edits. Do not trade reliable persistence for the appearance of success.

Offer both existing image attachments and cover-only uploads in the cover picker.
Cover-only uploads must not appear in the attachment list.

**Why:** The user explicitly requested uploading a cover independently of task attachments while retaining both options.

**How to apply:** Preserve the distinction when changing upload, cover-selection, or attachment-list behaviour.

Removing an Activity image preview or cancelling a comment is not permission
to delete a confirmed task attachment.

**Why:** Activity images can share task files. The approved scope requires safe
cancellation without deleting shared attachments; local draft removal and
storage deletion must remain separate user intentions.

**How to apply:** Retain confirmed files when discarding a draft, explain that
retention in the composer, and reserve remote deletion for an authorized,
explicit attachment action. Clean up unconfirmed uploads separately.
