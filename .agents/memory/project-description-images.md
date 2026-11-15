---
name: Project description image persistence
description: Compatibility and privacy boundaries for images pasted into task descriptions.
---
Keep existing descriptions as plain text and resolve embedded image references only against the current task's attachments, rather than treating pasted HTML or arbitrary URLs as trusted image content.

**Why:** Description images were requested as parity with activity pasting, not a rich-text migration. Reusing task attachments preserves existing upload permissions and avoids storing expiring signed URLs as permanent description content.

**How to apply:** Any future rich-text migration must preserve existing plain descriptions and image references. Removing a reference from the description must not implicitly delete the attachment, which an activity may also reference.
